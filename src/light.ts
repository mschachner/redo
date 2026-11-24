import { Block, BLOCKS } from "./blocks";
import { World } from "./world";
import { WORLD_H } from "./worldgen";

export const MAX_LIGHT = 15;
const SUN_LOOKUP = 56; // rows above the region where sunlight tracing starts

/** Light lost entering a block when spreading, per channel [r, g, b]. */
const SPREAD_COST = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
/** Light lost by sunlight passing down through a block; MAX_LIGHT blocks it. */
const SUN_COST = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
const EMIT = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];

for (let b = 0; b < BLOCKS.length; b++) {
  const def = BLOCKS[b];
  for (let ch = 0; ch < 3; ch++) {
    // Water soaks up red fastest, so depth turns blue.
    const wet = ch === 0 ? 2 : 1;
    SPREAD_COST[ch][b] = def.liquid ? wet : def.solid && !def.translucent ? 2 : 1;
    SUN_COST[ch][b] = def.liquid ? wet : !def.solid ? 0 : def.translucent ? 3 : MAX_LIGHT;
    EMIT[ch][b] = def.emit ? def.emit[ch] : 0;
  }
}

/**
 * Colored light for a rectangle of cells. Sunlight comes straight down, or at 45° at a cost
 * of one level per step, so it reaches a little way under overhangs and floating islands;
 * glowing blocks and a point light (the player) add their own colors; all of it then
 * spreads, cheaply through open cells and expensively through rock.
 */
export class LightField {
  x0 = 0;
  y0 = 0;
  w = 0;
  h = 0;
  /** Light levels 0–15 per channel, indexed [(x - x0) * h + (y - y0)]. */
  readonly rgb: [Int8Array, Int8Array, Int8Array] = [new Int8Array(0), new Int8Array(0), new Int8Array(0)];
  private blocks = new Uint8Array(0);
  private stamp = "";
  private buckets: number[][] = Array.from({ length: MAX_LIGHT + 1 }, () => []);

  /**
   * Recompute for a region, unless nothing that affects it has changed. `sun` is the
   * strength of sunlight at the top of the sky (0–15).
   */
  update(
    world: World,
    x0: number,
    y0: number,
    w: number,
    h: number,
    sun: number,
    lampX: number,
    lampY: number,
    lamp: readonly number[],
  ): void {
    const stamp = `${x0},${y0},${w},${h},${sun},${lampX},${lampY},${world.version},${world.campfireLit}`;
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.x0 = x0;
    this.y0 = y0;
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      for (let ch = 0; ch < 3; ch++) this.rgb[ch] = new Int8Array(w * h);
      this.blocks = new Uint8Array(w * h);
    }

    const blocks = this.blocks;
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) {
        const b = world.get(x0 + i, y0 + j);
        // A campfire that's out gives no light.
        blocks[i * h + j] = b === Block.Campfire && !world.campfireLit ? Block.Air : b;
      }
    }
    const lampI = lampX - x0;
    const lampJ = lampY - y0;
    const lampIndex = lampI >= 0 && lampI < w && lampJ >= 0 && lampJ < h ? lampI * h + lampJ : -1;

    const terrain = world.terrain;
    const startRow = Math.max(0, y0 - SUN_LOOKUP);
    let prev = new Int8Array(w);
    let cur = new Int8Array(w);
    for (let ch = 0; ch < 3; ch++) {
      const light = this.rgb[ch];
      const sunCost = SUN_COST[ch];
      const spreadCost = SPREAD_COST[ch];
      const emit = EMIT[ch];
      light.fill(0);

      // Sunlight. Above the traced rows, assume open sky wherever it is above ground.
      for (let i = 0; i < w; i++) prev[i] = startRow === 0 || startRow < terrain.height(x0 + i) - 2 ? sun : 0;
      for (let y = startRow; y < y0 + h && y < WORLD_H; y++) {
        const j = y - y0;
        for (let i = 0; i < w; i++) {
          // Straight down keeps its strength; a slanted step loses one level, so light
          // reaching in under an overhang fades the farther it goes.
          let from = prev[i];
          if (i > 0 && prev[i - 1] - 1 > from) from = prev[i - 1] - 1;
          if (i < w - 1 && prev[i + 1] - 1 > from) from = prev[i + 1] - 1;
          const b = j >= 0 ? blocks[i * h + j] : world.get(x0 + i, y);
          const level = from - sunCost[b];
          cur[i] = level > 0 ? level : 0;
          if (j >= 0 && level > 0) light[i * h + j] = level;
        }
        [prev, cur] = [cur, prev];
      }

      // Glowing blocks and the lamp.
      for (let n = 0; n < w * h; n++) {
        const e = emit[blocks[n]];
        if (e > light[n]) light[n] = e;
      }
      if (lampIndex >= 0 && lamp[ch] > light[lampIndex]) light[lampIndex] = lamp[ch];

      // Spread, brightest first.
      const buckets = this.buckets;
      for (let n = 0; n < w * h; n++) if (light[n] > 1) buckets[light[n]].push(n);
      for (let level = MAX_LIGHT; level > 1; level--) {
        const bucket = buckets[level];
        for (let q = 0; q < bucket.length; q++) {
          const n = bucket[q];
          if (light[n] !== level) continue;
          const j = n % h;
          const i = (n - j) / h;
          if (i > 0) this.relax(light, spreadCost, n - h, level);
          if (i < w - 1) this.relax(light, spreadCost, n + h, level);
          if (j > 0) this.relax(light, spreadCost, n - 1, level);
          if (j < h - 1) this.relax(light, spreadCost, n + 1, level);
        }
        bucket.length = 0;
      }
      buckets[1].length = 0;
    }
  }

  private relax(light: Int8Array, cost: Uint8Array, n: number, level: number): void {
    const next = level - cost[this.blocks[n]];
    if (next > light[n]) {
      light[n] = next;
      if (next > 1) this.buckets[next].push(n);
    }
  }

  /** Index of a world cell in the light arrays, or -1 outside the region. */
  index(x: number, y: number): number {
    const i = x - this.x0;
    const j = y - this.y0;
    return i >= 0 && i < this.w && j >= 0 && j < this.h ? i * this.h + j : -1;
  }
}

export const isEmissive = (b: Block): boolean => BLOCKS[b].emit !== null;
