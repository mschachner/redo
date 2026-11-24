/**
 * The redo multiplayer server: one shared world for everyone who connects.
 *
 * It serves the built game (the `dist` folder) over HTTP and talks to players over a
 * WebSocket at /ws. The world is its seed plus the cells players have changed; the server
 * checks every change against its own copy (each cell must still hold what the change
 * expects) before making it and passing it on. Positions, chat and broadcasts are relayed.
 *
 * The server also runs what everyone shares: the monsters (it moves them, spawns them in
 * the dark near players, settles attacks and tells players when they're touched) and the
 * clock (which runs while anyone is online). Resting at the campfire puts a player to
 * sleep; morning comes at midnight, or as soon as everyone online is asleep.
 *
 * Each player's own state (position, health, inventory) is kept by name between visits.
 * Logging out unloads a player's stack: everything on it is undone, as if they had pressed
 * undo until it was empty. The world, the clock and those states are saved to a JSON file every so often
 * and on shutdown.
 *
 * Settings, from the environment:
 *   PORT      port to listen on (default 8787)
 *   DATA      the world file (default ./data/world.json)
 *   STATIC    the built game to serve (default ./dist)
 *   SEED      the seed for a new world (default: three random words)
 *   PASSWORD  if set, players need it to join
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { Block, BLOCKS, isSolid } from "../src/blocks";
import { BEDTIME, DAY_SECONDS, LAMP, START_HOUR, sunLevel } from "../src/clock";
import { LightField } from "../src/light";
import { readLook } from "../src/looks";
import { swingStrength } from "../src/stack";
import { attackArea, MONSTER_KINDS, Population, SPAWN_RANGE_X, SPAWN_RANGE_Y, spawnCap, spawnInterval } from "../src/population";
import { MAX_NAME, MAX_TEXT } from "../src/protocol";
import type { Change, ClientMessage, Facing, MonsterInfo, PlayerInfo, PlayerState, ServerMessage } from "../src/protocol";
import { normalizeSeed, randomSeedName } from "../src/seeds";
import { World, WORLD_H } from "../src/world";

const PORT = Number(process.env.PORT ?? 8787);
const DATA = resolve(process.env.DATA ?? "data/world.json");
const STATIC = resolve(process.env.STATIC ?? "dist");
const PASSWORD = process.env.PASSWORD ?? "";
const SAVE_EVERY = 30_000; // ms
const POSITIONS_EVERY = 66; // ms
const CLOCK_EVERY = 1000; // ms
const TICK = 1 / 60; // seconds per simulation step
/** After a monster's touch, how long a player can't be touched again (ms). */
const INVULNERABLE_MS = 1000;
/** The least time between one player's attacks (ms). */
const ATTACK_GAP_MS = 200;
/** Monsters are reported to players within this many cells. */
const MONSTER_VIEW = 90;
/** Most cells one request may change (a break can flood up to 500 cells). */
const MAX_CHANGES = 600;

// ── The world ──────────────────────────────────────────────────────────

/**
 * On disk: the seed, each changed cell's block by name (so saves survive reordering), the
 * signs, the clock, and each player's state by name.
 */
interface WorldFile {
  seed: string;
  cells: [number, number, string][];
  signs: [number, number, string][];
  hour?: number;
  day?: number;
  players?: Record<string, PlayerState>;
}

/** The clock, and what each player left behind, by lowercased name. */
let hour = START_HOUR;
let day = 0;
const states = new Map<string, PlayerState>();

function loadWorld(): World {
  if (existsSync(DATA)) {
    const file = JSON.parse(readFileSync(DATA, "utf8")) as WorldFile;
    const world = new World(file.seed);
    for (const [x, y, name] of file.cells) {
      const b = Block[name as keyof typeof Block];
      if (b !== undefined) world.set(x, y, b);
    }
    for (const [x, y, text] of file.signs) world.setSignText(x, y, text);
    hour = file.hour ?? START_HOUR;
    day = file.day ?? 0;
    for (const [name, state] of Object.entries(file.players ?? {})) states.set(name, state);
    console.log(`loaded ${file.seed} (${file.cells.length} changed cells) from ${DATA}`);
    return world;
  }
  const seed = normalizeSeed(process.env.SEED ?? "") ?? randomSeedName();
  console.log(`new world: ${seed}`);
  return new World(seed);
}

const world = loadWorld();
const population = new Population(world);
let dirty = true;

