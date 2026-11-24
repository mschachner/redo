import { Block, BLOCKS, isLiquid, isSolid } from "./blocks";
import { Action, CellChange, History } from "./history";
import type { Change } from "./protocol";
import { Input } from "./input";
import type { LightField } from "./light";
import { DEFAULT_LOOK, type Look } from "./looks";
import { boxesOverlap, Monster } from "./monsters";
import { attackArea, HIT_KNOCKBACK, MONSTER_KINDS, Population, spawnCap, spawnInterval } from "./population";
import { BEDTIME, DAY_SECONDS, SLEEPY_HOUR, START_HOUR } from "./clock";
import { Fog } from "./fog";
import { flood } from "./water";
import { World, WORLD_H } from "./world";

export type { Change };

/**
 * A world shared with other players. Changes to it go through the server, which makes
 * them only if every cell still holds what the change expects.
 */
export interface Shared {
  /**
   * Ask for changes. Resolves true once the server has made them; false if it refused, by
   * which time the server's current values for those cells are in the local world.
   */
  request(changes: Change[]): Promise<boolean>;
  say(text: string): void;
  broadcast(text: string): void;
  /** Attack whatever is in reach (the server says what was hit). */
  attack(facing: Dir): void;
  /** Go to sleep at the campfire, until the world's morning. */
  rest(): void;
}

/** Another player in a shared world, as last reported by the server. */
export interface Peer {
  id: number;
  name: string;
  x: number;
  y: number;
  facing: Dir;
  look: Look;
  /** Drawn position, easing toward (x, y) between reports. */
  drawX: number;
  drawY: number;
  speech: { text: string; t: number; total: number } | undefined;
}

// Units are cells and seconds. The player is a 1×1 box whose top-left corner is (x, y);
// y grows downward.
const RUN = 8.5;
const ACCEL_GROUND = 70;
const ACCEL_AIR = 45;
const GRAVITY = 62;
const MAX_FALL = 26;
const JUMP_SPEED = 17.5; // apex ≈ 2.5 cells
const JUMP_CUT = 0.45; // vertical speed kept when W is released mid-rise
const COYOTE = 0.08;
const JUMP_BUFFER = 0.12;
const SNAP_MIN_SPEED = 3;
const SLOT_ASSIST = 0.35; // cells
const SNAP_DECEL = 40;
const REPEAT_DELAY = 0.24;
const REPEAT_RATE = 0.12;
const FLASH_TIME = 0.35;
const EPS = 1e-6;
const PHYSICS_STEP = 1 / 120;
const SWIM_RUN = 0.6; // fraction of running speed
const SWIM_UP = 6.5;
const SINK_SPEED = 3.5;
const SURFACE_HOP = 12.5; // leaving the water at the surface: rises about 1.25 cells

export const MAX_HP = 5;
const INVULNERABLE_TIME = 1;
const ATTACK_COOLDOWN = 0.28;
export const SWING_TIME = 0.14;
const MAGMA_BOUNCE = 13;
/** How long a speech bubble stays up: a base, plus time per character (seconds). */
const SPEECH_BASE = 4;
const SPEECH_PER_CHAR = 0.06;
/** How long the whole inventory stays up after cycling through it (seconds). */
const INVENTORY_SHOW = 2;
/** Broadcasts: seconds between them, and how long the banner stays up (plus per char). */
export const BROADCAST_COOLDOWN = 60;
const BROADCAST_BASE = 6;
/** How far around the player (columns, rows) the open space is explored each move. */
const FOG_RANGE_X = 48;
const FOG_RANGE_Y = 34;

/**
 * The most actions the undo stack holds to begin with; pickups add to it. When it's full,
 * new actions (and attacks) are refused until something is undone. (A new action clears
 * the redo stack, so the two stacks together never hold more than the limit either.)
 */
export const BASE_STACK = 4;
/** How long the screen takes to fade back in after sleeping (seconds). */
export const REST_FADE = 1.2;
export type Dir = "up" | "down" | "left" | "right";

export interface Flash {
  x: number;
  y: number;
  t: number;
  ok: boolean;
}

export class Player {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  grounded = false;
  coyote = 0;
  jumpBuffer = 0;
  facing: Dir = "right";
  /** Position at the previous physics step, for interpolating between steps when drawing. */
  prevX = 0;
  prevY = 0;
  /** Visual offset that eases out after a sudden vertical shift (ledge step-up, slot assist). */
  stepEase = 0;
  hp = MAX_HP;
  /** Seconds left of invulnerability after taking a hit. */
  invulnerable = 0;
  /** Seconds left during which knockback overrides movement input. */
  stunned = 0;
}

/** The activity log's latest line; a repeat of the same text bumps `count`. */
export interface LogLine {
  text: string;
  count: number;
  /** Seconds since it was written or last repeated. */
  age: number;
}

/** A recent attack, drawn briefly as a slash in front of the player. */
export interface Swing {
  facing: Dir;
  t: number;
}

export class Inventory {
  readonly counts = new Map<Block, number>();
  /** Block types in the order they were first picked up. */
  readonly slots: Block[] = [];
  private selected: Block | undefined;

  count(b: Block): number {
    return this.counts.get(b) ?? 0;
  }

  add(b: Block, n: number): void {
    if (n > 0 && !this.slots.includes(b)) this.slots.push(b);
    this.counts.set(b, this.count(b) + n);
    if (n > 0 && this.selectedBlock() === undefined) this.selected = b;
  }

