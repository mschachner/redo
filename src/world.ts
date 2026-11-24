import { Block, isSolid } from "./blocks";
import { seedNumber } from "./seeds";
import { CHUNK_W, SEA, Terrain, WORLD_H } from "./worldgen";

export { CHUNK_W, WORLD_H };

/**
 * A horizontally unbounded world, generated lazily in chunks of CHUNK_W columns.
 * Generation is a pure function of (seed, x, y), so a saved world only needs the
 * seed plus whatever cells were edited.
 */
export class World {
  readonly terrain: Terrain;
  /** Bumped on every edit, so cached lighting knows when to refresh. */
  version = 0;
  private chunks = new Map<number, Uint8Array>();
  /** Every cell that has been changed since generation, by `editKey`. */
  private edited = new Set<number>();
  private dugTops = new Map<number, number>();
  private dugTopsVersion = -1;
  /** The text on each sign, by cell. */
  private signs = new Map<string, string>();
  private lastCx = NaN;
  private lastChunk: Uint8Array | undefined;

  /** The number the generator uses, from the seed's words. */
  readonly seed: number;

  /** `seedName` is the seed as the player sees it, in kebab-case words. */
  /** The campfire: the open cell holding it, and whether it's burning (from 21:00). */
  readonly fireX: number;
  readonly fireY: number;
  campfireLit = false;
  /** Where players start, respawn and wake from resting: the cell beside the campfire. */
  readonly spawnX: number;
  readonly spawnY: number;

  constructor(readonly seedName: string) {
    this.seed = seedNumber(seedName);
    this.terrain = new Terrain(this.seed);
    // The spawn is found and its campfire laid before any edits, so it depends on the seed
    // alone and a reloaded world puts it in the same place.
    [this.fireX, this.fireY] = this.findSpawn();
    this.spawnX = this.fireX + 1;
    this.spawnY = this.fireY;
    this.stamp(this.fireX, this.fireY, Block.Campfire);
  }

  /**
   * The campfire's cell: nearest column 0, an open cell on dry ground with another one
   * level with it to its right, where the player stands.
   */
  private findSpawn(): [number, number] {
    const standable = (x: number, ground: number): boolean =>
      ground < SEA && this.get(x, ground - 1) === Block.Air && this.solid(x, ground);
    for (let i = 0; ; i++) {
      const x = (i % 2 ? -1 : 1) * Math.ceil(i / 2);
      const ground = this.terrain.groundTop(x);
      if (!standable(x, ground) || this.terrain.groundTop(x + 1) !== ground || !standable(x + 1, ground)) continue;
      return [x, ground - 1];
    }
  }

  /** Write a cell as part of the generated world: not an edit, and not saved. */
  private stamp(x: number, y: number, b: Block): void {
    const cx = Math.floor(x / CHUNK_W);
    this.chunk(cx)[(x - cx * CHUNK_W) * WORLD_H + y] = b;
  }

  get(x: number, y: number): Block {
    if (y < 0) return Block.Air;
    if (y >= WORLD_H) return Block.Bedrock;
    const cx = Math.floor(x / CHUNK_W);
    return this.chunk(cx)[(x - cx * CHUNK_W) * WORLD_H + y] as Block;
  }

  set(x: number, y: number, b: Block): void {
    if (y < 0 || y >= WORLD_H) return;
    const cx = Math.floor(x / CHUNK_W);
    this.chunk(cx)[(x - cx * CHUNK_W) * WORLD_H + y] = b;
    this.edited.add(editKey(x, y));
    this.version++;
  }

  /**
   * The top of the ground in column x as it stands now: the generated ground top, or, if
   * that cell is open (dug away, or never filled because a cave breaks the surface there),
   * the first solid cell below it. Blocks above the generated ground top (structures, or
   * blocks the player placed in the open) don't count. Cached until the next edit.
   */
  dugTop(x: number): number {
    if (this.dugTopsVersion !== this.version) {
      this.dugTops.clear();
      this.dugTopsVersion = this.version;
    }
    let y = this.dugTops.get(x);
    if (y === undefined) {
      y = this.terrain.groundTop(x);
      while (y < WORLD_H && !this.solid(x, y)) y++;
      this.dugTops.set(x, y);
    }
    return y;
  }

  /** Every cell changed since generation, as [x, y] pairs. */
  editedCells(): [number, number][] {
    return [...this.edited].map((k) => [Math.floor(k / WORLD_H) - 2 ** 30, k % WORLD_H]);
  }

  /** How many cells have been changed since generation. */
  get editCount(): number {
    return this.edited.size;
  }

  /** Every sign's text, as [x, y, text]. */
  signEntries(): [number, number, string][] {
    return [...this.signs].map(([key, text]) => {
      const [x, y] = key.split(",").map(Number);
      return [x, y, text];
    });
  }

  /** Whether a cell has been changed (broken, placed, flooded) since generation. */
  wasEdited(x: number, y: number): boolean {
    return this.edited.has(editKey(x, y));
  }

  signText(x: number, y: number): string | undefined {
    return this.signs.get(`${x},${y}`);
  }

  setSignText(x: number, y: number, text: string | undefined): void {
    if (text === undefined) this.signs.delete(`${x},${y}`);
    else this.signs.set(`${x},${y}`, text);
  }

  solid(x: number, y: number): boolean {
    return isSolid(this.get(x, y));
  }

  /** Whether the segment between two points crosses no solid cell (endpoints' cells excluded). */
  lineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    const startX = Math.floor(x0);
    const startY = Math.floor(y0);
    const endX = Math.floor(x1);
    const endY = Math.floor(y1);
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.2);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const cx = Math.floor(x0 + (x1 - x0) * t);
      const cy = Math.floor(y0 + (y1 - y0) * t);
      if ((cx === startX && cy === startY) || (cx === endX && cy === endY)) continue;
      if (this.solid(cx, cy)) return false;
    }
    return true;
  }

  /** Whether a 1×1 box with top-left corner (x, y) overlaps any solid cell. */
  boxHitsSolid(x: number, y: number): boolean {
    const eps = 1e-6;
    const x0 = Math.floor(x + eps);
    const x1 = Math.floor(x + 1 - eps);
    const y0 = Math.floor(y + eps);
    const y1 = Math.floor(y + 1 - eps);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) if (this.solid(cx, cy)) return true;
    return false;
  }

  private chunk(cx: number): Uint8Array {
    if (cx === this.lastCx) return this.lastChunk!;
    let c = this.chunks.get(cx);
    if (!c) {
      c = this.terrain.generateChunk(cx);
      this.chunks.set(cx, c);
    }
    this.lastCx = cx;
    this.lastChunk = c;
    return c;
  }
}

const editKey = (x: number, y: number): number => (x + 2 ** 30) * WORLD_H + y;
