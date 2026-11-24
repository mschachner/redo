import { Biome, BIOME_COUNT, BIOMES, CAPS, CORALS, CRYSTALS, DEEP_WATER, DEEP_WATER_FG, STRATA } from "./biomes";
import { Block, BLOCKS, RGB } from "./blocks";
import { fbm1, fbm2, hash2, noise1, rand2 } from "./noise";

export const CHUNK_W = 32;
export const WORLD_H = 240;
/** Row of the sea surface: open water fills terrain that dips below it. */
export const SEA = 108;
/** Every open cell at or below this row is flooded. */
export const DEEP_FLOOD = 208;

const BIOME_W = 200;
const BLEND = 26;
const AIR = Block.Air;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * How far into the wilds column x is: 0 at the origin, 1 at 2,000 cells out, 2 at 6,000,
 * 3 at 14,000, and so on, growing ever more slowly. Terrain and monsters scale with it.
 */
export function wildness(x: number): number {
  return Math.log2(1 + Math.abs(x) / 2000);
}
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/** Columns either side of the origin where the land is fully tame, and how far it takes to fade. */
const CALM_RADIUS = 30;
const CALM_FADE = 110;

/**
 * How tame the land is around the spawn, from 1 (near the origin: hills above the sea, few
 * overhangs, no cave mouths, small structures only) to 0 (generated as usual).
 */
export function calm(x: number): number {
  return 1 - smoothstep(Math.max(0, Math.min(1, (Math.abs(x) - CALM_RADIUS) / CALM_FADE)));
}
const frac = (v: number): number => v - Math.floor(v);

/** Small deterministic random stream (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One chunk's cells, addressed in world coordinates; writes outside the chunk are dropped. */
class Canvas {
  constructor(readonly x0: number, readonly data: Uint8Array) {}

  inside(x: number, y: number): boolean {
    return x >= this.x0 && x < this.x0 + CHUNK_W && y >= 0 && y < WORLD_H;
  }

  /** The block at a cell, or undefined outside this chunk. */
  get(x: number, y: number): Block | undefined {
    return this.inside(x, y) ? (this.data[(x - this.x0) * WORLD_H + y] as Block) : undefined;
  }

  set(x: number, y: number, b: Block): void {
    if (this.inside(x, y) && this.data[(x - this.x0) * WORLD_H + y] !== Block.Bedrock)
      this.data[(x - this.x0) * WORLD_H + y] = b;
  }

  /** Set a cell only if it is currently air. */
  fill(x: number, y: number, b: Block): void {
    if (this.get(x, y) === AIR) this.data[(x - this.x0) * WORLD_H + y] = b;
  }
}

interface Volcano {
  center: number;
  radius: number;
  height: number;
  crater: number;
}

/**
 * Procedural terrain. Everything here is a pure function of (seed, x, y), so chunks can be
 * generated in any order and structures can straddle chunk edges.
 */
export class Terrain {
  private heights = new Map<number, number>();
  private overhangs = new Map<number, number>();
  private biomes = new Map<number, Biome>();
  private blends = new Map<number, [Biome, Biome, number]>();
  private tops = new Map<number, number>();

  constructor(readonly seed: number) {}

  // ── Biome layout ─────────────────────────────────────────────────────

  private border(i: number): number {
    return i * BIOME_W + Math.round((rand2(this.seed + 90, i, 0) - 0.5) * 90);
  }

  /** Biomes come in shuffled runs of all eight, so every one turns up regularly. */
  private biomeOfCell(i: number): Biome {
    const block = Math.floor(i / BIOME_COUNT);
    const perm = this.permutation(block);
    // Keep a run from opening with either of the biomes the previous run closed with.
    // Only the first six places are touched, so each run's own ending stays as shuffled.
    const prev = this.permutation(block - 1);
    const a = prev[BIOME_COUNT - 2];
    const b = prev[BIOME_COUNT - 1];
    if (perm[0] === a || perm[0] === b) {
      let k = 1;
      while (perm[k] === a || perm[k] === b) k++;
      [perm[0], perm[k]] = [perm[k], perm[0]];
    }
    if (perm[1] === b) [perm[1], perm[2]] = [perm[2], perm[1]];
    return perm[i - block * BIOME_COUNT];
  }