  /** The block types currently carried, in pickup order. */
  held(): Block[] {
    return this.slots.filter((b) => this.count(b) > 0);
  }

  /** The selected block type, if any of it is carried. */
  selectedBlock(): Block | undefined {
    return this.selected !== undefined && this.count(this.selected) > 0 ? this.selected : undefined;
  }

  /** Select the i-th carried type. */
  selectIndex(i: number): void {
    const held = this.held();
    if (i < held.length) this.selected = held[i];
  }

  /** Drop everything. */
  clear(): void {
    this.counts.clear();
    this.slots.length = 0;
    this.selected = undefined;
  }

  /** Select a block type directly (restoring a saved world). */
  select(b: Block | undefined): void {
    this.selected = b;
  }

  /** Move the selection forward or back through the carried types, wrapping around. */
  cycle(step: number): void {
    const held = this.held();
    if (!held.length) return;
    const i = this.selected === undefined ? -1 : held.indexOf(this.selected);
    this.selected = i < 0 ? held[step > 0 ? 0 : held.length - 1] : held[(i + step + held.length) % held.length];
  }
}

export class Game {
  readonly player = new Player();
  readonly inventory = new Inventory();
  readonly history = new History();
  readonly flashes: Flash[] = [];
  /** The monsters: run here when playing alone; copies of the server's in a shared world. */
  readonly population: Population;
  get monsters(): Monster[] {
    return this.population.monsters;
  }
  /** Hour of the in-game day, 0 ≤ hour < 24. */
  hour = START_HOUR;
  /** Days completed; the first day is day 0. */
  day = 0;
  /** Real seconds spent playing this world. */
  playTime = 0;
  /** The latest broadcast, while its banner is showing. */
  broadcastShown: { text: string; t: number; total: number } | undefined;
  /** Seconds until the player can broadcast again. */
  broadcastCooldown = 0;
  /** Seconds left to show the whole inventory, after cycling through it. */
  inventoryShown = 0;
  /** What the player last said, while its speech bubble is showing. */
  speech: { text: string; t: number; total: number } | undefined;
  /** The activity log; only the most recent line is kept. */
  log: LogLine | undefined;
  /** Which underground cells the player has discovered. */
  readonly fog: Fog;
  /** The renderer's light levels, which monster spawning consults. */
  light: LightField | undefined;
  swing: Swing | undefined;
  /** Movement lock: held Shift turns WASD into aiming only. */
  get locked(): boolean {
    return this.input.held.has("ShiftLeft") || this.input.held.has("ShiftRight");
  }
  /** Walking into a one-cell ledge climbs it automatically. */
  autoStep = true;
  /** The server, in a shared world; undefined when playing alone. */
  shared: Shared | undefined;
  /** The other players, in a shared world. */
  peers: Peer[] = [];
  /** How this player appears: chosen when joining a shared world, the default alone. */
  look: Look = DEFAULT_LOOK;
  /** While a change waits for the server, new actions are ignored. */
  private busy = false;
  /** While dying undoes the stack, other actions are ignored. */
  private rewinding = false;
  /** Pickups asked for and not yet confirmed, by cell. */
  private claiming = new Set<string>();
  /** Stack slots added by pickups: for good, and until the player next sleeps. */
  keptSlots = 0;
  daySlots = 0;
  /** How many actions the undo stack can hold now. */
  get stackLimit(): number {
    return BASE_STACK + this.keptSlots + this.daySlots;
  }
  /** Asleep at the campfire in a shared world, waiting for morning. */
  asleep = false;
  /** In a shared world: how many players are asleep, of how many online. */
  sleepers: [number, number] = [0, 0];
  /** Seconds left of the fade back in after resting. */
  restFade = 0;
  /** Set on resting, for whoever saves the game to notice and clear. */
  rested = false;

  private lastHorizontal = 0;
  private accumulator = 0;
  private repeatTimers = new Map<string, number>();
  private attackCooldown = 0;
  private spawnTimer = 1.5;

  constructor(readonly world: World, private input: Input) {
    this.fog = new Fog(world);
    this.population = new Population(world);
    this.spawn();
  }

  /** Put the player beside the campfire, at full health. */
  private spawn(): void {
    const p = this.player;
    p.x = p.prevX = this.world.spawnX;
    p.y = p.prevY = this.world.spawnY;
    p.vx = p.vy = 0;
    p.hp = MAX_HP;
    p.invulnerable = INVULNERABLE_TIME;
    p.stunned = 0;
    this.cameToFire = false;
  }

  /** Whether the player is at the campfire (in its cell or one next to it). */
  atCampfire(): boolean {
    const p = this.player;
    return Math.abs(Math.round(p.x) - this.world.fireX) <= 1 && Math.abs(Math.round(p.y) - this.world.fireY) <= 1;
  }

  /**
   * Whether the player has walked to the campfire, rather than just woken beside it: set
   * once they've been away from it since they last appeared there.
   */
  private cameToFire = false;

  /**
   * Whether to show the resting prompt: "rest & commit" whenever resting is allowed, but
   * "Lights at 21:00" only to a player who walked over, not one who just appeared there.
   */
  showRestPrompt(): boolean {
    return !this.asleep && this.atCampfire() && (this.canRest() || this.cameToFire);
  }

  /** Whether the campfire is burning: from bedtime until morning. */
  get campfireLit(): boolean {
    return this.hour >= BEDTIME || this.hour < START_HOUR;
  }