function saveWorld(): void {
  if (!dirty) return;
  const file: WorldFile = {
    seed: world.seedName,
    cells: world.editedCells().map(([x, y]) => [x, y, Block[world.get(x, y)]]),
    signs: world.signEntries(),
    hour,
    day,
    players: Object.fromEntries(states),
  };
  mkdirSync(dirname(DATA), { recursive: true });
  // Write to a temporary file first, so a crash mid-write can't corrupt the world.
  writeFileSync(DATA + ".tmp", JSON.stringify(file));
  renameSync(DATA + ".tmp", DATA);
  dirty = false;
}

setInterval(saveWorld, SAVE_EVERY);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    saveWorld();
    process.exit(0);
  });
}

const isBlock = (b: unknown): b is Block => Number.isInteger(b) && (b as number) >= 0 && (b as number) < BLOCKS.length;
const isCell = (x: unknown, y: unknown): boolean =>
  Number.isInteger(x) && Number.isInteger(y) && Math.abs(x as number) < 2 ** 29 && (y as number) >= 0 && (y as number) < WORLD_H;

/** Make changes if every cell still holds what they expect. Returns whether they were made. */
function applyChanges(changes: Change[]): boolean {
  for (const c of changes) if (world.get(c.x, c.y) !== c.from) return false;
  for (const c of changes) {
    world.set(c.x, c.y, c.to);
    if (c.to === Block.Sign) world.setSignText(c.x, c.y, String(c.text ?? "").slice(0, MAX_TEXT));
    else if (c.from === Block.Sign) world.setSignText(c.x, c.y, undefined);
  }
  // A block that appears where a monster is crushes it.
  population.crush();
  dirty = true;
  return true;
}

/** A request's changes, if well formed. */
function readChanges(raw: unknown): Change[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CHANGES) return undefined;
  const out: Change[] = [];
  for (const c of raw as Change[]) {
    if (!c || !isCell(c.x, c.y) || !isBlock(c.from) || !isBlock(c.to)) return undefined;
    // Nobody may put back or take away the campfire or bedrock.
    if (c.from === Block.Campfire || c.to === Block.Campfire || c.from === Block.Bedrock || c.to === Block.Bedrock) return undefined;
    out.push({ x: c.x, y: c.y, from: c.from, to: c.to, text: typeof c.text === "string" ? c.text : undefined });
  }
  return out;
}

// ── Players ────────────────────────────────────────────────────────────

interface Player extends PlayerInfo {
  socket: WebSocket;
  /** Their name lowercased: the key for their kept state. */
  key: string;
  /** Asleep at the campfire, waiting for morning. */
  asleep: boolean;
  /** When a monster may next touch them, and when they may next attack (ms). */
  touchableAt: number;
  attackAt: number;
  /** Seconds until monsters next try to appear near them. */
  spawnTimer: number;
}

const players = new Map<number, Player>();
let nextId = 1;

const send = (socket: WebSocket, message: ServerMessage): void => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};
const sendAll = (message: ServerMessage, except?: number): void => {
  const data = JSON.stringify(message);
  for (const p of players.values()) if (p.id !== except && p.socket.readyState === WebSocket.OPEN) p.socket.send(data);
};
const info = (p: Player): PlayerInfo => ({ id: p.id, name: p.name, x: p.x, y: p.y, facing: p.facing, look: p.look });
const FACINGS: Facing[] = ["up", "down", "left", "right"];

