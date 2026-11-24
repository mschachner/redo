/** Deterministic integer hashing and value noise. */

export function hash2(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform in [0, 1). */
export const rand2 = (seed: number, x: number, y: number): number =>
  hash2(seed, x, y) / 4294967296;

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 1D value noise in [0, 1). */
export function noise1(seed: number, x: number): number {
  const x0 = Math.floor(x);
  const t = smooth(x - x0);
  return lerp(rand2(seed, x0, 0), rand2(seed, x0 + 1, 0), t);
}

/** 2D value noise in [0, 1). */
export function noise2(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const a = lerp(rand2(seed, x0, y0), rand2(seed, x0 + 1, y0), tx);
  const b = lerp(rand2(seed, x0, y0 + 1), rand2(seed, x0 + 1, y0 + 1), tx);
  return lerp(a, b, ty);
}

/** Fractal 1D noise in [0, 1). */
export function fbm1(seed: number, x: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise1(seed + i * 1013, x * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Fractal 2D noise in [0, 1). */
export function fbm2(seed: number, x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(seed + i * 7919, x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