  /** Whether the player can rest now: at the campfire, at or after bedtime. */
  canRest(): boolean {
    return this.atCampfire() && this.hour >= BEDTIME;
  }

  /**
   * Rest at the campfire, from bedtime on: the player sleeps until morning and wakes beside
   * the fire at full health.
   */
  rest(): void {
    if (!this.canRest() || this.asleep) return;
    if (this.shared) {
      // In a shared world the clock is everyone's: heal and commit now, then sleep until
      // the server says it's morning.
      this.player.hp = MAX_HP;
      this.commitAll();
      this.asleep = true;
      this.note("Rested");
      this.rested = true;
      this.shared.rest();
      return;
    }
    this.day++;
    this.sleep();
    this.spawn(); // wake beside the fire, at full health
    this.note("Rested");
  }

  /** Commit every action: both stacks empty, and the day's extra slots gone. */
  private commitAll(): void {
    this.history.undoStack.length = 0;
    this.history.redoStack.length = 0;
    this.daySlots = 0;
  }

  /**
   * Morning in a shared world, at the server's word: a player who rested wakes beside the
   * fire; one still awake falls asleep where they are, which commits their changes.
   */
  morning(hour: number, day: number): void {
    this.hour = hour;
    this.day = day;
    if (this.asleep) {
      this.asleep = false;
      this.spawn();
    } else {
      this.commitAll();
      this.note("Fell asleep");
    }
    this.monsters.length = 0;
    this.restFade = REST_FADE;
    this.rested = true;
  }

  /** The shared world's clock, and how many of the players online are asleep. */
  syncClock(hour: number, day: number, asleep: number, online: number): void {
    this.hour = hour;
    this.day = day;
    this.sleepers = [asleep, online];
  }

  /**
   * Sleep until morning: every change so far is committed (both stacks empty, so nothing
   * can be undone or redone), the day's extra stack slots are gone, and so are the
   * monsters. Health is unchanged.
   */
  private sleep(): void {
    this.history.undoStack.length = 0;
    this.history.redoStack.length = 0;
    this.daySlots = 0;
    this.hour = START_HOUR;
    this.monsters.length = 0;
    this.restFade = REST_FADE;
    this.rested = true;
  }

  /**
   * Pick up any stack pickup the player overlaps. Picking one up isn't an action: it
   * takes no stack slot and can't be undone.
   */
  private collectPickups(): void {
    const p = this.player;
    const eps = 1e-6;
    for (let x = Math.floor(p.x + eps); x <= Math.floor(p.x + 1 - eps); x++) {
      for (let y = Math.floor(p.y + eps); y <= Math.floor(p.y + 1 - eps); y++) {
        const b = this.world.get(x, y);
        if (b !== Block.DayStack && b !== Block.KeepStack) continue;
        const key = `${x},${y}`;
        if (this.claiming.has(key)) continue;
        this.claiming.add(key);
        this.change([{ x, y, from: b, to: Block.Air }], (ok) => {
          this.claiming.delete(key);
          if (!ok) return; // someone else got there first
          this.flash([[x, y]], true);
          if (b === Block.DayStack) {
            this.daySlots++;
            this.note("+1 stack until you sleep");
          } else {
            this.keptSlots++;
            this.note("+1 stack");
          }
        });
      }
    }
  }

  /**
   * Death: the player respawns beside the campfire at full health, with every action on the
   * stack undone (most recent first), the inventory emptied, and the day's extra stack
   * slots gone. An action that can no longer be undone (its cells have changed since) stays
   * as it is. The clock carries on.
   */
  private die(): void {
    this.monsters.length = 0;
    this.spawn();
    this.history.redoStack.length = 0;
    this.daySlots = 0;
    this.restFade = REST_FADE;
    void this.rewind();
  }

  /** Undo the whole stack, most recent first, then empty the inventory. */
  private async rewind(): Promise<void> {
    this.rewinding = true;
    const h = this.history;
    for (let a = h.undoStack.pop(); a; a = h.undoStack.pop()) await this.make(a, "backward", false);
    this.inventory.clear();
    this.rewinding = false;
  }

  /** Whether there's no room for a new action; if so, flash the cell it would change. */
  private stackFull(x: number, y: number): boolean {
    if (this.history.undoStack.length < this.stackLimit) return false;
    this.flash([[x, y]], false);
    this.note("Stack full");
    return true;
  }

  /**
   * The cell that break/place act on: the one just past the player's edge in the facing
   * direction, so it never overlaps the player even mid-movement.
   */
  target(): [number, number] {
    const p = this.player;
    switch (p.facing) {
      case "up":
        return [Math.round(p.x), Math.floor(p.y + EPS) - 1];
      case "down":
        return [Math.round(p.x), Math.floor(p.y + 1 - EPS) + 1];
      case "left":
        return [Math.floor(p.x + EPS) - 1, Math.round(p.y)];
      case "right":
        return [Math.floor(p.x + 1 - EPS) + 1, Math.round(p.y)];
    }
  }

  /** Where to draw the player: interpolated between physics steps, plus any lift easing. */
  drawPosition(): [number, number] {
    const p = this.player;
    const t = this.accumulator / PHYSICS_STEP;
    return [p.prevX + (p.x - p.prevX) * t, p.prevY + (p.y - p.prevY) * t + p.stepEase];
  }