function welcome(socket: WebSocket, rawName: unknown, password: unknown, look: unknown): Player | undefined {
  if (PASSWORD && password !== PASSWORD) {
    send(socket, { t: "refused", reason: "wrong password" });
    return undefined;
  }
  const name = String(rawName ?? "").trim().slice(0, MAX_NAME);
  if (!name) {
    send(socket, { t: "refused", reason: "name needed" });
    return undefined;
  }
  if ([...players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    send(socket, { t: "refused", reason: "name in use" });
    return undefined;
  }
  const key = name.toLowerCase();
  const kept = states.get(key);
  const player: Player = {
    id: nextId++,
    name,
    key,
    x: kept?.x ?? world.spawnX,
    y: kept?.y ?? world.spawnY,
    facing: kept?.facing ?? "right",
    look: readLook(look),
    socket,
    asleep: false,
    touchableAt: Date.now() + INVULNERABLE_MS,
    attackAt: 0,
    spawnTimer: 2,
  };
  const cells: number[] = [];
  for (const [x, y] of world.editedCells()) cells.push(x, y, world.get(x, y));
  send(socket, {
    t: "welcome",
    id: player.id,
    seed: world.seedName,
    cells,
    signs: world.signEntries(),
    players: [...players.values()].map(info),
    you: kept ?? null,
    hour,
    day,
  });
  players.set(player.id, player);
  sendClock();
  sendAll({ t: "joined", player: info(player) }, player.id);
  console.log(`${name} joined (${players.size} online)`);
  return player;
}

function handle(player: Player, m: ClientMessage): void {
  switch (m.t) {
    case "move":
      if (Number.isFinite(m.x) && Number.isFinite(m.y)) {
        player.x = m.x;
        player.y = m.y;
      }
      if (FACINGS.includes(m.facing)) player.facing = m.facing;
      break;
    case "request": {
      const changes = readChanges(m.changes);
      const ok = changes !== undefined && applyChanges(changes);
      send(player.socket, { t: "reply", id: m.id, ok });
      if (ok) sendAll({ t: "changes", by: player.id, changes: changes! }, player.id);
      break;
    }
    case "say":
      sendAll({ t: "said", id: player.id, text: String(m.text).slice(0, MAX_TEXT) }, player.id);
      break;
    case "broadcast":
      sendAll({ t: "broadcast", name: player.name, text: String(m.text).slice(0, MAX_TEXT) }, player.id);
      break;
    case "attack": {
      const now = Date.now();
      if (now < player.attackAt || !FACINGS.includes(m.facing) || player.asleep) break;
      player.attackAt = now + ATTACK_GAP_MS;
      // One point of damage per empty stack slot, as of the stack the player last sent.
      const kept = states.get(player.key);
      const damage = kept ? swingStrength(kept.keptSlots, kept.daySlots, kept.undo.length) : 1;
      if (damage <= 0) break;
      const { events, kills } = population.hit(attackArea(player.x, player.y, m.facing), player.x, player.y, damage);
      send(player.socket, { t: "hits", events, kills });
      break;
    }
    case "rest":
      if (hour < BEDTIME || player.asleep) break;
      player.asleep = true;
      sendClock();
      if (everyoneAsleep()) morning();
      break;
    case "state":
      if (m.state && typeof m.state === "object") {
        states.set(player.key, m.state);
        dirty = true;
      }
      break;
  }
}

/** Whether a 1×1 player at (x, y) overlaps cell (cx, cy). */
const overlaps = (x: number, y: number, cx: number, cy: number): boolean =>
  x < cx + 1 - 1e-6 && x + 1 > cx + 1e-6 && y < cy + 1 - 1e-6 && y + 1 > cy + 1e-6;

/**
 * Unload a player's stack as they log out: undo each action on it, most recent first, and
 * drop the redo stack. An action that can't be undone any more stays as it is: its cells
 * have changed since, a block would come back where someone is standing, or the blocks it
 * would take back aren't in the inventory. Returns the changes made, for everyone else.
 */
function unload(state: PlayerState): Change[] {
  const counts = new Map(state.inventory);
  const made: Change[] = [];
  for (let i = state.undo.length - 1; i >= 0; i--) {
    const a = state.undo[i];
    const changes = readChanges(
      (a.cells ?? []).map(([x, y, before, after, beforeText]) => ({ x, y, from: after, to: before, text: beforeText ?? undefined })),
    );
    if (!changes) continue;
    if (changes.some((c) => isSolid(c.to) && [...players.values()].some((p) => overlaps(p.x, p.y, c.x, c.y)))) continue;
    if ((a.inventory ?? []).some(([b, n]) => (counts.get(b) ?? 0) - n < 0)) continue;
    if (!applyChanges(changes)) continue;
    for (const [b, n] of a.inventory ?? []) counts.set(b, (counts.get(b) ?? 0) - n);
    made.push(...changes);
  }
  // Counts change in place, so the inventory keeps its order; blocks taken back go last.
  const order = state.inventory.map(([b]) => b);
  for (const b of counts.keys()) if (!order.includes(b)) order.push(b);
  state.inventory = order.map((b) => [b, counts.get(b) ?? 0]);
  if (state.selected !== null && (counts.get(state.selected) ?? 0) <= 0) state.selected = null;
  state.undo = [];
  state.redo = [];
  dirty = true;
  return made;
}

// ── The clock ──────────────────────────────────────────────────────────

const everyoneAsleep = (): boolean => players.size > 0 && [...players.values()].every((p) => p.asleep);

function sendClock(): void {
  const asleep = [...players.values()].filter((p) => p.asleep).length;
  sendAll({ t: "clock", hour, day, asleep, online: players.size });
}

/** Morning: everyone wakes (or falls asleep where they stand, and wakes), and the monsters are gone. */
function morning(): void {
  day++;
  hour = START_HOUR;
  for (const p of players.values()) p.asleep = false;
  population.monsters.length = 0;
  sendAll({ t: "morning", hour, day });
  sendClock();
  dirty = true;
  console.log(`morning of day ${day}`);
}

setInterval(() => {
  if (players.size) sendClock();
}, CLOCK_EVERY);

// ── Monsters ───────────────────────────────────────────────────────────

/** Light around a player, for finding dark places for monsters to appear. */
const spawnLight = new LightField();

let lastTick = performance.now();
let behind = 0;
setInterval(() => {
  const now = performance.now();
  behind = Math.min(behind + (now - lastTick) / 1000, 0.25);
  lastTick = now;
  while (behind >= TICK) {
    behind -= TICK;
    step(TICK);
  }
}, 1000 / 60);

/** One step of the shared world: the clock, the monsters, and their touches. */
function step(dt: number): void {
  if (!players.size) return; // nobody here: time stands still
  hour += (dt * 24) / DAY_SECONDS;
  if (hour >= 24) morning();

  const awake = [...players.values()].filter((p) => !p.asleep);
  population.step(dt, awake);
  const now = Date.now();
  for (const p of awake) {
    if (now >= p.touchableAt) {
      const m = population.touching(p.x, p.y);
      if (m) {
        p.touchableAt = now + INVULNERABLE_MS;
        send(p.socket, { t: "hurt", damage: m.damage, fromX: m.x + 0.5, cause: `Hurt by ${m.def.name}` });
      }
    }
    // More monsters, more often, out in the wilds.
    p.spawnTimer -= dt;
    if (p.spawnTimer <= 0) {
      p.spawnTimer = spawnInterval(p.x);
      if (population.near(p.x, p.y) < spawnCap(p.x)) {
        const px = Math.round(p.x);
        const py = Math.round(p.y);
        spawnLight.update(world, px - SPAWN_RANGE_X - 2, py - SPAWN_RANGE_Y - 2, 2 * SPAWN_RANGE_X + 5, 2 * SPAWN_RANGE_Y + 5, sunLevel(hour), px, py, LAMP);
        population.trySpawn(spawnLight, p.x, p.y);
      }
    }
  }
}

// Each player hears about the monsters near them.
setInterval(() => {
  for (const p of players.values()) {
    const list: MonsterInfo[] = [];
    for (const m of population.monsters) {
      if (Math.abs(m.x - p.x) > MONSTER_VIEW || Math.abs(m.y - p.y) > MONSTER_VIEW) continue;
      list.push([m.id, MONSTER_KINDS.indexOf(m.kind), Math.round(m.x * 100) / 100, Math.round(m.y * 100) / 100, m.hurt > 0 ? 1 : 0, m.winding ? 1 : 0, Math.round(m.wild * 100) / 100]);
    }
    send(p.socket, { t: "monsters", list });
  }
}, POSITIONS_EVERY);

// Everyone's position, a few times a second.
setInterval(() => {
  if (players.size < 2) return;
  sendAll({ t: "positions", players: [...players.values()].map((p) => [p.id, p.x, p.y, p.facing]) });
}, POSITIONS_EVERY);

// ── HTTP and WebSocket ─────────────────────────────────────────────────

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const http = createServer((req, res) => {
  if (req.url === "/info") {
    // Pages hosted elsewhere (the copy on mark-schachner.com) ask this too.
    res
      .writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" })
      .end(JSON.stringify({ password: !!PASSWORD }));
    return;
  }
  const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
  let file = join(STATIC, path);
  if (!file.startsWith(STATIC)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("The game hasn't been built: run npm run build.");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

const sockets = new WebSocketServer({ server: http, path: "/ws", maxPayload: 256 * 1024 });
sockets.on("connection", (socket) => {
  let player: Player | undefined;
  socket.on("message", (data) => {
    let m: ClientMessage;
    try {
      m = JSON.parse(String(data)) as ClientMessage;
    } catch {
      return;
    }
    if (!player) {
      if (m.t === "hello") player = welcome(socket, m.name, m.password, m.look);
      return;
    }
    handle(player, m);
  });
  socket.on("close", () => {
    if (!player) return;
    players.delete(player.id);
    sendAll({ t: "left", id: player.id });
    const state = states.get(player.key);
    if (state?.undo?.length) {
      const changes = unload(state);
      if (changes.length) sendAll({ t: "changes", by: player.id, changes });
    } else if (state?.redo?.length) {
      state.redo = [];
      dirty = true;
    }
    sendClock();
    if (everyoneAsleep()) morning();
    console.log(`${player.name} left (${players.size} online)`);
  });
});

http.listen(PORT, () => console.log(`redo server on port ${PORT}, world ${world.seedName}`));
