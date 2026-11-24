import { Biome } from "./biomes";
import { hex, RGB } from "./blocks";
import { hash2, rand2 } from "./noise";
import { SEA } from "./worldgen";

/**
 * Weather in the sky: wind, smoke, mist and drifting particles in ASCII, different in each biome.
 *
 * Each layer is a field of elements fixed in a frame that drifts with the wind. The field
 * is cut into tiles, and each tile holds at most one element, placed by a hash of the tile,
 * so the same weather comes back whenever the same patch of sky is in view. A layer with
 * parallax below 1 is distant: it moves less than the world as the camera pans.
 *
 * Near a biome border both biomes' weather is drawn, each faded by how much of its biome
 * the column has, so one gives way to the other across the border.
 */
interface Layer {
  /** Element shapes, one picked per element: rows of text, where spaces are clear. */
  shapes: string[][];
  /** The size of a tile (cells, wide and tall), and the chance one holds an element. */
  tile: [number, number];
  chance: number;
  /** The rows the layer keeps to, above sea level (so these are negative: up is less). */
  band: [number, number];
  /** Drift (cells per second; positive y is down). The x part turns with the world's wind. */
  drift: [number, number];
  /** How fully the layer moves with the world as the camera pans (1 fully, 0 not at all). */
  parallax: number;
  color: RGB;
  alpha: number;
  /** Lit by itself, so as bright at night as by day. */
  glow?: boolean;
  /** Each element fades in and out over this many seconds; without it, elements are steady. */
  life?: number;
  /** How far elements sway from side to side (cells). */
  sway?: number;
}

const rows = (...shape: string[]): string[] => shape;

const STYLES: Record<Biome, Layer[]> = {
  // Puffs of spores drifting up from the caps.
  [Biome.Fungal]: [
    {
      shapes: [["°"], ["∘"], ["·"], ["o"]],
      tile: [6, 4], chance: 0.4, band: [-30, 2], drift: [0.15, -0.35], parallax: 1,
      color: hex("#fbeaff"), alpha: 0.9, glow: true, life: 7, sway: 0.6,
    },
  ],
  // Glints of light off crystal dust.
  [Biome.Crystal]: [
    {
      shapes: [["*"], ["+"], ["·"]],
      tile: [7, 5], chance: 0.35, band: [-30, 0], drift: [0.1, 0.05], parallax: 1,
      color: hex("#ffffff"), alpha: 0.95, glow: true, life: 2.5,
    },
  ],
  // A haze over the water.
  [Biome.Coral]: [
    {
      shapes: [["~  ~ ~~  ~"], ["~ ~~   ~"]],
      tile: [18, 3], chance: 0.6, band: [-7, 0], drift: [0.8, 0], parallax: 0.8,
      color: hex("#ffffff"), alpha: 0.8,
    },
  ],
  // Smoke drifting off the wastes, and embers rising through it.
  [Biome.Ember]: [
    {
      shapes: [rows(" ~≈~ ~", "≈~ ≈~≈~", " ~ ≈~"), rows("≈~≈ ~", " ~≈~≈")],
      tile: [22, 8], chance: 0.6, band: [-28, -8], drift: [0.7, -0.08], parallax: 0.5,
      color: hex("#5a3a3c"), alpha: 0.7,
    },
    {
      shapes: [["'"], ["·"], ["*"], ["`"]],
      tile: [5, 4], chance: 0.4, band: [-30, 2], drift: [0.5, -1.4], parallax: 1,
      color: hex("#ffe49a"), alpha: 1, glow: true, life: 3, sway: 0.4,
    },
  ],
  // A strong, steady wind: long streaks and blowing sand.
  [Biome.Dunes]: [
    {
      shapes: [["————"], ["—— —"], ["———  —"], ["- ——"]],
      tile: [16, 4], chance: 0.5, band: [-30, -4], drift: [7, 0], parallax: 0.9,
      color: hex("#ffffff"), alpha: 0.85, life: 2.2,
    },
    {
      shapes: [["."], [","], ["·"]],
      tile: [5, 3], chance: 0.4, band: [-14, 2], drift: [9, 0.3], parallax: 1,
      color: hex("#9a7448"), alpha: 0.85, life: 1.6,
    },
  ],
  // Low banks of mist hanging over the canopy.
  [Biome.Tangle]: [
    {
      shapes: [["≈~≈≈~ ≈~≈~≈≈~"], ["~≈~≈ ≈≈~≈"], ["≈~ ~≈≈~≈~ ≈~≈~≈"]],
      tile: [26, 4], chance: 0.6, band: [-24, -4], drift: [0.3, 0], parallax: 0.6,
      color: hex("#eef8ff"), alpha: 0.6,
    },
    {
      shapes: [["~≈~≈~ ~≈"], ["≈~≈ ~≈"]],
      tile: [20, 5], chance: 0.5, band: [-30, -16], drift: [0.2, 0], parallax: 0.35,
      color: hex("#eef8ff"), alpha: 0.45,
    },
  ],
  // Dust blowing over the mesas.
  [Biome.Mesa]: [
    {
      shapes: [[","], ["."], ["'"]],
      tile: [6, 4], chance: 0.35, band: [-30, 2], drift: [3.5, 0.2], parallax: 1,
      color: hex("#9a5a50"), alpha: 0.8, life: 2, sway: 0.3,
    },
  ],
  // Snow falling slantwise, with gusts.
  [Biome.Frost]: [
    {
      shapes: [["*"], ["·"], ["."], ["*"]],
      tile: [4, 3], chance: 0.45, band: [-40, 4], drift: [0.9, 2.2], parallax: 1,
      color: hex("#ffffff"), alpha: 1, sway: 0.5,
    },
    {
      shapes: [["~ ~~"], ["~~ ~"], ["~ ~"]],
      tile: [20, 5], chance: 0.4, band: [-30, -4], drift: [5, 0], parallax: 0.9,
      color: hex("#ffffff"), alpha: 0.7, life: 2.5,
    },
  ],
};