  /** Where to draw a monster, interpolated between physics steps. */
  monsterDrawPosition(m: Monster): [number, number] {
    const t = this.accumulator / PHYSICS_STEP;
    return [m.prevX + (m.x - m.prevX) * t, m.prevY + (m.y - m.prevY) * t];
  }

  update(dt: number): void {
    this.playTime += dt;
    this.restFade = Math.max(0, this.restFade - dt);
    this.world.campfireLit = this.campfireLit;
    if (!this.atCampfire()) this.cameToFire = true;
    const before = this.hour;
    this.hour += (dt * 24) / DAY_SECONDS;
    if (before < SLEEPY_HOUR && this.hour >= SLEEPY_HOUR) this.note("Getting sleepy...");
    // In a shared world, midnight is the server's to call.
    if (this.shared) this.hour = Math.min(this.hour, 24 - 1e-4);
    else if (this.hour >= 24) {
      // Still awake at midnight: the player falls asleep where they stand.
      this.day++;
      this.sleep();
      this.note("Fell asleep");
    }
    this.handleKeys(dt);
    this.accumulator = Math.min(this.accumulator + dt, 0.1);
    while (this.accumulator >= PHYSICS_STEP) {
      this.physics(PHYSICS_STEP);
      this.accumulator -= PHYSICS_STEP;
    }
    this.collectPickups();
    const p = this.player;
    p.stepEase *= Math.exp(-dt * 30);
    if (Math.abs(p.stepEase) < 0.01) p.stepEase = 0;
    this.fog.update(Math.round(p.x), Math.round(p.y), FOG_RANGE_X, FOG_RANGE_Y);
    this.attackCooldown -= dt;
    if (this.log) this.log.age += dt;
    this.inventoryShown = Math.max(0, this.inventoryShown - dt);
    if (this.speech && (this.speech.t -= dt) <= 0) this.speech = undefined;
    // Other players glide toward their last reported positions.
    const ease = 1 - Math.exp(-dt * 14);
    for (const peer of this.peers) {
      peer.drawX += (peer.x - peer.drawX) * ease;
      peer.drawY += (peer.y - peer.drawY) * ease;
      if (Math.abs(peer.x - peer.drawX) > 8 || Math.abs(peer.y - peer.drawY) > 8) [peer.drawX, peer.drawY] = [peer.x, peer.y];
      if (peer.speech && (peer.speech.t -= dt) <= 0) peer.speech = undefined;
    }
    if (this.broadcastShown && (this.broadcastShown.t -= dt) <= 0) this.broadcastShown = undefined;
    this.broadcastCooldown = Math.max(0, this.broadcastCooldown - dt);
    if (this.swing && (this.swing.t -= dt) <= 0) this.swing = undefined;
    for (const f of this.flashes) f.t -= dt;
    while (this.flashes.length && this.flashes[0].t <= 0) this.flashes.shift();
  }

  // ── Input ────────────────────────────────────────────────────────────

  private handleKeys(dt: number): void {
    const p = this.player;
    const { pressed, released } = this.input.drain();
    if (this.asleep) {
      // Asleep: no moving or acting until morning.
      this.repeatTimers.clear();
      return;
    }
    for (const code of pressed) {
      switch (code) {
        case "KeyW":
          p.facing = "up";
          if (!this.locked) p.jumpBuffer = JUMP_BUFFER;
          break;
        case "KeyS":
          p.facing = "down";
          break;
        case "KeyA":
          p.facing = "left";
          this.lastHorizontal = -1;
          break;
        case "KeyD":
          p.facing = "right";
          this.lastHorizontal = 1;
          break;
        case "KeyJ":
        case "KeyK":
        case "KeyU":
        case "KeyI":
          this.fire(code);
          this.repeatTimers.set(code, REPEAT_DELAY);
          break;
        default:
          if (code === "KeyF") this.rest();
          else if (code === "KeyQ") this.inventory.cycle(-1);
          else if (code === "KeyE") this.inventory.cycle(1);
          else if (code.startsWith("Digit")) this.inventory.selectIndex(Number(code.slice(5)) - 1);
          if (code === "KeyQ" || code === "KeyE" || code.startsWith("Digit")) this.inventoryShown = INVENTORY_SHOW;
      }
    }
    for (const code of released) {
      this.repeatTimers.delete(code);
      if (code === "KeyW" && !this.locked) {
        // Releasing W ends the rise. The cursor turns to whichever of A/D is held, or
        // downward if neither is (e.g. for pillaring).
        if (p.vy < 0) p.vy *= JUMP_CUT;
        if (p.facing === "up") {
          const dir = this.horizontalInput();
          p.facing = dir > 0 ? "right" : dir < 0 ? "left" : "down";
        }
      }
    }
    for (const [code, t] of this.repeatTimers) {
      const next = t - dt;
      if (next <= 0) {
        this.fire(code);
        this.repeatTimers.set(code, next + REPEAT_RATE);
      } else {
        this.repeatTimers.set(code, next);
      }
    }
  }

  private fire(code: string): void {
    if (code === "KeyJ") {
      // The swing shows on a hit or a miss, but not when J breaks a block instead.
      if (this.history.undoStack.length >= this.stackLimit && !this.breakableTarget()) {
        // A full stack stops attacks too. (Breaking a block gives its own refusal.)
        this.note("Can't attack with a full stack");
        return;
      }
      const result = this.attack();
      const broke = result === "none" && this.breakTarget();
      if (result !== "cooldown" && !broke) this.swing = { facing: this.player.facing, t: SWING_TIME };
    }
    else if (code === "KeyK") this.placeTarget();
    else if (code === "KeyU") this.undo();
    else if (code === "KeyI") this.redo();
  }

