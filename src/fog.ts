import { BLOCKS } from "./blocks";
import { World } from "./world";
import { CHUNK_W, WORLD_H } from "./worldgen";

/**
 * Rows below the surface where fog can start (the lower of the terrain's nominal surface
 * line and its top as the player has left it); everything above is always shown.
 */
const SURFACE_CLEAR = 3;
/** From above ground, how many underground cells into an opening you can see. */
const PEEK = 8;

/**
 * Fog of war underground. Cells are revealed by connection, not sight: everything in the
 * open space the player is in (air, water and plants, joined side to side), within a
 * window around them, plus the solid cells bordering it. Revealed cells stay revealed.
 *
 * From above ground, the open space continues into caves only PEEK cells deep, so a cave
 * mouth shows its entrance but not the system behind it until the player goes in.
 */
export class Fog {
  private chunks = new Map<number, Uint8Array>();
  private stamp = "";

  constructor(private world: World) {}

  /** Whether a cell can be fogged at all: well below the surface line. */
  underground(x: number, y: number): boolean {
    return y > Math.max(this.world.terrain.height(x), this.world.dugTop(x)) + SURFACE_CLEAR;
  }

  /** Whether a cell is hidden: underground and not yet revealed. */
  hidden(x: number, y: number): boolean {
    if (!this.underground(x, y) || y >= WORLD_H) return false;
    const cx = Math.floor(x / CHUNK_W);
    const c = this.chunks.get(cx);
    return !c || c[(x - cx * CHUNK_W) * WORLD_H + y] === 0;
  }

  /** The revealed cells, by chunk: one bit per cell, base64-encoded. */
  save(): [number, string][] {
    const out: [number, string][] = [];
    for (const [cx, c] of this.chunks) {
      const bits = new Uint8Array(Math.ceil(c.length / 8));
      for (let i = 0; i < c.length; i++) if (c[i]) bits[i >> 3] |= 1 << (i & 7);
      let s = "";
      for (const b of bits) s += String.fromCharCode(b);
      out.push([cx, btoa(s)]);
    }
    return out;
  }

  /** Restore revealed cells written by `save`. */
  load(saved: [number, string][]): void {
    for (const [cx, data] of saved) {
      const s = atob(data);
      const c = new Uint8Array(CHUNK_W * WORLD_H);
      for (let i = 0; i < c.length; i++) c[i] = (s.charCodeAt(i >> 3) >> (i & 7)) & 1;
      this.chunks.set(cx, c);
    }
    this.stamp = "";
  }

  private reveal(x: number, y: number): void {
    if (y < 0 || y >= WORLD_H) return;
    const cx = Math.floor(x / CHUNK_W);
    let c = this.chunks.get(cx);
    if (!c) this.chunks.set(cx, (c = new Uint8Array(CHUNK_W * WORLD_H)));
    c[(x - cx * CHUNK_W) * WORLD_H + y] = 1;
  }

  /**
   * Reveal the open space around (px, py) within `rx` columns and `ry` rows. Skipped when
   * neither the player's cell nor the world has changed since the last call.
   */
  update(px: number, py: number, rx: number, ry: number): void {
    const world = this.world;
    const stamp = `${px},${py},${world.version}`;
    if (stamp === this.stamp) return;
    this.stamp = stamp;

    const w = 2 * rx + 1;
    const h = 2 * ry + 1;
    const x0 = px - rx;
    const y0 = py - ry;
    const open = (x: number, y: number): boolean => !BLOCKS[world.get(x, y)].solid;
    const fromAbove = !this.underground(px, py);

    // Breadth-first search in layers by cost: entering an underground cell costs 1 when
    // starting from above ground (so caves are seen only PEEK deep); all else costs 0.
    const cost = new Uint8Array(w * h).fill(255);
    const layers: number[][] = Array.from({ length: PEEK + 1 }, () => []);
    const start = (px - x0) * h + (py - y0);
    cost[start] = 0;
    layers[0].push(start);
    for (let level = 0; level <= PEEK; level++) {
      const queue = layers[level];
      for (let q = 0; q < queue.length; q++) {
        const n = queue[q];
        if (cost[n] !== level) continue;
        const j = n % h;
        const i = (n - j) / h;
        const x = x0 + i;
        const y = y0 + j;
        this.reveal(x, y);
        // The solid cells around an open one are its walls: show them, all eight.
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++) if ((dx || dy) && !open(x + dx, y + dy)) this.reveal(x + dx, y + dy);

        const neighbors = [
          [i - 1, j],
          [i + 1, j],
          [i, j - 1],
          [i, j + 1],
        ];
        for (const [ni, nj] of neighbors) {
          if (ni < 0 || ni >= w || nj < 0 || nj >= h) continue;
          const nx = x0 + ni;
          const ny = y0 + nj;
          if (!open(nx, ny)) continue;
          const c = level + (fromAbove && this.underground(nx, ny) ? 1 : 0);
          const m = ni * h + nj;
          if (c > PEEK || c >= cost[m]) continue;
          cost[m] = c;
          layers[c].push(m);
        }
      }
    }
  }
}
