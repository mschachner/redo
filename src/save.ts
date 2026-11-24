import { Block } from "./blocks";
import { Dir, Game, MAX_HP } from "./game";
import type { Action, CellChange } from "./history";
import type { Input } from "./input";
import { regionName } from "./names";
import { World } from "./world";

/**
 * Saved singleplayer worlds, kept in this browser's localStorage.
 *
 * A world is its seed plus everything that differs from what the seed generates: the
 * cells the player changed, signs, explored fog, the player, inventory, clock, and the
 * undo and redo stacks. Monsters aren't kept; new ones spawn as usual.
 *
 * Blocks are stored by name through a per-save palette, so reordering the Block enum
 * doesn't scramble old saves.
 */

const FORMAT = 1;
const INDEX_KEY = "redo.worlds";
const worldKey = (id: string): string => `redo.world.${id}`;

/** What the world list shows, without loading the world itself. */
export interface WorldMeta {
  id: string;
  name: string;
  /** The seed's words (a number in saves from before word seeds). */
  seed: string | number;
  day: number;
  /** When the world was last saved (ms since the epoch). */
  played: number;
}

/** A sign's or a cell change's text, kept only when present. */
type Text = string | null;
/** x, y, before, after (palette indices), and sign text before and after. */
type SavedChange = [number, number, number, number, Text, Text];
interface SavedAction {
  kind: Action["kind"];
  cells: SavedChange[];
  /** Palette index and count. */
  inventory: [number, number][];
}

interface SavedWorld {
  format: number;
  seed: string | number;
  palette: string[];
  /** Flattened [x, y, block] for every changed cell. */
  cells: number[];
  signs: [number, number, string][];
  fog: [number, string][];
  player: { x: number; y: number; hp: number; facing: Dir };
  /** Palette index and count, in pickup order. */
  inventory: [number, number][];
  selected: number | null;
  hour: number;
  day: number;
  playTime: number;
  broadcastCooldown: number;
  /** Stack slots from pickups (absent in saves from before pickups). */
  keptSlots?: number;
  daySlots?: number;
  undo: SavedAction[];
  redo: SavedAction[];
}

export function newWorldId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** A name for a new world: the made-up name of the region the player starts in. */
export function worldName(game: Game): string {
  const region = game.world.terrain.regionAt(Math.round(game.player.x));
  return regionName(game.world.seed, region.index, region.biome);
}

/** Saved worlds, most recently played first. */
export function listWorlds(): WorldMeta[] {
  try {
    const list = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]") as WorldMeta[];
    return list.sort((a, b) => b.played - a.played);
  } catch {
    return [];
  }
}

function writeIndex(list: WorldMeta[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(list));
}

/** Save a world under `meta.id`. Returns false if storage refused it (e.g. it's full). */
export function saveWorld(meta: Omit<WorldMeta, "day" | "played">, game: Game): boolean {
  try {
    localStorage.setItem(worldKey(meta.id), JSON.stringify(serialize(game)));
    const list = listWorlds().filter((w) => w.id !== meta.id);
    list.push({ ...meta, day: game.day, played: Date.now() });
    writeIndex(list);
    return true;
  } catch {
    return false;
  }
}

/** A saved world exactly as stored, to put back later. */
export interface Snapshot {
  meta: WorldMeta;
  raw: string;
}

export function snapshot(id: string): Snapshot | undefined {
  try {
    const meta = listWorlds().find((w) => w.id === id);
    const raw = localStorage.getItem(worldKey(id));
    return meta && raw ? { meta, raw } : undefined;
  } catch {
    return undefined;
  }
}

/** Put a world back exactly as it was when the snapshot was taken. */
export function restoreSnapshot(s: Snapshot): void {
  try {
    localStorage.setItem(worldKey(s.meta.id), s.raw);
    writeIndex([...listWorlds().filter((w) => w.id !== s.meta.id), s.meta]);
  } catch {
    // Storage unavailable: leave it.
  }
}