  private horizontalInput(): number {
    if (this.locked) return 0;
    const a = this.input.held.has("KeyA");
    const d = this.input.held.has("KeyD");
    if (a && d) return this.lastHorizontal;
    return d ? 1 : a ? -1 : 0;
  }

  // ── Actions ──────────────────────────────────────────────────────────

  /**
   * Hit every monster within reach in the facing direction. "none" means nothing was in
   * reach (so J breaks a block instead); "cooldown" means something was in reach but the
   * last hit was too recent.
   */
  /** Monsters within the attack area. */
  private monstersInReach(): Monster[] {
    return this.population.inArea(this.attackArea());
  }

  /** Whether J would break a block rather than attack: no monster in reach, and a breakable target. */
  private breakableTarget(): boolean {
    const [x, y] = this.target();
    const b = this.world.get(x, y);
    return !this.monstersInReach().length && b !== Block.Air && b !== Block.Water && BLOCKS[b].breakable;
  }

  /**
   * Attack whatever is in reach. In a shared world the server decides what's hit (and
   * reports back for the log); alone, it happens here.
   */
  private attack(): "hit" | "cooldown" | "none" {
    const p = this.player;
    if (!this.monstersInReach().length) return "none";
    if (this.attackCooldown > 0) return "cooldown";
    this.attackCooldown = ATTACK_COOLDOWN;
    if (this.shared) this.shared.attack(p.facing);
    else this.note(this.population.hit(this.attackArea(), p.x, p.y).join("; "));
    return "hit";
  }

  /** The region J attacks: a strip just past the player's facing edge. */
  attackArea(): [number, number, number, number] {
    const p = this.player;
    return attackArea(p.x, p.y, p.facing);
  }

  /** Break the target block, if there is a breakable one. Returns whether a block broke. */
  private breakTarget(): boolean {
    const [x, y] = this.target();
    const b = this.world.get(x, y);
    if (b === Block.Air || b === Block.Water) return false;
    if (!BLOCKS[b].breakable) {
      this.flash([[x, y]], false);
      return false;
    }
    if (this.stackFull(x, y)) return true; // counts as handled, so no swing
    // Water that pours into the gap is part of the same action, so undo takes it back.
    const cells: CellChange[] = [{ x, y, before: b, after: Block.Air, beforeText: this.world.signText(x, y) }];
    const wet = flood(this.world, [[x, y]]);
    for (const [wx, wy] of wet) {
      if (wx === x && wy === y) cells[0].after = Block.Water;
      else cells.push({ x: wx, y: wy, before: Block.Air, after: Block.Water });
    }
    // Signs are not picked up when broken.
    const inventory = new Map<Block, number>(b === Block.Sign ? [] : [[b, 1]]);
    return this.perform({ kind: "break", cells, inventory }, () => {
      this.note(`Broke ${BLOCKS[b].name}`);
      if (wet.length > 1) this.flash(wet, true);
    });
  }

  private placeTarget(): void {
    const [x, y] = this.target();
    const b = this.inventory.selectedBlock();
    if (b === undefined || this.inventory.count(b) <= 0) return;
    const before = this.world.get(x, y);
    if (before !== Block.Air && before !== Block.Water) return;
    if (this.monsters.some((m) => boxesOverlap(m.x, m.y, x, y, 0.05))) {
      this.flash([[x, y]], false);
      return;
    }
    if (this.stackFull(x, y)) return;
    const action: Action = {
      kind: "place",
      cells: [{ x, y, before, after: b }],
      inventory: new Map([[b, -1]]),
    };
    this.perform(action, () => this.note(`Placed ${BLOCKS[b].name}`));
  }

  /**
   * Do a new action: once its changes are made, it goes on the undo stack and `then` runs.
   * Returns whether it passed the local checks (so it's done, or on its way to the server).
   */
  private perform(a: Action, then: () => void): boolean {
    if (this.busy || this.rewinding || !this.check(a, "forward")) return false;
    this.busy = true;
    void this.make(a, "forward", false).then((ok) => {
      this.busy = false;
      if (!ok) return;
      this.history.record(a);
      then();
    });
    return true;
  }

  undo(): void {
    this.step(this.history.undoStack, this.history.redoStack, "backward", "Undid", "Couldn't undo");
  }

  redo(): void {
    this.step(this.history.redoStack, this.history.undoStack, "forward", "Redid", "Couldn't redo");
  }

  /** Undo or redo: apply the top action of `from` and move it onto `to`. */
  private step(from: Action[], to: Action[], way: "forward" | "backward", did: string, failed: string): void {
    const a = from.at(-1);
    if (!a || this.busy || this.rewinding) return;
    if (!this.check(a, way)) {
      this.note(`${failed}: ${describe(a)}`);
      return;
    }
    this.busy = true;
    void this.make(a, way, true).then((ok) => {
      this.busy = false;
      if (!ok) {
        this.note(`${failed}: ${describe(a)}`);
        return;
      }
      const i = from.lastIndexOf(a);
      if (i >= 0) from.splice(i, 1);
      to.push(a);
      this.note(`${did}: ${describe(a)}`);
    });
  }