/** What drawing the weather needs from the renderer and the world. */
export interface SkyView {
  ctx: CanvasRenderingContext2D;
  cell: number;
  /** The camera's top-left corner (cells, fractional), and the view's size (cells). */
  camX: number;
  camY: number;
  cols: number;
  rows: number;
  /** Seconds of animation, and the daylight (0 night, 1 day). */
  time: number;
  day: number;
  seed: number;
  /** Screen position of a world position (cells, fractional). */
  sx: (x: number) => number;
  sy: (y: number) => number;
  /** How much of a biome a column has (0–1). */
  weight: (x: number, biome: Biome) => number;
  /** Whether a cell is open sky. */
  sky: (x: number, y: number) => boolean;
}

/** The biomes with any part in the columns from x0 to x1. */
function biomesIn(view: SkyView, x0: number, x1: number): Biome[] {
  const found: Biome[] = [];
  for (const b of Object.keys(STYLES).map(Number) as Biome[]) {
    for (let x = x0; x <= x1; x += 2) {
      if (view.weight(x, b) > 0) {
        found.push(b);
        break;
      }
    }
  }
  return found;
}

const fade = (d: number, over: number): number => Math.min(1, Math.max(0, d / over));

export function drawWeather(view: SkyView): void {
  const { ctx, cell, camX, camY, time: t, day } = view;
  const x0 = Math.floor(camX) - 2;
  const x1 = Math.ceil(camX + view.cols) + 2;
  const y0 = Math.floor(camY) - 2;
  const y1 = Math.ceil(camY + view.rows) + 2;
  // The wind blows the same way all over a world, one way or the other.
  const wind = hash2(view.seed + 4400, 0, 0) & 1 ? 1 : -1;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const biome of biomesIn(view, x0, x1)) {
    STYLES[biome].forEach((layer, li) => {
      const key = view.seed + 4401 + biome * 97 + li * 13;
      const [tw, th] = layer.tile;
      const dx = layer.drift[0] * wind * t + (1 - layer.parallax) * camX;
      const dy = layer.drift[1] * t;
      const top = SEA + layer.band[0];
      const bottom = SEA + layer.band[1];
      if (bottom < y0 || top > y1) return;
      const widest = Math.max(...layer.shapes.map((s) => Math.max(...s.map((r) => r.length))));
      const tallest = Math.max(...layer.shapes.map((s) => s.length));
      const brightness = layer.glow ? 1 : 0.5 + 0.5 * day;
      const [r, g, b] = layer.color;
      ctx.fillStyle = `rgb(${Math.round(r * brightness)},${Math.round(g * brightness)},${Math.round(b * brightness)})`;
      const alpha = layer.alpha * (layer.glow ? 1 : 0.55 + 0.45 * day);
      for (let i = Math.floor((x0 - widest - dx) / tw); i <= Math.floor((x1 - dx) / tw); i++) {
        for (let j = Math.floor((Math.max(y0, top) - tallest - dy) / th); j <= Math.floor((Math.min(y1, bottom) - dy) / th); j++) {
          if (rand2(key, i, j) >= layer.chance) continue;
          const shape = layer.shapes[hash2(key + 1, i, j) % layer.shapes.length];
          const w = Math.max(...shape.map((row) => row.length));
          let ex = i * tw + rand2(key + 2, i, j) * Math.max(0, tw - w) + dx;
          const ey = j * th + rand2(key + 3, i, j) * Math.max(1, th - shape.length) + dy;
          if (layer.sway) ex += layer.sway * Math.sin(t * 0.9 + rand2(key + 4, i, j) * 6.283);
          // Fade at the edges of the layer's band (over up to 3 rows, less for a thin band),
          // and in and out over each element's life.
          const edge = Math.min(3, (bottom - top) / 4);
          let a = alpha * fade(ey - top, edge) * fade(bottom - ey - shape.length + 1, edge);
          if (layer.life) a *= Math.sin(Math.PI * ((t / layer.life + rand2(key + 5, i, j)) % 1));
          if (a <= 0.01) continue;
          shape.forEach((line, ry) => {
            for (let rx = 0; rx < line.length; rx++) {
              const ch = line[rx];
              if (ch === " ") continue;
              const cx = ex + rx;
              const cy = ey + ry;
              const col = Math.floor(cx + 0.5);
              const row = Math.floor(cy + 0.5);
              if (!view.sky(col, row)) continue;
              const shown = a * view.weight(col, biome);
              if (shown <= 0.01) continue;
              ctx.globalAlpha = shown;
              ctx.fillText(ch, view.sx(cx) + cell / 2, view.sy(cy) + cell / 2 + 1);
            }
          });
        }
      }
    });
  }
  ctx.restore();
}