  private permutation(block: number): Biome[] {
    const r = rng(hash2(this.seed + 91, block, 0));
    const p: Biome[] = [];
    for (let i = 0; i < BIOME_COUNT; i++) p.push(i);
    for (let i = BIOME_COUNT - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    return p;
  }

  /** The two biomes meeting at x and how far x is from the first toward the second (0–1). */
  private blend(x: number): [Biome, Biome, number] {
    let cached = this.blends.get(x);
    if (!cached) {
      cached = this.computeBlend(x);
      this.blends.set(x, cached);
    }
    return cached;
  }

  private computeBlend(x: number): [Biome, Biome, number] {
    let c = Math.floor(x / BIOME_W);
    if (x < this.border(c)) c--;
    else if (x >= this.border(c + 1)) c++;
    const left = this.border(c);
    const right = this.border(c + 1);
    const here = this.biomeOfCell(c);
    if (x - left < BLEND) return [this.biomeOfCell(c - 1), here, smoothstep(0.5 + (x - left) / (2 * BLEND))];
    if (right - x < BLEND) return [here, this.biomeOfCell(c + 1), smoothstep((x - (right - BLEND)) / (2 * BLEND))];
    return [here, here, 0];
  }

  /**
   * The region column x belongs to: the biome cell it lies in, or, in the patchy border
   * zone, the neighboring cell whose biome the column actually has.
   */
  regionAt(x: number): { index: number; biome: Biome } {
    let c = Math.floor(x / BIOME_W);
    if (x < this.border(c)) c--;
    else if (x >= this.border(c + 1)) c++;
    const biome = this.biomeAt(x);
    for (const i of [c, c - 1, c + 1]) if (this.biomeOfCell(i) === biome) return { index: i, biome };
    return { index: c, biome };
  }

  /** The biome of a column. Near a border the two biomes interleave in patches. */
  biomeAt(x: number): Biome {
    let b = this.biomes.get(x);
    if (b === undefined) {
      const [a, c, t] = this.blend(x);
      b = t > 0.15 + 0.7 * noise1(this.seed + 92, x / 4) ? c : a;
      this.biomes.set(x, b);
    }
    return b;
  }

  /** Like biomeAt, but near a border the patches also vary with depth, for rock underground. */
  private biomeAtDepth(x: number, y: number): Biome {
    const [a, b, t] = this.blend(x);
    if (a === b) return a;
    return t > 0.2 + 0.6 * fbm2(this.seed + 93, x / 7, y / 7, 2) ? b : a;
  }

  skyColor(x: number): RGB {
    return this.mix(x, (b) => BIOMES[b].sky);
  }

  daySkyColor(x: number): RGB {
    return this.mix(x, (b) => BIOMES[b].daySky);
  }

  starColor(x: number): RGB {
    return this.mix(x, (b) => BIOMES[b].star);
  }

  private mix(x: number, pick: (b: Biome) => RGB): RGB {
    const [a, b, t] = this.blend(x);
    const ca = pick(a);
    if (a === b) return ca;
    const cb = pick(b);
    return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
  }

  waterColor(x: number, y: number): [RGB, RGB] {
    if (y >= DEEP_FLOOD) return [DEEP_WATER, DEEP_WATER_FG];
    const def = BIOMES[this.biomeAt(x)];
    return [def.water, def.waterFg];
  }

  /** Color of the rock face behind open underground cells. */
  wallBlock(x: number, y: number): Block {
    return y >= this.deepLine(x) ? Block.Deepstone : BIOMES[this.biomeAtDepth(x, y)].stone;
  }

  // ── Surface shape ────────────────────────────────────────────────────

  /** Signed fractal noise in about [-1, 1]. */
  private s1(salt: number, x: number, octaves: number): number {
    return (fbm1(this.seed + salt, x, octaves) - 0.5) * 2;
  }

  private biomeHeight(b: Biome, x: number): number {
    const s = this.seed;
    switch (b) {
      case Biome.Fungal:
        return 97 + 13 * this.s1(101, x / 64, 3);
      case Biome.Crystal: {
        // Isolated sharp peaks over a rough plain.
        const n = fbm1(s + 102, x / 38, 2);
        const peak = Math.max(0, 1 - Math.abs(2 * n - 1) * 3.2);
        return 104 - 22 * Math.pow(peak, 1.4) + 3 * this.s1(103, x / 9, 2);
      }
      case Biome.Coral: {
        const n = fbm1(s + 104, x / 30, 2);
        const mound = Math.max(0, 1 - Math.abs(2 * n - 1) * 3);
        return 125 + 6 * this.s1(105, x / 55, 3) - 7 * mound * mound;
      }
      case Biome.Ember:
        return 99 + 8 * this.s1(106, x / 55, 3) - this.volcanoLift(x);
      case Biome.Dunes: {
        // Asymmetric crests: a long windward slope and a short lee slope.
        const u = frac((x + 14 * this.s1(107, x / 130, 2)) / 36);
        const d = u < 0.72 ? u / 0.72 : (1 - u) / 0.28;
        return 102 - 10 * Math.pow(d, 1.4) * (0.55 + 0.9 * fbm1(s + 108, x / 85, 1)) + 3 * this.s1(109, x / 100, 2);
      }
      case Biome.Tangle:
        return 95 + 15 * this.s1(110, x / 52, 3);
      case Biome.Mesa: {
        // Flat terraces joined by steep risers; the lowest ones sit below sea level.
        const v = (fbm1(s + 111, x / 95, 3) - 0.2) * 9;
        const f = Math.floor(v);
        const t = f + smoothstep(clamp01((v - f - 0.78) / 0.22));
        return 126 - 11 * Math.max(0, Math.min(5.5, t)) + 1.2 * this.s1(112, x / 7, 1);
      }
      case Biome.Frost:
        return 95 + 11 * this.s1(113, x / 58, 3) + (16 * Math.max(0, fbm1(s + 114, x / 90, 2) - 0.56)) / 0.44;
    }
  }

  volcanoAt(g: number): Volcano | undefined {
    const s = this.seed + 120;
    if (rand2(s, g, 0) > 0.75) return undefined;
    const radius = 22 + rand2(s, g, 2) * 10;
    return {
      center: g * 170 + 40 + Math.floor(rand2(s, g, 1) * 90),
      radius,
      height: 20 + rand2(s, g, 3) * 10,
      crater: 4 + Math.floor(rand2(s, g, 4) * 3),
    };
  }

  private volcanoLift(x: number): number {
    const g = Math.floor(x / 170);
    let lift = 0;
    for (let i = g - 1; i <= g + 1; i++) {
      const v = this.volcanoAt(i);
      if (!v) continue;
      const d = Math.abs(x - v.center);
      if (d >= v.radius) continue;
      const cone = v.height * (1 - d / v.radius);
      const rim = v.height * (1 - v.crater / v.radius);
      lift = Math.max(lift, d < v.crater ? rim - (v.crater - d) * 1.7 : cone);
    }
    return lift;
  }

  /**
   * Nominal row of the ground surface in column x. Out in the wilds the relief is
   * exaggerated and an extra layer of bumps is added.
   */
  height(x: number): number {
    let h = this.heights.get(x);
    if (h === undefined) {
      const [a, b, t] = this.blend(x);
      const ha = this.biomeHeight(a, x);
      const base = a === b ? ha : ha + (this.biomeHeight(b, x) - ha) * t;
      const w = wildness(x);
      const wild = 100 + (base - 100) * (1 + 0.3 * w) + 5 * w * this.s1(115, x / 36, 2);
      // Near the spawn, keep 40% of the biome's own shape (lifted above the sea) and make
      // the rest rolling hills.
      const k = calm(x);
      const hills = 99 + 6 * this.s1(116, x / 30, 3);
      const target = 0.4 * Math.min(wild, SEA - 4) + 0.6 * hills;
      const tame = wild + (target - wild) * k;
      h = Math.round(Math.max(26, Math.min(186, tame)));
      this.heights.set(x, h);
    }
    return h;
  }

  /** Overhang noise strength in column x; fades to zero near and under the sea. */
  private overhang(x: number): number {
    let k = this.overhangs.get(x);
    if (k === undefined) {
      const [a, b, t] = this.blend(x);
      const ka = BIOMES[a].overhang;
      k =
        (ka + (BIOMES[b].overhang - ka) * t + 2.2 * wildness(x)) *
        clamp01((SEA - 3 - this.height(x)) / 6) *
        (1 - 0.6 * calm(x));
      this.overhangs.set(x, k);
    }
    return k;
  }

  /** Whether a cell is ground before caves and structures. */
  private solidBase(x: number, y: number): boolean {
    const d = y - this.height(x);
    const k = this.overhang(x);
    if (k < 0.01) return d >= 0;
    if (d >= k * 1.3) return true;
    if (d <= -k * 1.3) return false;
    return d + k * (fbm2(this.seed + 130, x / 17, y / 12, 3) - 0.5) * 2.6 >= 0;
  }

  /** Row of the topmost ground cell in column x, ignoring caves and structures. */
  groundTop(x: number): number {
    let top = this.tops.get(x);
    if (top === undefined) {
      top = Math.floor(this.height(x) - this.overhang(x) * 1.3) - 1;
      while (!this.solidBase(x, top)) top++;
      this.tops.set(x, top);
    }
    return top;
  }

  /** Open sea: cells below the sea surface and above the sea bed. */
  private isOcean(x: number, y: number): boolean {
    return y >= SEA && y < this.height(x) && y < DEEP_FLOOD;
  }

  /** Top row of the deep zone in column x. */
  deepLine(x: number): number {
    return 196 + Math.round(5 * this.s1(140, x / 40, 2));
  }

  private strataAt(x: number, y: number): Block {
    const band = Math.floor((y + 2.5 * this.s1(141, x / 45, 2)) / 3);
    return STRATA[hash2(this.seed + 142, band, 0) % STRATA.length];
  }

  // ── Chunk generation ─────────────────────────────────────────────────

  generateChunk(cx: number): Uint8Array {
    const x0 = cx * CHUNK_W;
    const c = new Canvas(x0, new Uint8Array(CHUNK_W * WORLD_H));
    for (let x = x0; x < x0 + CHUNK_W; x++) this.baseColumn(c, x);
    for (let x = x0; x < x0 + CHUNK_W; x++) this.decorateColumn(c, x);
    this.structures(c);
    for (let x = x0; x < x0 + CHUNK_W; x++) this.waterColumn(c, x);
    this.pickups(c);
    return c.data;
  }

  /** Ground, layering and caves for one column. */
  private baseColumn(c: Canvas, x: number): void {
    const s = this.seed;
    const h = this.height(x);
    const k = this.overhang(x);
    const biome = this.biomeAt(x);
    const def = BIOMES[biome];
    const near = h + k * 1.3 + 2;
    const submerged = h > SEA;
    const turf = submerged ? (biome === Biome.Mesa ? Block.Silt : def.soil) : def.turf;
    const bedrock = WORLD_H - 2 - Math.floor(rand2(s + 41, x, 0) * 3);

    let prevAir = true;
    let cover = 0;
    for (let y = Math.max(0, Math.floor(h - k * 1.3) - 1); y < WORLD_H; y++) {
      if (y >= bedrock) {
        c.data[(x - c.x0) * WORLD_H + y] = Block.Bedrock;
        continue;
      }
      if (!this.solidBase(x, y) || this.cave(x, y, h, submerged || h >= SEA - 3)) {
        prevAir = true;
        cover = 0;
        continue;
      }
      let b: Block;
      if (prevAir && y <= near) {
        b = turf;
        cover = def.soilDepth;
      } else if (cover > 0) {
        b = def.soil;
        cover--;
      } else {
        b = this.stoneAt(x, y, h, this.biomeAtDepth(x, y));
      }
      prevAir = false;
      c.set(x, y, b);
    }
  }

  private cave(x: number, y: number, h: number, nearSea: boolean): boolean {
    if (y >= WORLD_H - 7) return false;
    const s = this.seed;
    const depth = y - h;
    const d = Math.max(0, depth);
    const w = Math.min(wildness(x), 4);
    const worm = Math.abs(fbm2(s + 200, x / 34, y / 22, 3) - 0.5) < 0.018 + Math.min(d, 80) * 0.0002 + 0.003 * w;
    // Winding tunnels may open onto the surface; everything else stays buried. Near the
    // spawn nothing opens onto the surface, and caves start deeper.
    const k = calm(x);
    if (depth < (nearSea ? 5 : worm && k === 0 ? -99 : 4) + Math.round(10 * k)) return false;
    if (worm) return true;
    // Caverns grow larger in a band above the deep.
    const mid = clamp01((y - 146) / 14) * clamp01((204 - y) / 10);
    if (fbm2(s + 100, x / 20, y / 12, 3) > 0.685 - Math.min(d, 60) * 0.0005 - 0.02 * mid - 0.012 * w) return true;
    return mid > 0 && fbm2(s + 210, x / 60, y / 28, 2) > 0.75 - 0.05 * mid;
  }

  private stoneAt(x: number, y: number, h: number, biome: Biome): Block {
    const s = this.seed;
    if (y >= this.deepLine(x)) return rand2(s + 150, x, y) < 0.03 ? Block.Starstone : Block.Deepstone;
    const depth = y - h;
    switch (biome) {
      case Biome.Fungal:
        if (depth > 6 && fbm2(s + 151, x / 7, y / 7, 2) > 0.74) return Block.Glowmoss;
        if (fbm2(s + 152, x / 10, y / 6, 2) > 0.68) return Block.Loam;
        break;
      case Biome.Crystal:
        if (depth > 5 && fbm2(s + 153, x / 6, y / 6, 2) > 0.76)
          return CRYSTALS[hash2(s + 154, Math.floor(x / 24), Math.floor(y / 24)) % CRYSTALS.length];
        if (fbm2(s + 155, x / 12, y / 5, 2) > 0.7) return Block.Chalk;
        break;
      case Biome.Coral:
        if (rand2(s + 156, x, y) < 0.008) return Block.Pearl;
        if (fbm2(s + 157, x / 8, y / 8, 2) > 0.72) return Block.Silt;
        break;
      case Biome.Ember:
        if (depth > 8 && fbm2(s + 158, x / 10, y / 7, 2) > 0.73) return Block.Magma;
        if (fbm2(s + 159, x / 5, y / 5, 2) > 0.7) return Block.Emberstone;
        if (fbm2(s + 160, x / 14, y / 10, 2) > 0.7) return Block.Obsidian;
        break;
      case Biome.Dunes:
        if (fbm2(s + 161, x / 3, y / 10, 2) > 0.78) return Block.Bone;
        if (fbm2(s + 162, x / 11, y / 6, 2) > 0.71) return Block.Salt;
        break;
      case Biome.Tangle:
        if (depth > 6 && fbm2(s + 163, x / 7, y / 7, 2) > 0.75) return Block.Glowmoss;
        if (fbm2(s + 164, x / 9, y / 9, 2) > 0.69) return Block.Peat;
        break;
      case Biome.Mesa:
        if (depth < 46) return this.strataAt(x, y);
        break;
      case Biome.Frost:
        if (fbm2(s + 165, x / 8, y / 6, 2) > 0.69) return rand2(s + 166, x, y) < 0.14 ? Block.LumenIce : Block.Ice;
        break;
    }
    return BIOMES[biome].stone;
  }

  /** Plants, hanging strands, cave teeth and crystal growths. Works within one column. */
  private decorateColumn(c: Canvas, x: number): void {
    const s = this.seed;
    const biome = this.biomeAt(x);
    const h = this.height(x);
    const col = c.data.slice((x - c.x0) * WORLD_H, (x - c.x0 + 1) * WORLD_H);
    const at = (y: number): Block => (y >= 0 && y < WORLD_H ? (col[y] as Block) : Block.Bedrock);
    const isRock = (b: Block): boolean => BLOCKS[b].solid && b !== Block.Bedrock;
    const airBelow = (y: number): number => {
      let n = 0;
      while (n < 14 && at(y + n) === AIR) n++;
      return n;
    };
    const airAbove = (y: number): number => {
      let n = 0;
      while (n < 14 && at(y - n) === AIR) n++;
      return n;
    };

    let ground = 1;
    while (ground < WORLD_H && !BLOCKS[at(ground)].solid) ground++;

    // Surface growth.
    const r = rand2(s + 400, x, 0);
    const r2 = rand2(s + 401, x, 0);
    if (ground > SEA + 1) {
      const room = ground - SEA - 2;
      if (r < (biome === Biome.Coral ? 0.24 : 0.08)) {
        const len = Math.min(room, 2 + Math.floor(r2 * 9));
        for (let i = 1; i <= len; i++) c.fill(x, ground - i, Block.Kelp);
      } else if (r < 0.31) {
        const len = Math.min(room, 1 + Math.floor(r2 * 3));
        for (let i = 1; i <= len; i++) c.fill(x, ground - i, Block.Glowweed);
      } else if (r < (biome === Biome.Coral ? 0.37 : 0.33) && room > 0) {
        c.fill(x, ground - 1, r2 < 0.6 ? Block.Anemone : Block.Pearl);
      }
    } else if (ground <= SEA - 1) {
      if (biome === Biome.Fungal && r < 0.15) c.fill(x, ground - 1, Block.Shroomlet);
      else if (biome === Biome.Frost && r < 0.1) c.fill(x, ground - 1, Block.Frostflower);
      else if (biome === Biome.Tangle && r < 0.05) c.fill(x, ground - 1, Block.Shroomlet);
      else if (biome === Biome.Crystal && r < 0.06) c.fill(x, ground - 1, CRYSTALS[Math.floor(r2 * CRYSTALS.length)]);
      else if (biome === Biome.Ember && r < 0.04) c.fill(x, ground - 1, Block.Emberstone);
    }

    for (let y = ground + 1; y < WORLD_H - 8; y++) {
      if (at(y) !== AIR) continue;
      const depth = y - h;
      const hangs = isRock(at(y - 1));
      const stands = isRock(at(y + 1));

      if (hangs) {
        const gap = airBelow(y);
        if (depth < 8) {
          // Under surface overhangs: vines in the tangle, glowing roots elsewhere.
          const strand = biome === Biome.Tangle ? Block.Vine : Block.Glowroot;
          if (rand2(s + 410, x, y) < (biome === Biome.Tangle ? 0.5 : 0.12)) {
            const len = Math.min(gap - 1, 1 + Math.floor(rand2(s + 411, x, y) * 5));
            for (let i = 0; i < len; i++) c.fill(x, y + i, strand);
          }
        } else if (fbm2(s + 300, x / 30, y / 30, 2) > 0.5) {
          const len = Math.min(Math.floor((gap - 2) / 2), Math.floor(Math.max(0, rand2(s + 301, x, y) - 0.42) * 9));
          for (let i = 0; i < len; i++) c.fill(x, y + i, at(y - 1));
        } else if (y < DEEP_FLOOD - 4 && fbm2(s + 310, x / 8, y / 8, 2) > 0.64) {
          const len = Math.min(gap - 2, 1 + Math.floor(rand2(s + 311, x, y) * 4));
          for (let i = 0; i < len; i++) c.fill(x, y + i, Block.Glowroot);
        }
      }

      if (stands && depth >= 8) {
        const gap = airAbove(y);
        const cluster = this.crystalCluster(x, y);
        if (cluster) {
          const len = Math.min(gap - 1, cluster.height);
          for (let i = 0; i < len; i++) c.fill(x, y - i, cluster.block);
        } else if (fbm2(s + 300, x / 30, y / 30, 2) > 0.5 && rand2(s + 302, x, y) > 0.5) {
          const len = Math.min(Math.floor((gap - 2) / 2), Math.floor((rand2(s + 302, x, y) - 0.5) * 8));
          for (let i = 0; i < len; i++) c.fill(x, y - i, at(y + 1));
        } else if (y >= DEEP_FLOOD) {
          if (rand2(s + 320, x, y) < 0.16) {
            const len = Math.min(gap - 1, 1 + Math.floor(rand2(s + 321, x, y) * 4));
            for (let i = 0; i < len; i++) c.fill(x, y - i, Block.Glowweed);
          }
        } else {
          const lush = biome === Biome.Fungal || biome === Biome.Tangle;
          if (!BLOCKS[at(y + 1)].emit && fbm2(s + 330, x / 9, y / 9, 2) > (lush ? 0.58 : 0.66))
            c.set(x, y + 1, Block.Glowmoss);
          if (biome === Biome.Fungal && rand2(s + 331, x, y) < 0.16) c.fill(x, y, Block.Shroomlet);
        }
      }
    }
  }

  /** Crystal growths on cave floors: clusters a few columns wide, tallest in the middle. */
  private crystalCluster(x: number, y: number): { height: number; block: Block } | undefined {
    const s = this.seed + 340;
    const g = Math.floor(x / 23);
    for (let i = g - 1; i <= g + 1; i++) {
      const center = i * 23 + Math.floor(rand2(s, i, 0) * 23);
      const width = 2 + Math.floor(rand2(s, i, 1) * 4);
      if (Math.abs(x - center) > width) continue;
      if (rand2(s, i, 2) > (this.biomeAt(center) === Biome.Crystal ? 0.9 : 0.4)) continue;
      const band = 118 + Math.floor(rand2(s, i, 3) * 80);
      if (y < band || y > band + 45) continue;
      const peak = 3 + Math.floor(rand2(s, i, 4) * 6);
      const height = Math.round(peak * (1 - Math.abs(x - center) / (width + 1)) + rand2(s, x, 5) * 1.5);
      return { height, block: CRYSTALS[hash2(s, i, 6) % CRYSTALS.length] };
    }
    return undefined;
  }

  /** Open sea, the flooded deep, frozen lake lids, and plugs for holes that would leak. */
  private waterColumn(c: Canvas, x: number): void {
    const biome = this.biomeAt(x);
    for (let y = SEA; y < WORLD_H; y++) {
      if (c.get(x, y) !== AIR) continue;
      if (y >= DEEP_FLOOD) c.set(x, y, Block.Water);
      else if (this.isOcean(x, y)) c.set(x, y, biome === Biome.Frost && y === SEA ? Block.Ice : Block.Water);
      else if (this.isOcean(x - 1, y) || this.isOcean(x + 1, y) || this.isOcean(x, y - 1))
        c.set(x, y, BIOMES[biome].stone);
    }
  }

  // ── Structures ───────────────────────────────────────────────────────

  /** Size multiplier for structures: they grow larger out in the wilds (capped at 1.6×). */
  private grow(x: number): number {
    return Math.min(1.6, 1 + 0.15 * wildness(x));
  }

  /**
   * Visit one candidate anchor per `spacing` columns, for every anchor close enough to
   * reach this chunk. Each anchor gets its own random stream, so a structure comes out the
   * same from whichever chunk it is stamped.
   */
  /**
   * Visit structure anchors spaced about `spacing` apart. Toward the spawn, anchors are
   * skipped with probability `calm × tame`: 1 keeps a structure away from it entirely.
   */
  private anchors(
    c: Canvas,
    spacing: number,
    salt: number,
    reach: number,
    visit: (x: number, r: () => number) => void,
    tame = 1,
  ): void {
    const g0 = Math.floor((c.x0 - reach) / spacing);
    const g1 = Math.floor((c.x0 + CHUNK_W + reach) / spacing);
    for (let g = g0; g <= g1; g++) {
      const x = g * spacing + Math.floor(rand2(this.seed + salt, g, 1) * spacing);
      // Fewer structures toward the spawn.
      if (rand2(this.seed + salt, g, 3) < calm(x) * tame) continue;
      visit(x, rng(hash2(this.seed + salt, g, 2)));
    }
  }

  /**
   * Stack pickups, each on the floor of an open cell: day slots fairly often, half on the
   * surface and half in caves; keep slots rarely, always underground.
   */
  private pickups(c: Canvas): void {
    this.anchors(c, 48, 700, 0, (x, r) => {
      if (r() < 0.4) return;
      this.placePickup(c, x, r() < 0.5 ? undefined : 14 + Math.floor(r() * 120), Block.DayStack);
    }, 0);
    this.anchors(c, 420, 710, 0, (x, r) => {
      if (r() < 0.45) return;
      this.placePickup(c, x, 24 + Math.floor(r() * 150), Block.KeepStack);
    }, 0);
  }

  /**
   * Put a pickup in column x: on the surface if `depth` is undefined, else in the first open
   * cell with solid ground under it, searching down from `depth` rows below the surface.
   */
  private placePickup(c: Canvas, x: number, depth: number | undefined, b: Block): void {
    if (!c.inside(x, 0)) return;
    const solidAt = (y: number): boolean => BLOCKS[c.get(x, y) ?? Block.Bedrock].solid;
    const top = this.height(x);
    let y = depth === undefined ? Math.max(1, top - 40) : top + depth;
    for (; y < WORLD_H - 8; y++) {
      if (c.get(x, y) === AIR && solidAt(y + 1)) {
        c.set(x, y, b);
        return;
      }
      // On the surface, stop at the first ground reached.
      if (depth === undefined && solidAt(y)) return;
    }
  }

  private structures(c: Canvas): void {
    this.anchors(c, 64, 500, 24, (x, r) => this.skyIsland(c, x, r));
    this.geodes(c);
    this.craterPools(c);
    this.anchors(c, 70, 510, 20, (x, r) => this.arch(c, x, r));
    // The smaller kinds can still turn up near the spawn.
    this.anchors(c, 11, 520, 12, (x, r) => this.mushroom(c, x, r), 0.6);
    this.anchors(c, 9, 530, 16, (x, r) => this.crystalSpire(c, x, r), 0.6);
    this.anchors(c, 7, 540, 10, (x, r) => this.coral(c, x, r), 0.6);
    this.anchors(c, 16, 550, 10, (x, r) => this.basaltColumns(c, x, r), 0.6);
    this.anchors(c, 15, 560, 10, (x, r) => this.obsidianShard(c, x, r));
    this.anchors(c, 52, 570, 40, (x, r) => this.ribCage(c, x, r));
    this.anchors(c, 21, 580, 4, (x, r) => this.saltPillar(c, x, r), 0.6);
    this.anchors(c, 9, 590, 12, (x, r) => this.tangleTree(c, x, r));
    this.anchors(c, 13, 600, 6, (x, r) => this.hoodoo(c, x, r), 0.6);
    this.anchors(c, 7, 610, 14, (x, r) => this.iceSpike(c, x, r), 0.6);
  }

  /** A tapering spike from (bx, by) at `angle` radians off vertical. */
  private shard(c: Canvas, bx: number, by: number, length: number, angle: number, width: number, block: Block, core?: Block, r?: () => number): void {
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    for (let t = -2; t <= length; t += 0.5) {
      const cx = Math.round(bx + sin * t);
      const cy = Math.round(by - cos * t);
      const half = width * (1 - Math.max(0, t) / length);
      for (let dx = -Math.ceil(half); dx <= Math.ceil(half); dx++) {
        if (Math.abs(dx) <= half) c.fill(cx + dx, cy, block);
      }
      if (core && r && t > 0 && t < length - 2 && t % 1 === 0 && r() < 0.3) c.set(cx, cy, core);
    }
  }

  private mushroom(c: Canvas, x: number, r: () => number): void {
    if (this.biomeAt(x) !== Biome.Fungal || r() > 0.62) return;
    const ground = this.groundTop(x);
    if (ground > SEA - 1) return;
    const tall = Math.round((4 + Math.floor(r() * r() * 15)) * this.grow(x));
    const radius = Math.min(7, 2 + Math.floor(tall / 3 + r() * 1.5));
    const cap = CAPS[Math.floor(r() * CAPS.length)];
    const base = ground - tall;
    const wide = tall >= 11 ? 1 : 0;

    for (let y = base + 1; y <= ground + 2; y++) {
      for (let dx = 0; dx <= wide; dx++) {
        if (y < ground) c.set(x + dx, y, Block.Stalk);
        else c.fill(x + dx, y, Block.Stalk);
      }
    }
    const dome = Math.max(2, Math.round(radius * 0.7));
    for (let dx = -radius; dx <= radius + wide; dx++) {
      const u = (dx - wide / 2) / (radius + wide / 2 + 0.5);
      const top = base - Math.round(dome * Math.sqrt(Math.max(0, 1 - u * u)));
      for (let y = top; y <= base; y++) c.fill(x + dx, y, cap);
      const rim = dx === -radius || dx === radius + wide;
      if (rim) {
        if (r() < 0.7) c.fill(x + dx, base + 1, Block.Sporelight);
      } else {
        c.fill(x + dx, base + 1, Block.Gills);
      }
    }
  }

  private crystalSpire(c: Canvas, x: number, r: () => number): void {
    if (this.biomeAt(x) !== Biome.Crystal || r() > 0.6) return;
    const ground = this.groundTop(x);
    const length = Math.round((4 + Math.floor(r() * r() * 19)) * this.grow(x));
    const block = CRYSTALS[Math.floor(r() * CRYSTALS.length)];
    this.shard(c, x, ground, length, (r() - 0.5) * 1.1, 0.8 + length / 9, block);
    if (r() < 0.55) this.shard(c, x + (r() < 0.5 ? -2 : 2), ground, length * 0.5, (r() - 0.5) * 1.6, 0.8, block);
  }

  private coral(c: Canvas, x: number, r: () => number): void {
    const p = r();
    if (p > (this.biomeAt(x) === Biome.Coral ? 0.7 : 0.2)) return;
    const ground = this.groundTop(x);
    const room = ground - SEA - 2;
    if (room < 3) return;
    const block = CORALS[Math.floor(r() * CORALS.length)];
    const grow = (bx: number, by: number, len: number, lean: number, depth: number): void => {
      let cx = bx;
      let cy = by;
      for (let i = 0; i < len && cy > SEA + 1; i++) {
        c.fill(cx, cy, block);
        if (r() < 0.3 + Math.abs(lean) * 0.3) {
          cx += lean !== 0 ? Math.sign(lean) : r() < 0.5 ? -1 : 1;
          c.fill(cx, cy, block);
        }
        if (depth < 2 && i > 0 && r() < 0.3) grow(cx, cy, Math.ceil((len - i) * 0.7), r() < 0.5 ? -1 : 1, depth + 1);
        cy--;
      }
      const tip = r();
      if (cy > SEA) c.fill(cx, cy, tip < 0.35 ? Block.Anemone : tip < 0.45 ? Block.Pearl : block);
    };
    grow(x, ground - 1, Math.min(room, 3 + Math.floor(r() * 10)), 0, 0);
  }

  private basaltColumns(c: Canvas, x: number, r: () => number): void {
    if (this.biomeAt(x) !== Biome.Ember || r() > 0.5) return;
    const width = 4 + Math.floor(r() * 6);
    const peak = 4 + Math.floor(r() * 9);
    for (let i = 0; i < width; i++) {
      const cx = x + i - Math.floor(width / 2);
      const ground = this.groundTop(cx);
      const t = 1 - Math.abs(i - (width - 1) / 2) / (width / 2 + 0.5);
      const tall = Math.round(peak * t * (0.55 + 0.45 * r()));
      const ember = r() < 0.25;
      if (ground > SEA + 2) continue;
      for (let y = ground - tall; y <= ground + 1; y++) c.set(cx, y, Block.Basalt);
      if (ember) c.set(cx, ground - tall, Block.Emberstone);
    }
  }

  private obsidianShard(c: Canvas, x: number, r: () => number): void {
    if (this.biomeAt(x) !== Biome.Ember || r() > 0.4) return;
    const length = 4 + Math.floor(r() * 8);
    this.shard(c, x, this.groundTop(x), length, (r() - 0.5) * 1.3, 0.7 + length / 10, Block.Obsidian);
  }

  /** Pools of magma in the craters of the ember wastes' volcanoes. */
  private craterPools(c: Canvas): void {
    const g0 = Math.floor((c.x0 - 60) / 170);
    const g1 = Math.floor((c.x0 + CHUNK_W + 60) / 170);
    for (let g = g0; g <= g1; g++) {
      const v = this.volcanoAt(g);
      if (!v || calm(v.center) > 0) continue;
      const a = v.center - v.crater;
      const b = v.center + v.crater;
      if (this.biomeAt(a - 2) !== Biome.Ember || this.biomeAt(b + 2) !== Biome.Ember) continue;
      const level = Math.max(this.height(a - 1), this.height(b + 1)) + 1;
      for (let x = a; x <= b; x++) {
        for (let y = level; y < this.height(x) + 2; y++) c.set(x, y, Block.Magma);
      }
    }
  }

  /** A row of curved bone ribs rising from the dunes, with a spine along the ground. */
  private ribCage(c: Canvas, x: number, r: () => number): void {
    if (this.biomeAt(x) !== Biome.Dunes || r() > 0.65) return;
    const count = 3 + Math.floor(r() * 4);
    const gap = 3 + Math.floor(r() * 2);
    const dir = r() < 0.5 ? -1 : 1;
    const scale = 7 + r() * 6;
    for (let i = 0; i < count; i++) {
      const bx = x + i * gap;
      const ground = this.groundTop(bx);
      if (ground > SEA) continue;
      const tall = Math.round(scale * (0.5 + 0.5 * Math.sin((Math.PI * (i + 0.5)) / count)));
      const reach = Math.round(tall * 0.7);
      const steps = tall * 4;
      for (let j = 0; j <= steps; j++) {
        const ang = (j / steps) * Math.PI * 0.72;
        c.fill(bx + dir * Math.round(reach * (1 - Math.cos(ang))), ground + 1 - Math.round(tall * Math.sin(ang)), Block.Bone);
      }
      c.set(bx, ground, Block.Bone);
    }
    for (let sx = x - 2; sx <= x + (count - 1) * gap + 2; sx++) {
      if (r() < 0.85) c.set(sx, this.groundTop(sx), Block.Bone);
    }
  }

  private saltPillar(c: Canvas, x: number, r: () => number): void {
    if (this.biomeAt(x) !== Biome.Dunes || r() > 0.3) return;
    const ground = this.groundTop(x);
    if (ground > SEA) return;
    const tall = 3 + Math.floor(r() * 6);
    for (let y = ground - tall; y <= ground; y++) c.set(x, y, Block.Salt);
    c.fill(x - 1, ground - tall, Block.Salt);
    c.fill(x + 1, ground - tall, Block.Salt);
    if (r() < 0.5) c.fill(x, ground - tall - 1, Block.Salt);
  }

  /** A leaning trunk with frond clumps and bulb lanterns hanging on vines. */
  private tangleTree(c: Canvas, x: number, r: () => number): void {
    if (this.biomeAt(x) !== Biome.Tangle || r() > 0.7) return;
    const ground = this.groundTop(x);
    if (ground >= SEA) return;
    const tall = Math.round((6 + Math.floor(r() * 11)) * this.grow(x));
    const sway = r() * 3.2;
    const freq = 0.6 + r() * 0.9;
    const phase = r() * Math.PI * 2;
    const offset = (t: number): number =>
      Math.round(sway * (Math.sin(phase + (t / tall) * Math.PI * 2 * freq) - Math.sin(phase)));

    let px = x;
    for (let t = -2; t <= tall; t++) {
      const cx = x + offset(Math.max(0, t));
      if (t < 0) c.fill(cx, ground - t, Block.Vinewood);
      else {
        c.set(cx, ground - t, Block.Vinewood);
        if (cx !== px) c.set(px, ground - t, Block.Vinewood);
      }
      px = cx;
    }
    const clumps = 1 + Math.floor(r() * 3);
    for (let i = 0; i < clumps; i++) {
      const t = i === 0 ? tall : Math.floor(tall * (0.5 + r() * 0.4));
      const cx = x + offset(t) + (i === 0 ? 0 : (r() < 0.5 ? -1 : 1) * (2 + Math.floor(r() * 2)));
      const cy = ground - t - (i === 0 ? 1 : 0);
      const rx = 2 + Math.floor(r() * 3);
      const ry = 1 + Math.floor(r() * 2);
      for (let dx = -rx; dx <= rx; dx++) {
        for (let dy = -ry; dy <= ry; dy++) {
          if ((dx * dx) / ((rx + 0.4) * (rx + 0.4)) + (dy * dy) / ((ry + 0.4) * (ry + 0.4)) <= 1) c.fill(cx + dx, cy + dy, Block.Frond);
        }
      }
      if (r() < 0.75) {
        const lx = cx + Math.round((r() - 0.5) * 2 * (rx - 1));
        const len = Math.floor(r() * 4);
        for (let j = 1; j <= len; j++) c.fill(lx, cy + ry + j, Block.Vine);
        c.fill(lx, cy + ry + len + 1, Block.BulbLantern);
      }
    }
  }

  /** A banded rock pillar with a wider capstone. */
  private hoodoo(c: Canvas, x: number, r: () => number): void {
    if (this.biomeAt(x) !== Biome.Mesa || r() > 0.45) return;
    const ground = this.groundTop(x);
    const tall = Math.round((4 + Math.floor(r() * 11)) * this.grow(x));
    const wide = tall > 9 ? 1 : 0;
    for (let y = ground - tall; y <= ground + 1; y++) {
      for (let dx = 0; dx <= wide; dx++) c.fill(x + dx, y, this.strataAt(x + dx, y));
    }
    const top = ground - tall - 1;
    for (let dx = -1; dx <= wide + 1; dx++) c.fill(x + dx, top, this.strataAt(x + dx, top));
    if (r() < 0.6) for (let dx = 0; dx <= wide; dx++) c.fill(x + dx, top - 1, Block.Lichen);
  }

  /** A freestanding stone arch. */
  private arch(c: Canvas, x: number, r: () => number): void {
    const biome = this.biomeAt(x);
    if ((biome !== Biome.Mesa && biome !== Biome.Tangle && biome !== Biome.Dunes) || r() > 0.6) return;
    const rx = 6 + Math.floor(r() * 7);
    const ry = 5 + Math.floor(r() * 6);
    const thick = 2 + Math.floor(r() * 2);
    const base = Math.max(this.groundTop(x - rx - 1), this.groundTop(x + rx + 1));
    if (base > SEA + 6 || Math.abs(this.groundTop(x - rx - 1) - this.groundTop(x + rx + 1)) > 9) return;
    const rock = (cx: number, cy: number): Block =>
      biome === Biome.Mesa ? this.strataAt(cx, cy) : biome === Biome.Tangle ? Block.Tealstone : Block.Duneshale;
    const top = biome === Biome.Mesa ? Block.Lichen : biome === Biome.Tangle ? Block.Bluemoss : Block.Tealsand;
    for (let dx = -rx - thick; dx <= rx + thick; dx++) {
      let first = true;
      for (let dy = ry + thick; dy >= -8; dy--) {
        const u = dx / (rx + thick);
        const v = Math.max(0, dy) / (ry + thick);
        if (u * u + v * v > 1) continue;
        if (dy >= 0 && (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) < 1) continue;
        if (dy < 0 && Math.abs(dx) < rx) continue;
        if (c.get(x + dx, base - dy) === AIR) {
          c.set(x + dx, base - dy, first ? top : rock(x + dx, base - dy));
        }
        first = false;
      }
    }
  }

  private iceSpike(c: Canvas, x: number, r: () => number): void {
    if (this.biomeAt(x) !== Biome.Frost || r() > 0.5) return;
    const ground = this.groundTop(x);
    const length = Math.round((4 + Math.floor(r() * r() * 22)) * this.grow(x));
    this.shard(c, x, Math.min(ground, SEA), length, (r() - 0.5) * 0.5, 0.6 + length / 11, Block.Ice, Block.LumenIce, r);
  }

  /** A floating island: flat mossy top, tapering underside, hanging roots, sometimes a pond. */
  private skyIsland(c: Canvas, x: number, r: () => number): void {
    if (r() > Math.min(0.9, 0.6 + 0.08 * wildness(x))) return;
    const radius = Math.round((6 + Math.floor(r() * 11)) * this.grow(x));
    const depth = Math.round(radius * (0.5 + r() * 0.4));
    let top = 28 + Math.floor(r() * 36);
    let highest = WORLD_H;
    for (let dx = -radius; dx <= radius; dx += 4) highest = Math.min(highest, this.groundTop(x + dx));
    top = Math.min(top, highest - 22 - depth);
    if (top < 10) return;

    const thickness = (dx: number): number => {
      const u = dx / (radius + 0.5);
      return Math.max(1, Math.round(depth * Math.pow(1 - u * u, 0.65) + 1.6 * (noise1(this.seed + 501, (x + dx) / 2.5) - 0.5)));
    };
    for (let dx = -radius; dx <= radius; dx++) {
      const thick = thickness(dx);
      const start = top + (Math.abs(dx) > radius - 2 && rand2(this.seed + 502, x + dx, 0) < 0.45 ? 1 : 0);
      for (let y = start; y <= top + thick; y++) c.fill(x + dx, y, y === start ? Block.Skyturf : Block.Cloudstone);
      if (r() < 0.22) {
        const len = 2 + Math.floor(r() * 6);
        for (let i = 1; i <= len; i++) c.fill(x + dx, top + thick + i, Block.Glowroot);
      }
    }

    const pond = radius >= 9 && r() < 0.6;
    const half = 2 + Math.floor(r() * Math.max(1, radius / 3 - 2));
    const shift = Math.round((r() - 0.5) * (radius / 3));
    if (pond) {
      for (let dx = shift - half - 1; dx <= shift + half + 1; dx++) {
        const rim = dx < shift - half || dx > shift + half;
        c.set(x + dx, top, rim ? Block.Skyturf : Block.Water);
        c.set(x + dx, top + 1, rim ? Block.Cloudstone : Block.Water);
        c.set(x + dx, top + 2, Block.Cloudstone);
      }
    }
    const spire = r() < 0.65;
    const sx = x + (pond ? (shift > 0 ? -1 : 1) * (half + 3) : Math.round((r() - 0.5) * radius));
    const length = 3 + Math.floor(r() * 6);
    const angle = (r() - 0.5) * 0.7;
    if (spire && Math.abs(sx - x) < radius - 1)
      this.shard(c, sx, top, length, angle, 0.6 + length / 10, CRYSTALS[Math.floor(r() * CRYSTALS.length)]);
  }

  /** Hollow stone shells lined with glowing crystal, buried underground. */
  private geodes(c: Canvas): void {
    const SX = 76;
    const SY = 56;
    const g0 = Math.floor((c.x0 - 10) / SX);
    const g1 = Math.floor((c.x0 + CHUNK_W + 10) / SX);
    for (let gx = g0; gx <= g1; gx++) {
      for (let gy = 1; gy * SY < WORLD_H; gy++) {
        const r = rng(hash2(this.seed + 620, gx, gy));
        if (r() > 0.55) continue;
        const cx = gx * SX + Math.floor(r() * SX);
        const cy = gy * SY + Math.floor(r() * SY);
        const radius = 4 + Math.floor(r() * 4);
        const block = CRYSTALS[Math.floor(r() * CRYSTALS.length)];
        if (cy - radius < this.height(cx) + 12 || cy + radius > WORLD_H - 10) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dy = -radius; dy <= radius; dy++) {
            const d = Math.sqrt(dx * dx + dy * dy * 1.15);
            if (d > radius) continue;
            c.set(cx + dx, cy + dy, d > radius - 1 ? Block.GeodeShell : d > radius - 2.2 ? block : AIR);
          }
        }
      }
    }
  }
}