  /**
   * Changes made by another player. Any of this player's actions touching the same cells
   * can no longer be undone (or redone), so they leave the stacks and stay as they are.
   */
  remoteChanges(changes: Change[]): void {
    this.writeChanges(changes);
    const touched = new Set(changes.map((c) => `${c.x},${c.y}`));
    const hit = (a: Action): boolean => a.cells.some((c) => touched.has(`${c.x},${c.y}`));
    const h = this.history;
    const committed = h.undoStack.filter(hit);
    if (committed.length) {
      h.undoStack.splice(0, h.undoStack.length, ...h.undoStack.filter((a) => !hit(a)));
      this.note(`Committed: ${describe(committed[committed.length - 1])}`);
    }
    h.redoStack.splice(0, h.redoStack.length, ...h.redoStack.filter((a) => !hit(a)));
  }

  /**
   * Changes that aren't actions (signs, pickups): made at once alone, or once the server
   * agrees in a shared world. `then` gets whether they were made.
   */
  private change(changes: Change[], then: (ok: boolean) => void): void {
    if (!this.shared) {
      this.writeChanges(changes);
      then(true);
      return;
    }
    void this.shared.request(changes).then((ok) => {
      if (ok) this.writeChanges(changes);
      then(ok);
    });
  }

  /** Write changes into the local world, sign text included. */
  private writeChanges(changes: Change[]): void {
    for (const c of changes) {
      this.world.set(c.x, c.y, c.to);
      if (c.to === Block.Sign || c.from === Block.Sign) this.world.setSignText(c.x, c.y, c.to === Block.Sign ? c.text : undefined);
    }
  }

  /** Say something: it shows in a speech bubble above the player for a while. */
  say(text: string): void {
    this.speech = speechFor(text);
    this.shared?.say(text);
  }

  /** Something another player said. */
  peerSaid(id: number, text: string): void {
    const peer = this.peers.find((p) => p.id === id);
    if (peer) peer.speech = speechFor(text);
  }

  /**
   * Say something to everyone: it shows as a banner across the top of the view. Only one
   * broadcast is allowed per BROADCAST_COOLDOWN seconds; returns false while cooling down.
   */
  broadcast(text: string): boolean {
    if (this.broadcastCooldown > 0) return false;
    this.showBroadcast(text);
    this.broadcastCooldown = BROADCAST_COOLDOWN;
    this.shared?.broadcast(text);
    return true;
  }

  /** Show a broadcast's banner: this player's, or another's (with their name). */
  showBroadcast(text: string): void {
    const t = BROADCAST_BASE + SPEECH_PER_CHAR * text.length;
    this.broadcastShown = { text, t, total: t };
  }

  /**
   * Place a sign bearing `text` in the target cell, which must be open air. Placing a sign
   * isn't an action: it takes no stack slot, can't be undone, and costs nothing from the
   * inventory. (Breaking one is an ordinary action.)
   */
  placeSign(text: string): boolean {
    const [x, y] = this.target();
    if (this.world.get(x, y) !== Block.Air) {
      this.flash([[x, y]], false);
      return false;
    }
    this.change([{ x, y, from: Block.Air, to: Block.Sign, text }], (ok) => {
      this.flash([[x, y]], ok);
      if (ok) this.note("Placed sign");
    });
    return true;
  }

  /** The sign under the player, if they are standing on one: its cell and text. */
  signUnderfoot(): { x: number; y: number; text: string } | undefined {
    const x = Math.round(this.player.x);
    const y = Math.round(this.player.y);
    if (this.world.get(x, y) !== Block.Sign) return undefined;
    const text = this.world.signText(x, y);
    return text === undefined ? undefined : { x, y, text };
  }

  /** Write a line to the activity log. */
  /** Write a line to the activity log; repeating the latest line bumps its count. */
  note(text: string): void {
    if (this.log && this.log.text === text) {
      this.log.count++;
      this.log.age = 0;
    } else {
      this.log = { text, count: 1, age: 0 };
    }
  }

  /** An action's changes, applied forward or backward. */
  private changesOf(a: Action, way: "forward" | "backward"): Change[] {
    const fwd = way === "forward";
    return a.cells.map((c) => ({
      x: c.x,
      y: c.y,
      from: fwd ? c.before : c.after,
      to: fwd ? c.after : c.before,
      text: fwd ? c.afterText : c.beforeText,
    }));
  }

  /**
   * Whether an action can be applied forward or backward, as far as this player can tell:
   * every cell still matches the diff's starting state, no block would land where the
   * player is, and the inventory covers it. If not, the cells at fault flash.
   */
  private check(a: Action, way: "forward" | "backward"): boolean {
    const sign = way === "forward" ? 1 : -1;
    const changes = this.changesOf(a, way);
    const fail = (bad: Change[]): boolean => {
      this.flash(bad.map((c) => [c.x, c.y]), false);
      return false;
    };
    const stale = changes.filter((c) => this.world.get(c.x, c.y) !== c.from);
    if (stale.length) return fail(stale);
    const occupied = changes.filter((c) => isSolid(c.to) && this.overlapsPlayer(c.x, c.y));
    if (occupied.length) return fail(occupied);
    for (const [b, n] of a.inventory) if (this.inventory.count(b) + sign * n < 0) return fail(changes);
    return true;
  }