export function deleteWorld(id: string): void {
  try {
    localStorage.removeItem(worldKey(id));
    writeIndex(listWorlds().filter((w) => w.id !== id));
  } catch {
    // Storage unavailable: nothing to delete.
  }
}

/** Load a saved world as a game, or undefined if it's missing or unreadable. */
export function loadWorld(id: string, input: Input): Game | undefined {
  try {
    const raw = localStorage.getItem(worldKey(id));
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as SavedWorld;
    if (saved.format !== FORMAT) return undefined;
    return restore(saved, input);
  } catch {
    return undefined;
  }
}

function serialize(game: Game): SavedWorld {
  const palette: string[] = [];
  const indexOf = new Map<Block, number>();
  const pal = (b: Block): number => {
    let i = indexOf.get(b);
    if (i === undefined) {
      i = palette.length;
      palette.push(Block[b]);
      indexOf.set(b, i);
    }
    return i;
  };
  const world = game.world;
  const cells: number[] = [];
  for (const [x, y] of world.editedCells()) cells.push(x, y, pal(world.get(x, y)));
  const action = (a: Action): SavedAction => ({
    kind: a.kind,
    cells: a.cells.map((c) => [c.x, c.y, pal(c.before), pal(c.after), c.beforeText ?? null, c.afterText ?? null]),
    inventory: [...a.inventory].map(([b, n]) => [pal(b), n]),
  });
  const inv = game.inventory;
  const selected = inv.selectedBlock();
  const p = game.player;
  return {
    format: FORMAT,
    seed: world.seedName,
    palette,
    cells,
    signs: world.signEntries(),
    fog: game.fog.save(),
    player: { x: p.x, y: p.y, hp: p.hp, facing: p.facing },
    inventory: inv.slots.map((b) => [pal(b), inv.count(b)]),
    selected: selected === undefined ? null : pal(selected),
    hour: game.hour,
    day: game.day,
    playTime: game.playTime,
    broadcastCooldown: game.broadcastCooldown,
    keptSlots: game.keptSlots,
    daySlots: game.daySlots,
    undo: game.history.undoStack.map(action),
    redo: game.history.redoStack.map(action),
  };
}

function restore(s: SavedWorld, input: Input): Game | undefined {
  const blocks = s.palette.map((name) => Block[name as keyof typeof Block]);
  if (blocks.some((b) => b === undefined)) return undefined; // a block this version doesn't know
  const world = new World(String(s.seed));
  for (let i = 0; i + 2 < s.cells.length; i += 3) world.set(s.cells[i], s.cells[i + 1], blocks[s.cells[i + 2]]);
  for (const [x, y, text] of s.signs) world.setSignText(x, y, text);

  const game = new Game(world, input);
  game.fog.load(s.fog);
  const p = game.player;
  p.x = p.prevX = s.player.x;
  p.y = p.prevY = s.player.y;
  p.vx = p.vy = 0;
  p.hp = Math.max(1, Math.min(MAX_HP, s.player.hp));
  p.facing = s.player.facing;
  for (const [b, n] of s.inventory) game.inventory.add(blocks[b], n);
  game.inventory.select(s.selected === null ? undefined : blocks[s.selected]);
  game.hour = s.hour;
  game.day = s.day;
  game.playTime = s.playTime;
  game.broadcastCooldown = s.broadcastCooldown;
  game.keptSlots = s.keptSlots ?? 0;
  game.daySlots = s.daySlots ?? 0;
  const action = (a: SavedAction): Action => ({
    kind: a.kind,
    cells: a.cells.map(([x, y, before, after, bt, at]): CellChange => {
      const c: CellChange = { x, y, before: blocks[before], after: blocks[after] };
      if (bt !== null) c.beforeText = bt;
      if (at !== null) c.afterText = at;
      return c;
    }),
    inventory: new Map(a.inventory.map(([b, n]) => [blocks[b], n])),
  });
  game.history.undoStack.push(...s.undo.map(action));
  game.history.redoStack.push(...s.redo.map(action));
  return game;
}