  /**
   * Apply an action forward or backward: at once alone, or once the server agrees in a
   * shared world. Resolves to whether it was applied; a refusal flashes the cells.
   */
  private async make(a: Action, way: "forward" | "backward", flashOnSuccess: boolean): Promise<boolean> {
    if (!this.check(a, way)) return false;
    const changes = this.changesOf(a, way);
    if (this.shared && !(await this.shared.request(changes))) {
      this.flash(changes.map((c) => [c.x, c.y]), false);
      return false;
    }
    this.writeChanges(changes);
    // A block that appears where a monster is crushes it. (The server sees to that in a
    // shared world.)
    if (!this.shared) for (const e of this.population.crush()) this.note(e);
    const sign = way === "forward" ? 1 : -1;
    for (const [b, n] of a.inventory) this.inventory.add(b, sign * n);
    if (flashOnSuccess) this.flash(changes.map((c) => [c.x, c.y]), true);
    return true;
  }

  private flash(cells: [number, number][], ok: boolean): void {
    for (const [x, y] of cells) this.flashes.push({ x, y, t: FLASH_TIME, ok });
  }

  // ── Physics ──────────────────────────────────────────────────────────

  private overlapsPlayer(cx: number, cy: number): boolean {
    const p = this.player;
    return p.x < cx + 1 - EPS && p.x + 1 > cx + EPS && p.y < cy + 1 - EPS && p.y + 1 > cy + EPS;
  }

  private boxHitsSolid(x: number, y: number): boolean {
    return this.world.boxHitsSolid(x, y);
  }


  private physics(dt: number): void {
    const p = this.player;
    p.prevX = p.x;
    p.prevY = p.y;
    const dir = this.horizontalInput();
    const midX = Math.floor(p.x + 0.5);
    const midY = Math.floor(p.y + 0.5);
    const swimming = isLiquid(this.world.get(midX, midY));

    let snapTarget: number | undefined;
    if (p.stunned > 0) {
      p.stunned -= dt;
    } else if (dir !== 0) {
      const accel = p.grounded ? ACCEL_GROUND : ACCEL_AIR;
      p.vx = approach(p.vx, dir * RUN * (swimming ? SWIM_RUN : 1), accel * dt);
    } else {
      snapTarget = this.snapVelocity(dt);
    }

    p.coyote = p.grounded ? COYOTE : p.coyote - dt;
    p.jumpBuffer -= dt;
    if (swimming) {
      // In water: hold W to swim up, and to hop out at the surface; otherwise sink slowly.
      const up = !this.locked && this.input.held.has("KeyW") && p.stunned <= 0;
      const above = this.world.get(midX, midY - 1);
      p.jumpBuffer = 0;
      if (up && !isLiquid(above) && !isSolid(above)) p.vy = -SURFACE_HOP;
      else if (up) p.vy = approach(p.vy, -SWIM_UP, 60 * dt);
      else p.vy = approach(p.vy, SINK_SPEED, (p.vy > SINK_SPEED ? 90 : GRAVITY * 0.25) * dt);
    } else {
      if (p.jumpBuffer > 0 && p.coyote > 0) {
        p.vy = -JUMP_SPEED;
        p.grounded = false;
        p.coyote = 0;
        p.jumpBuffer = 0;
      }
      p.vy = Math.min(p.vy + GRAVITY * dt, MAX_FALL);
    }

    this.moveX(p.vx * dt);
    this.moveY(p.vy * dt);

    if (snapTarget !== undefined && Math.abs(p.x - snapTarget) < 1e-5) {
      p.x = snapTarget;
      p.vx = 0;
    }
    if (p.y > WORLD_H + 10) this.spawn();
    if (p.invulnerable <= 0 && this.touchingMagma()) this.hurtPlayer(1, p.x + 0.5, MAGMA_BOUNCE, "Burned by magma");

    this.updateMonsters(dt);
  }

  // ── Monsters ─────────────────────────────────────────────────────────

  private updateMonsters(dt: number): void {
    const p = this.player;
    p.invulnerable = Math.max(0, p.invulnerable - dt);
    if (this.shared) {
      // The server's monsters: glide toward where it last said they were.
      const ease = 1 - Math.exp(-dt * 14);
      for (const m of this.monsters) {
        const to = this.mirrorTargets.get(m.id);
        if (!to) continue;
        m.x += (to[0] - m.x) * ease;
        m.y += (to[1] - m.y) * ease;
        m.prevX = m.x;
        m.prevY = m.y;
      }
      return;
    }
    this.population.step(dt, [p]);
    const m = p.invulnerable <= 0 ? this.population.touching(p.x, p.y) : undefined;
    // Dying clears the monsters, so nothing else here needs doing after it.
    if (m && this.hurtPlayer(m.damage, m.x + 0.5, HIT_KNOCKBACK, `Hurt by ${m.def.name}`)) return;

    // More monsters, more often, out in the wilds.
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = spawnInterval(p.x);
      if (this.light && this.population.near(p.x, p.y) < spawnCap(p.x)) this.population.trySpawn(this.light, p.x, p.y);
    }
  }

  /** Where the server last put each monster, by id (shared world only). */
  private mirrorTargets = new Map<number, [number, number]>();

  /**
   * The server's monsters, as [id, kind, x, y, hurt, winding]: new ones appear, gone ones
   * vanish, and the rest are moved toward their new positions.
   */
  syncMonsters(list: [number, number, number, number, number, number][]): void {
    const byId = new Map(this.monsters.map((m) => [m.id, m]));
    const next: Monster[] = [];
    this.mirrorTargets.clear();
    for (const [id, kind, x, y, hurt, winding] of list) {
      let m = byId.get(id);
      if (!m) {
        m = new Monster(MONSTER_KINDS[kind], x, y);
        m.id = id;
      }
      m.hurt = hurt ? 0.18 : Math.min(m.hurt, 0);
      m.showWinding(winding === 1);
      this.mirrorTargets.set(id, [x, y]);
      next.push(m);
    }
    this.monsters.splice(0, this.monsters.length, ...next);
  }

  /** A monster's touch, reported by the server. */
  remoteHurt(damage: number, fromX: number, cause: string): void {
    if (this.player.invulnerable > 0 || this.asleep) return;
    this.hurtPlayer(damage, fromX, HIT_KNOCKBACK, cause);
  }

  /** Whether the player is in or standing on magma. */
  private touchingMagma(): boolean {
    const p = this.player;
    const x0 = Math.floor(p.x + EPS);
    const x1 = Math.floor(p.x + 1 - EPS);
    const y0 = Math.floor(p.y + EPS);
    const y1 = Math.floor(p.y + 1.05);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) if (this.world.get(x, y) === Block.Magma) return true;
    return false;
  }

  /**
   * Take `damage` hearts and get knocked up and away from `fromX`, the source's center
   * column (straight up when the source is directly below, as with magma). Returns
   * whether the player died (and respawned).
   */
  private hurtPlayer(damage: number, fromX: number, knock: number, cause: string): boolean {
    const p = this.player;
    p.hp -= damage;
    if (p.hp <= 0) {
      this.die();
      this.note(`${cause}; died`);
      return true;
    }
    this.note(cause);
    p.invulnerable = INVULNERABLE_TIME;
    p.stunned = 0.2;
    const dx = p.x + 0.5 - fromX;
    p.vx = Math.abs(dx) < 0.3 ? 0 : Math.sign(dx) * knock;
    p.vy = -knock * 0.8;
    p.grounded = false;
    return false;
  }

  /**
   * With no horizontal input, glide to a whole-cell column: the next one in the direction
   * of travel, decelerating so the player arrives there and stops exactly on the grid.
   */
  private snapVelocity(dt: number): number | undefined {
    const p = this.player;
    const nearest = Math.round(p.x);
    if (Math.abs(p.x - nearest) < 1e-5 && Math.abs(p.vx) < 1e-3) {
      p.x = nearest;
      p.vx = 0;
      return undefined;
    }
    const target =
      p.vx > 1e-3 ? Math.ceil(p.x - 1e-5) : p.vx < -1e-3 ? Math.floor(p.x + 1e-5) : nearest;
    const dist = target - p.x;
    const ideal = Math.min(RUN, Math.sqrt(2 * SNAP_DECEL * Math.abs(dist)));
    const current = Math.abs(p.vx) > 1e-3 ? Math.abs(p.vx) : ideal;
    const speed = Math.max(SNAP_MIN_SPEED, Math.min(current, ideal));
    p.vx = speed * dt >= Math.abs(dist) ? dist / dt : Math.sign(dist) * speed;
    return target;
  }

  private moveX(dx: number): void {
    if (dx === 0) return;
    const p = this.player;
    const nx = p.x + dx;
    if (!this.boxHitsSolid(nx, p.y)) {
      p.x = nx;
      return;
    }
    // Step up a one-cell ledge automatically when walking into it on the ground.
    const yAligned = Math.abs(p.y - Math.round(p.y)) < 1e-4;
    if (this.autoStep && p.grounded && yAligned && !this.boxHitsSolid(p.x, p.y - 1) && !this.boxHitsSolid(nx, p.y - 1)) {
      p.y -= 1;
      p.prevY -= 1;
      p.x = nx;
      p.stepEase += 1;
      return;
    }
    // Slot assist: moving sideways into a wall while between rows, line up with an opening
    // within SLOT_ASSIST of the current height. Without this, a gap exactly one cell tall
    // can only be entered at the single instant the player passes its height.
    const row = Math.round(p.y);
    const shift = row - p.y;
    if (!yAligned && Math.abs(shift) <= SLOT_ASSIST && !this.boxHitsSolid(p.x, row) && !this.boxHitsSolid(nx, row)) {
      p.y = row;
      p.prevY += shift;
      p.stepEase -= shift;
      p.vy = 0;
      p.x = nx;
      return;
    }
    p.x = dx > 0 ? Math.floor(nx + 1 - EPS) - 1 : Math.floor(nx + EPS) + 1;
    p.vx = 0;
  }

  private moveY(dy: number): void {
    const p = this.player;
    const ny = p.y + dy;
    if (!this.boxHitsSolid(p.x, ny)) {
      p.y = ny;
      p.grounded = this.boxHitsSolid(p.x, p.y + 2 * EPS) && p.vy >= 0;
      return;
    }
    if (dy > 0) {
      p.y = Math.floor(ny + 1 - EPS) - 1;
      p.grounded = true;
    } else {
      p.y = Math.floor(ny + EPS) + 1;
    }
    p.vy = 0;
  }
}

function approach(v: number, target: number, step: number): number {
  return v < target ? Math.min(v + step, target) : Math.max(v - step, target);
}

/** An action as the log names it, e.g. "broke mycel". */
function speechFor(text: string): { text: string; t: number; total: number } {
  const t = SPEECH_BASE + SPEECH_PER_CHAR * text.length;
  return { text, t, total: t };
}

function describe(a: Action): string {
  const c = a.cells[0];
  return a.kind === "break" ? `broke ${BLOCKS[c.before].name}` : `placed ${BLOCKS[c.after].name}`;
}
