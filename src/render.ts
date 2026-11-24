import { Block, BLOCKS, RGB } from "./blocks";
import { BEDTIME, daylight, LAMP, sunLevel } from "./clock";
import { BASE_STACK, Dir, Game, MAX_HP, REST_FADE, SWING_TIME } from "./game";
import { LightField, MAX_LIGHT } from "./light";
import { MONSTERS } from "./monsters";
import { regionName } from "./names";
import { BIOMES } from "./biomes";
import { hash2, rand2 } from "./noise";
import { World, WORLD_H } from "./world";
import { SEA } from "./worldgen";

/** Sunlight strength at midnight; noon is MAX_LIGHT. */
/** Sky tint at dawn and dusk. */
const TWILIGHT: RGB = [224, 138, 112];
/** Undiscovered underground cells. */
const FOG_CSS = "rgb(10, 9, 14)";
const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
/** The cursor blinks with this period (seconds) while the player stands still. */
const BLINK = 1.06;

export const COLS = 64;
export const VIEW_ROWS = 36;
const ROWS = VIEW_ROWS;

const FONT = '"Atkinson Hyperlegible Mono", ui-monospace, "SF Mono", Menlo, monospace';
const LIGHT_MARGIN = MAX_LIGHT;
const AMBIENT = 0.1;
/** The player's own light, per channel: a warm white. */
/** Glowing blocks are drawn at least this bright, so their own color shows. */
const GLOW_MIN = 13;
const MONSTER_MIN_LIGHT = 9;
/** Speech bubbles wrap at this many characters a line. */
const BUBBLE_CHARS = 26;

/** Brightness multiplier for each light level. */
const LEVEL: number[] = [];
for (let i = 0; i <= MAX_LIGHT; i++) LEVEL.push(AMBIENT + (1 - AMBIENT) * Math.pow(i / MAX_LIGHT, 1.2));

const COLOR = {
  player: "#f4e8cf",
  cursor: "#f0c987",
  ok: "rgba(240, 201, 135, ALPHA)",
  bad: "rgba(226, 120, 110, ALPHA)",
  rule: "#34303d",
  outline: "rgba(16, 14, 20, 0.85)",
  bubble: "#f4e8cf",
  keyFill: "rgba(255, 255, 255, 0.05)",
  keyEdge: "#5d5668",
  bubbleText: "#1c1a21",
  hpLost: "#f4e8cf",
  panelSolid: "#1a181f",
  panel: "rgba(25, 23, 30, 0.88)",
  hurt: "#ffffff",
  health: "#e3a1a8",
  text: "#d9d1c3",
  muted: "#7d7689",
  accent: "#f0c987",
  full: "#e0786a",
  daySlot: "#2f5a60",
};

/** Other players' colors, picked by id. */
const PEER_COLORS = ["#8fd3ff", "#ffb3c7", "#b8f28c", "#ffd27a", "#c9a7ff", "#7fe8d0", "#ff9f80", "#e8e08a"];

/** Each facing's edge of the player's 1×1 box, as a segment [x1, y1, x2, y2]. */
const CURSOR_EDGE: Record<Dir, readonly number[]> = {
  right: [1, 0, 1, 1],
  left: [0, 0, 0, 1],
  down: [0, 1, 1, 1],
  up: [0, 0, 1, 0],
};

/** Rock face seen behind open underground cells: the local stone, darkened. */
const WALL: RGB[] = BLOCKS.map((def) => {
  const c = def.bg ?? def.fg;
  return [Math.round(c[0] * 0.4), Math.round(c[1] * 0.4), Math.round(c[2] * 0.4)];
});
const WALL_SPECK: RGB[] = BLOCKS.map((def) => {
  const c = def.bg ?? def.fg;
  return [Math.round(c[0] * 0.58), Math.round(c[1] * 0.58), Math.round(c[2] * 0.58)];
});

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private cell = 16;
  private shades = new Map<number, string>();
  light = new LightField();
  /** Draw the status panel and log (off behind the menus). */
  hud = true;
  /** Show key caps beside the things they control. */
  hints = true;
  /** View scale: 1 normally, smaller while zoomed out. */
  zoom = 1;
  private lastZoom = 1;
  /** Draw as the menu background: without the player, cursor or HUD. */
  background = false;
  private backdropCanvas = document.createElement("canvas");
  private backdropCtx = this.backdropCanvas.getContext("2d")!;
  private backdropData: ImageData | undefined;
  private covered = new Uint8Array(0);
  private dpr = 1;
  private camY: number | undefined;
  private time = 0;
  /** Cursor segment relative to the player's top-left corner: [x1, y1, x2, y2]. */
  private cursor: number[] | undefined;
  private blinkFrom = 0;
  private lastPx = NaN;
  private lastPy = NaN;
  private lastFacing: Dir | undefined;
  /** Health as the bar currently shows it, easing down after a hit. */
  private shownHp = MAX_HP;
  private frameDt = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  private resize(): void {
    const fit = Math.min((window.innerWidth - 48) / COLS, (window.innerHeight - 48) / ROWS);
    this.cell = Math.max(10, Math.min(22, Math.floor(fit)));
    const dpr = (this.dpr = window.devicePixelRatio || 1);
    const w = COLS * this.cell;
    const h = ROWS * this.cell;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * The fill color of a water cell (the top row is lighter), lit as that cell is; or
   * undefined if the cell isn't water.
   */
  private waterFill(world: World, light: LightField, x: number, y: number): string | undefined {
    if (!BLOCKS[world.get(x, y)].liquid) return undefined;
    const [water, waterFg] = world.terrain.waterColor(x, y);
    const top = !BLOCKS[world.get(x, y - 1)].liquid;
    const n = light.index(x, y);
    const [r, g, b] = light.rgb;
    return this.shade(top ? mixRGB(water, waterFg, 0.3) : water, n >= 0 ? r[n] : 0, n >= 0 ? g[n] : 0, n >= 0 ? b[n] : 0);
  }

  /** Scratch flags for which backdrop pixels are covered, resized if needed. */
  private coveredMask(n: number): Uint8Array {
    if (this.covered.length !== n) this.covered = new Uint8Array(n);
    return this.covered;
  }

  /** The offscreen backdrop's pixel buffer, resized if needed. */
  private backdropImage(w: number, h: number): ImageData {
    if (!this.backdropData || this.backdropData.width !== w || this.backdropData.height !== h) {
      this.backdropCanvas.width = w;
      this.backdropCanvas.height = h;
      this.backdropData = this.backdropCtx.createImageData(w, h);
    }
    return this.backdropData;
  }

  /** A color under colored light (levels 0–15 per channel), cached as a CSS string. */
  private shade(c: RGB, lr: number, lg: number, lb: number): string {
    const key = ((c[0] << 16) | (c[1] << 8) | c[2]) * 4096 + ((lr << 8) | (lg << 4) | lb);
    let s = this.shades.get(key);
    if (s === undefined) {
      if (this.shades.size > 60000) this.shades.clear();
      s = `rgb(${Math.round(c[0] * LEVEL[lr])},${Math.round(c[1] * LEVEL[lg])},${Math.round(c[2] * LEVEL[lb])})`;
      this.shades.set(key, s);
    }
    return s;
  }

  draw(game: Game, dt: number): void {
    const ctx = this.ctx;
    // Zooming out shrinks the cells, so more of them fit; the panels keep their size.
    const zoom = this.zoom;
    const cell = this.cell * zoom;
    const cols = Math.ceil(COLS / zoom);
    const rows = Math.ceil(VIEW_ROWS / zoom);
    const world = game.world;
    const terrain = world.terrain;
    const [px, py] = game.drawPosition();
    this.time += dt;
    this.frameDt = dt;

    // The camera follows the player continuously, so the player stays put on screen and
    // the world scrolls beneath. Horizontally it tracks exactly; vertically it eases, so a
    // jump doesn't jerk the view. At rest the player is on the grid, and so is the camera.
    // The player keeps the same spot on screen at any zoom.
    const camX = px - Math.floor(COLS / 2) / zoom;
    const wantY = clamp(py - Math.floor(VIEW_ROWS / 2) / zoom, 0, WORLD_H - VIEW_ROWS / zoom);
    if (this.zoom !== this.lastZoom) this.camY = wantY; // no easing lag while the zoom changes
    this.lastZoom = this.zoom;
    if (this.camY === undefined || Math.abs(wantY - this.camY) > VIEW_ROWS / 2) this.camY = wantY;
    this.camY += (wantY - this.camY) * (1 - Math.exp(-dt * 10));
    if (Math.abs(wantY - this.camY) < 0.002) this.camY = wantY;
    const camY = this.camY;

    const baseX = Math.floor(camX);
    const baseY = Math.floor(camY);
    const offX = this.snap((camX - baseX) * cell);
    const offY = this.snap((camY - baseY) * cell);
    /** Screen position of a world cell's top-left corner. */
    const sx = (x: number) => (x - baseX) * cell - offX;
    const sy = (y: number) => (y - baseY) * cell - offY;

    // Time of day: how strong the sun is, and how far the sky is toward its day color,
    // with a warm tint around sunrise and sunset.
    const day = daylight(game.hour);
    const sun = sunLevel(game.hour);
    const twilight = Math.max(0, 1 - Math.abs(game.hour - 6.25) / 1.6, 1 - Math.abs(game.hour - 18.75) / 1.6);
    const starAlpha = Math.max(0, 1 - day * 1.6);

    const light = this.light;
    light.update(
      world,
      baseX - LIGHT_MARGIN,
      baseY - LIGHT_MARGIN,
      cols + 1 + 2 * LIGHT_MARGIN,
      rows + 1 + 2 * LIGHT_MARGIN,
      sun,
      Math.round(game.player.x),
      Math.round(game.player.y),
      LAMP,
    );
    const [lightR, lightG, lightB] = light.rgb;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, COLS * this.cell, VIEW_ROWS * this.cell);
    ctx.clip();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, COLS * this.cell, VIEW_ROWS * this.cell);

    const seed = world.seed;
    const tick = Math.floor(this.time * 1.4);
    const lit = (n: number, ch: Int8Array): number => (n >= 0 ? ch[n] : 0);

    // Pass 1, the backdrop: sky and cave wall, one pixel per cell (with a one-cell margin)
    // in a small offscreen image that is then scaled up smoothly, so colors and light blend
    // between cells. Blocks, water and fog are drawn sharp on top of it in pass 2.
    const bw = cols + 3;
    const bh = rows + 3;
    const backdrop = this.backdropImage(bw, bh);
    const px32 = backdrop.data;
    // Open cells below the top of their own column's ground are cave; above it, sky. The
    // top drops through ground that is open from above, so leveled terrain becomes sky,
    // while a hollow under an intact roof stays cave. Roofs one or two columns wide (a
    // block left floating) don't count: a closing (max, then min, over three columns)
    // lowers each such column's top to its neighbors'.
    const raw = new Int32Array(bw + 4);
    for (let i = 0; i < bw + 4; i++) raw[i] = world.dugTop(baseX - 3 + i);
    const widened = new Int32Array(bw + 2);
    for (let i = 0; i < bw + 2; i++) widened[i] = Math.max(raw[i], raw[i + 1], raw[i + 2]);
    const surface = new Float32Array(bw);
    for (let i = 0; i < bw; i++) surface[i] = Math.min(widened[i], widened[i + 1], widened[i + 2]);
    const coveredCells = this.coveredMask(bw * bh);
    for (let i = 0; i < bw; i++) {
      const x = baseX - 1 + i;
      const night = terrain.skyColor(x);
      const noon = terrain.daySkyColor(x);
      const c = [0, 1, 2].map((ch) => {
        const v = night[ch] + (noon[ch] - night[ch]) * day;
        return v + (TWILIGHT[ch] - v) * 0.35 * twilight;
      });
      for (let j = 0; j < bh; j++) {
        const y = baseY - 1 + j;
        const b = world.get(x, y);
        // Cells covered by a block, water or fog borrow the brightest neighbor's light, so
        // the dark inside rock doesn't bleed out through the blur as a rim.
        const covered = BLOCKS[b].solid || BLOCKS[b].liquid || game.fog.hidden(x, y);
        coveredCells[j * bw + i] = covered ? 1 : 0;
        let lr: number;
        let lg: number;
        let lb: number;
        if (covered) {
          lr = lg = lb = 0;
          for (const [dx, dy] of NEIGHBORS) {
            const m = light.index(x + dx, y + dy);
            lr = Math.max(lr, lit(m, lightR));
            lg = Math.max(lg, lit(m, lightG));
            lb = Math.max(lb, lit(m, lightB));
          }
        } else {
          const n = light.index(x, y);
          lr = lit(n, lightR);
          lg = lit(n, lightG);
          lb = lit(n, lightB);
        }
        let r: number;
        let g: number;
        let bl: number;
        {
          const t = smoothstep(Math.min(1, Math.max(0, (y - surface[i]) / 2)));
          // Sky: the time of day's color, brightening toward the horizon. It is a distant
          // backdrop, so blocks don't shade it; the cave wall it fades into is lit.
          const k = 0.8 + 0.5 * Math.min(1, Math.max(0, y) / SEA);
          const wall = WALL[terrain.wallBlock(x, y)];
          r = c[0] * k * (1 - t) + wall[0] * LEVEL[lr] * t;
          g = c[1] * k * (1 - t) + wall[1] * LEVEL[lg] * t;
          bl = c[2] * k * (1 - t) + wall[2] * LEVEL[lb] * t;
        }
        const o = (j * bw + i) * 4;
        px32[o] = r;
        px32[o + 1] = g;
        px32[o + 2] = bl;
        px32[o + 3] = 255;
      }
    }
    // Pixels under blocks, water and fog are never seen, but the blur would spread their
    // color into the open cells beside them. Give each the average of its open neighbors.
    for (let i = 0; i < bw; i++) {
      for (let j = 0; j < bh; j++) {
        if (!coveredCells[j * bw + i]) continue;
        let r = 0;
        let g = 0;
        let bl = 0;
        let n = 0;
        for (const [di, dj] of NEIGHBORS) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || ni >= bw || nj < 0 || nj >= bh || coveredCells[nj * bw + ni]) continue;
          const o = (nj * bw + ni) * 4;
          r += px32[o];
          g += px32[o + 1];
          bl += px32[o + 2];
          n++;
        }
        if (n === 0) continue;
        const o = (j * bw + i) * 4;
        px32[o] = r / n;
        px32[o + 1] = g / n;
        px32[o + 2] = bl / n;
      }
    }
    this.backdropCtx.putImageData(backdrop, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low"; // plain bilinear: no overshoot halos at hard edges
    ctx.drawImage(this.backdropCanvas, sx(baseX - 1), sy(baseY - 1), bw * cell, bh * cell);

    // Pass 2: solid blocks as sharp cells, and every glyph.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(cell * 0.8)}px ${FONT}`;
    const radius = cell * 0.4;
    const fog = game.fog;
    // Fog counts as solid here, so a revealed wall doesn't round off where it meets fog.
    const opaque = (x: number, y: number): boolean => fog.hidden(x, y) || BLOCKS[world.get(x, y)].bg !== null;
    for (let col = 0; col <= cols; col++) {
      const x = baseX + col;
      const cx = sx(x);
      const star = terrain.starColor(x);
      for (let row = 0; row <= rows; row++) {
        const y = baseY + row;
        if (fog.hidden(x, y)) {
          // Fog is drawn crisp, like a block, so its edge doesn't smear into the sky.
          ctx.fillStyle = FOG_CSS;
          ctx.fillRect(cx, sy(y), cell, cell);
          continue;
        }
        const b = world.get(x, y);
        const def = BLOCKS[b];
        const n = light.index(x, y);
        let lr = lit(n, lightR);
        let lg = lit(n, lightG);
        let lb = lit(n, lightB);
        const cy = sy(y);
        let glyph = " ";
        let fg: RGB = def.fg;

        if (def.bg) {
          if (def.emit) {
            lr = Math.max(lr, GLOW_MIN);
            lg = Math.max(lg, GLOW_MIN);
            lb = Math.max(lb, GLOW_MIN);
          }
          ctx.fillStyle = this.shade(def.bg, lr, lg, lb);
          // Round a corner where both of its neighbors are open.
          const up = opaque(x, y - 1);
          const down = opaque(x, y + 1);
          const left = opaque(x - 1, y);
          const right = opaque(x + 1, y);
          const tl = !up && !left ? radius : 0;
          const tr = !up && !right ? radius : 0;
          const br = !down && !right ? radius : 0;
          const bl = !down && !left ? radius : 0;
          if (tl || tr || br || bl) {
            // A rounded corner uncovers the backdrop, which is sky or cave wall. Where the
            // cells around that corner are water, fill it with the water instead.
            const blockFill = ctx.fillStyle;
            const corners: [number, number, number][] = [
              [tl, -1, -1],
              [tr, 1, -1],
              [br, 1, 1],
              [bl, -1, 1],
            ];
            for (const [rad, dx, dy] of corners) {
              if (!rad) continue;
              const wet = this.waterFill(world, light, x + dx, y) ?? this.waterFill(world, light, x, y + dy) ?? this.waterFill(world, light, x + dx, y + dy);
              if (!wet) continue;
              ctx.fillStyle = wet;
              ctx.fillRect(dx < 0 ? cx : cx + cell - rad, dy < 0 ? cy : cy + cell - rad, rad, rad);
            }
            ctx.fillStyle = blockFill;
            ctx.beginPath();
            ctx.roundRect(cx, cy, cell, cell, [tl, tr, br, bl]);
            ctx.fill();
          } else {
            ctx.fillRect(cx, cy, cell, cell);
          }
          glyph = def.glyphs[hash2(seed + 901, x, y) % def.glyphs.length];
        } else if (def.liquid) {
          // Water, and plants growing in it, as sharp cells. The top row is lighter and
          // edged with a bright line, so the surface reads clearly.
          const waterFg = terrain.waterColor(x, y)[1];
          const top = !BLOCKS[world.get(x, y - 1)].liquid;
          ctx.fillStyle = this.waterFill(world, light, x, y)!;
          ctx.fillRect(cx, cy, cell, cell);
          if (top && !BLOCKS[world.get(x, y - 1)].solid) {
            ctx.fillStyle = this.shade(waterFg, Math.max(lr, 8), Math.max(lg, 8), Math.max(lb, 8));
            ctx.fillRect(cx, cy, cell, Math.max(1.5, cell * 0.1));
          }
          if (b === Block.Water) {
            fg = waterFg;
            if (top) {
              glyph = (x + tick) % 3 === 0 ? "≈" : "~";
            } else {
              const v = hash2(seed + 950, x, y * 131 + Math.floor(this.time * 0.9 + (hash2(seed, x, y) & 7) / 8)) % 12;
              glyph = v === 0 ? "~" : v === 1 ? "-" : " ";
            }
          } else {
            glyph = def.glyphs[(hash2(seed + 901, x, y) + tick + x) % def.glyphs.length];
            const floor = def.emit ? GLOW_MIN : 4;
            lr = Math.max(lr, floor);
            lg = Math.max(lg, floor);
            lb = Math.max(lb, floor);
          }
        } else if (b !== Block.Air) {
          // Plants and strands: a glyph over the backdrop. The campfire flickers.
          const flicker = b === Block.Campfire ? Math.floor(this.time * 5) : 0;
          glyph = def.glyphs[(hash2(seed + 901, x, y) + flicker) % def.glyphs.length];
          const floor = def.emit ? GLOW_MIN : 4;
          lr = Math.max(lr, floor);
          lg = Math.max(lg, floor);
          lb = Math.max(lb, floor);
        } else {
          const r = rand2(seed + 900, x, y);
          const underground = y > surface[col + 1] + 3;
          if (underground) {
            if (r < 0.06) {
              glyph = "·";
              fg = WALL_SPECK[terrain.wallBlock(x, y)];
            }
          } else if (r < 0.012 && starAlpha > 0) {
            // Stars: drawn at full brightness, faded by daylight.
            ctx.globalAlpha = starAlpha;
            ctx.fillStyle = `rgb(${star[0] | 0},${star[1] | 0},${star[2] | 0})`;
            ctx.fillText(r < 0.002 ? "+" : "·", cx + cell / 2, cy + cell / 2 + 1);
            ctx.globalAlpha = 1;
          }
        }
        if (b === Block.Campfire) {
          this.drawCampfire(cx, cy, world.campfireLit);
        } else if (b === Block.DayStack || b === Block.KeepStack) {
          this.drawPickup(cx, cy, b, x);
        } else if (glyph !== " ") {
          ctx.fillStyle = this.shade(fg, lr, lg, lb);
          ctx.fillText(glyph, cx + cell / 2, cy + cell / 2 + 1);
        }
      }
    }

    // Undo/redo and refusal flashes.
    for (const f of game.flashes) {
      const alpha = (Math.max(0, f.t) / 0.35) * 0.55;
      ctx.fillStyle = (f.ok ? COLOR.ok : COLOR.bad).replace("ALPHA", alpha.toFixed(3));
      ctx.fillRect(sx(f.x), sy(f.y), cell, cell);
    }

    // Lock mode also shades the target cell itself.
    if (game.locked) {
      const [tx, ty] = game.target();
      ctx.fillStyle = "rgba(240, 201, 135, 0.16)";
      ctx.fillRect(sx(tx), sy(ty), cell, cell);
    }

    if (this.background) {
      ctx.restore();
      return;
    }

    // Cursor: the player's edge on the facing side. It rides along with the player, so it
    // moves continuously and lands on the grid when they stop; when the facing changes it
    // swings quickly to the new edge.
    // While the player is still, it blinks like a terminal cursor; any movement or turn
    // shows it and restarts the blink.
    const want = CURSOR_EDGE[game.player.facing];
    const cur = (this.cursor ??= [...want]);
    const still = Math.abs(px - this.lastPx) < 1e-4 && Math.abs(py - this.lastPy) < 1e-4;
    if (!still || game.player.facing !== this.lastFacing) this.blinkFrom = this.time;
    this.lastPx = px;
    this.lastPy = py;
    this.lastFacing = game.player.facing;
    const cursorOn = (this.time - this.blinkFrom) % BLINK < BLINK / 2;
    const k = 1 - Math.exp(-dt * 35);
    for (let i = 0; i < 4; i++) {
      cur[i] += (want[i] - cur[i]) * k;
      if (Math.abs(want[i] - cur[i]) < 0.002) cur[i] = want[i];
    }
    const ex1 = this.snap(sx(px + cur[0]));
    const ey1 = this.snap(sy(py + cur[1]));
    const ex2 = this.snap(sx(px + cur[2]));
    const ey2 = this.snap(sy(py + cur[3]));
    const len = Math.hypot(ex2 - ex1, ey2 - ey1) || 1;
    const inset = Math.min(2, len / 4);
    const ux = ((ex2 - ex1) / len) * inset;
    const uy = ((ey2 - ey1) / len) * inset;
    if (cursorOn) {
      // A dark underlay keeps the cursor visible against bright sky.
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(ex1 + ux, ey1 + uy);
      ctx.lineTo(ex2 - ux, ey2 - uy);
      ctx.strokeStyle = COLOR.outline;
      ctx.lineWidth = 4.5;
      ctx.stroke();
      ctx.strokeStyle = COLOR.cursor;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineCap = "butt";
    }

    // Monsters: lit like their surroundings, but never fully dark.
    ctx.font = `bold ${Math.round(cell * 0.9)}px ${FONT}`;
    for (const m of game.monsters) {
      const [mx, my] = game.monsterDrawPosition(m);
      if (fog.hidden(Math.round(mx), Math.round(my))) continue;
      const li = light.index(Math.round(mx), Math.round(my));
      const lit = (ch: Int8Array): number => Math.max(MONSTER_MIN_LIGHT, li >= 0 ? ch[li] : 0);
      const flashing = m.hurt > 0 || (m.winding && Math.floor(this.time * 16) % 2 === 0);
      ctx.fillStyle = flashing ? COLOR.hurt : this.shade(MONSTERS[m.kind].color, lit(lightR), lit(lightG), lit(lightB));
      this.outlinedText(MONSTERS[m.kind].glyph, this.snap(sx(mx)) + cell / 2, this.snap(sy(my)) + cell / 2 + 1);
    }

    // Other players: an @ in their own color, with their name and anything they've said.
    for (const peer of game.peers) {
      const qx = this.snap((peer.drawX - camX) * cell);
      const qy = this.snap((peer.drawY - camY) * cell);
      if (qx < -cell * 8 || qx > cols * cell + cell * 8 || qy < -cell * 4 || qy > rows * cell + cell) continue;
      ctx.fillStyle = PEER_COLORS[peer.id % PEER_COLORS.length];
      this.outlinedText("@", qx + cell / 2, qy + cell / 2 + 1);
      ctx.save();
      ctx.font = `${Math.round(cell * 0.55)}px ${FONT}`;
      ctx.fillStyle = COLOR.player;
      this.outlinedText(peer.name, qx + cell / 2, qy - cell * 0.35);
      ctx.restore();
      if (peer.speech) this.drawBubble(peer.speech.text, qx + cell / 2, qy - cell * 0.85, Math.min(1, peer.speech.t / 0.5));
    }

    // Player, blinking while invulnerable after a hit.
    const ppx = this.snap((px - camX) * cell);
    const ppy = this.snap((py - camY) * cell);
    const blinkOff = Math.floor(game.player.invulnerable * 12) % 2 === 1;
    if (!blinkOff) {
      ctx.fillStyle = COLOR.player;
      this.outlinedText("@", ppx + cell / 2, ppy + cell / 2 + 1);
    }

    // Attack swing: a short arc on the facing side, fading out.
    if (game.swing) {
      const angle = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[game.swing.facing];
      ctx.strokeStyle = COLOR.cursor;
      ctx.globalAlpha = Math.max(0, game.swing.t / SWING_TIME);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ppx + cell / 2, ppy + cell / 2, cell * 1.15, angle - 0.9, angle + 0.9);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Speech bubbles: a sign's text while the player stands on it, and what the player
    // said, stacked above it if both are showing.
    let top = ppy - cell * 0.15;
    const sign = game.signUnderfoot();
    if (sign) top = this.drawBubble(sign.text, sx(sign.x) + cell / 2, sy(sign.y) - cell * 0.15, 1) - cell * 0.3;
    const speech = game.speech;
    if (speech) top = this.drawBubble(speech.text, ppx + cell / 2, top, Math.min(1, speech.t / 0.5)) - cell * 0.3;
    // At the campfire: the key to rest, or from what time resting is allowed.
    if (this.hud && game.showRestPrompt()) this.drawRestPrompt(ppx + cell / 2, top, game.canRest());

    // Resting: the view fades in from black.
    if (game.restFade > 0) {
      const t = game.restFade / REST_FADE;
      ctx.fillStyle = `rgba(8, 7, 11, ${Math.min(1, t * 1.6)})`;
      ctx.fillRect(0, 0, COLS * cell, VIEW_ROWS * cell);
    }
    // Asleep in a shared world, waiting for morning: dark, with how many others are asleep.
    if (game.asleep) {
      ctx.fillStyle = "rgba(8, 7, 11, 0.86)";
      ctx.fillRect(0, 0, COLS * cell, VIEW_ROWS * cell);
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `${Math.round(cell * 0.9)}px ${FONT}`;
      ctx.fillStyle = COLOR.text;
      ctx.fillText("asleep", (COLS * cell) / 2, (VIEW_ROWS * cell) / 2 - cell * 0.7);
      ctx.font = `${Math.round(cell * 0.65)}px ${FONT}`;
      ctx.fillStyle = COLOR.muted;
      const [asleep, online] = game.sleepers;
      ctx.fillText(`${asleep} of ${online} players asleep`, (COLS * cell) / 2, (VIEW_ROWS * cell) / 2 + cell * 0.6);
      ctx.restore();
    }
    ctx.restore();

    if (this.hud) {
      const panelTop = this.drawPanel(game);
      this.drawLog(game, panelTop);
      this.drawHeld(game);
      this.drawBroadcast(game);
    }
  }

  /**
   * The campfire, in ASCII: two tongues of flame, `)` and `(`, licking up from a `=` of
   * logs around a `'` of yellow core, with `.` and `'` sparks drifting up out of it. The
   * tongues trade heights as it flickers. Full brightness day or night. While it's out
   * (before 21:00), just the logs and a little smoke.
   */
  private drawCampfire(cx: number, cy: number, lit: boolean): void {
    const { ctx, cell } = this;
    const t = this.time;
    const font = ctx.font;
    const put = (ch: string, x: number, y: number, size: number, color: string): void => {
      ctx.font = `${Math.round(cell * size)}px ${FONT}`;
      ctx.fillStyle = color;
      ctx.fillText(ch, x, y);
    };
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const mid = cx + cell / 2;

    // Logs.
    put("=", mid, cy + cell * 0.84, 0.8, "#8a5a44");
    if (!lit) {
      // A wisp of smoke, rising slowly and fading.
      const u = (t % 3.2) / 3.2;
      ctx.globalAlpha = 0.55 * Math.sin(Math.PI * u);
      put("~", mid + Math.sin(t * 1.7) * cell * 0.12, cy + cell * (0.55 - 1.2 * u), 0.7, "#b8b0c0");
      ctx.restore();
      ctx.font = font;
      return;
    }

    // Tongues: one tall and one short, swapping sides now and then.
    const frame = Math.floor(t * 6);
    const left = hash2(frame, 17, 3) % 3 !== 0;
    const tall = 1.05 + 0.08 * Math.sin(t * 11);
    const short = 0.85 + 0.06 * Math.sin(t * 8 + 1);
    put(")", mid - cell * 0.13, cy + cell * (left ? 0.4 : 0.5), left ? tall : short, "#ff8a2e");
    put("(", mid + cell * 0.14, cy + cell * (left ? 0.5 : 0.4), left ? short : tall, "#ffa53c");
    put("'", mid + cell * 0.01, cy + cell * 0.56, 1.0, "#ffe08a");

    // Sparks: each rises about two cells over its life, wavering, and fades out.
    for (let k = 0; k < 3; k++) {
      const life = 1.4 + 0.3 * k;
      const u = ((t + k * 0.57) % life) / life;
      ctx.globalAlpha = (1 - u) * 0.9;
      const x = mid + Math.sin((t + k) * 3.1) * cell * 0.18 + (k - 1) * cell * 0.12;
      put(k === 1 ? "'" : ".", x, cy + cell * 0.1 - u * cell * 2, 0.7, "#ffd27a");
    }
    ctx.restore();
    ctx.font = font;
  }

  /**
   * A stack pickup: a bold `+` bobbing gently, cyan for a day slot, gold for a kept one, in
   * brackets (`[+]`) for the kept kind so the rare one stands out. Full brightness.
   */
  private drawPickup(cx: number, cy: number, b: Block, x: number): void {
    const { ctx, cell } = this;
    const font = ctx.font;
    const mid = cx + cell / 2;
    const bob = Math.sin(this.time * 2.4 + x * 0.7) * cell * 0.08;
    const y = cy + cell / 2 + 1 + bob;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const color = b === Block.KeepStack ? "#ffd24a" : "#7fe0e8";
    ctx.fillStyle = COLOR.outline;
    ctx.font = `bold ${Math.round(cell * 0.95)}px ${FONT}`;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) ctx.fillText("+", mid + dx, y + dy);
    ctx.fillStyle = color;
    ctx.fillText("+", mid, y);
    if (b === Block.KeepStack) {
      ctx.font = `${Math.round(cell * 0.75)}px ${FONT}`;
      ctx.globalAlpha = 0.7 + 0.3 * Math.sin(this.time * 4);
      ctx.fillText("[", mid - cell * 0.42, y);
      ctx.fillText("]", mid + cell * 0.42, y);
    }
    ctx.restore();
    ctx.font = font;
  }

  /**
   * The resting prompt, centered on x with its bottom at y: the F key and "rest & commit"
   * when resting is allowed, or a muted "Lights at 21:00" before bedtime.
   */
  private drawRestPrompt(x: number, bottom: number, ready: boolean): void {
    const { ctx, cell } = this;
    ctx.save();
    ctx.font = `${Math.round(cell * 0.65)}px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const label = ready ? "rest & commit" : `Lights at ${String(BEDTIME).padStart(2, "0")}:00`;
    const keyW = ready ? cell * 0.95 + cell * 0.35 : 0;
    const pad = cell * 0.3;
    const w = pad * 2 + keyW + ctx.measureText(label).width;
    const h = cell * 1.35;
    const x0 = x - w / 2;
    const y = bottom - h / 2;
    ctx.fillStyle = COLOR.panel;
    ctx.beginPath();
    ctx.roundRect(x0, bottom - h, w, h, cell * 0.3);
    ctx.fill();
    const after = ready ? this.keyCap("F", x0 + pad, y) + cell * 0.35 : x0 + pad;
    ctx.fillStyle = ready ? COLOR.text : COLOR.muted;
    ctx.fillText(label, after, y);
    ctx.restore();
  }

  /** The latest broadcast, as a banner across the top center of the view. */
  private drawBroadcast(game: Game): void {
    const b = game.broadcastShown;
    if (!b) return;
    const { ctx, cell } = this;
    ctx.save();
    ctx.globalAlpha = Math.min(1, b.t / 0.6, (b.total - b.t) / 0.25);
    ctx.font = `${Math.round(cell * 0.8)}px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    const pad = cell * 0.9;
    const w = Math.min(COLS * cell - cell * 24, ctx.measureText(b.text).width + pad * 2);
    const h = cell * 1.9;
    const x = (COLS * cell - w) / 2;
    const y = cell * 0.75;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, cell * 0.4);
    ctx.fillStyle = COLOR.panel;
    ctx.fill();
    ctx.strokeStyle = COLOR.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = COLOR.text;
    ctx.fillText(b.text, x + w / 2, y + h / 2, w - pad * 2);
    ctx.restore();
  }

  /** The activity log's latest line, in a strip just above the status panel. */
  private drawLog(game: Game, above: number): void {
    const log = game.log;
    if (!log) return;
    const { ctx, cell } = this;
    ctx.font = `${Math.round(cell * 0.72)}px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const text = log.count > 1 ? `${log.text} (x${log.count})` : log.text;
    const pad = cell * 0.6;
    const w = ctx.measureText(text).width + pad * 2;
    const h = cell * 1.5;
    const x0 = cell * 0.75;
    const y0 = above - cell * 0.4 - h;
    ctx.fillStyle = COLOR.panel;
    this.box(x0, y0, w, h);
    // Bright when new, settling to muted after a few seconds.
    ctx.fillStyle = log.age < 3 ? COLOR.text : COLOR.muted;
    ctx.fillText(text, x0 + pad, y0 + h / 2);
  }

  /**
   * A speech bubble whose tail points down at (ax, ay), with `text` wrapped to a few
   * words per line. Kept inside the view. Returns the top of the bubble.
   */
  private drawBubble(text: string, ax: number, ay: number, alpha: number): number {
    const { ctx, cell } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${Math.round(cell * 0.68)}px ${FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    // Wrap on spaces to at most BUBBLE_CHARS characters a line; split longer words.
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (w.length > BUBBLE_CHARS) {
        if (line) lines.push(line);
        lines.push(w.slice(0, BUBBLE_CHARS));
        w = w.slice(BUBBLE_CHARS);
        line = "";
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= BUBBLE_CHARS) line += " " + w;
      else {
        lines.push(line);
        line = w;
      }
    }
    if (line) lines.push(line);

    const pad = cell * 0.45;
    const lineH = cell * 0.9;
    const tail = cell * 0.35;
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
    const h = lines.length * lineH + pad * 1.2;
    const viewW = COLS * cell;
    const x = Math.max(4, Math.min(viewW - w - 4, ax - w / 2));
    const y = ay - tail - h;
    const tx = Math.max(x + tail * 1.5, Math.min(x + w - tail * 1.5, ax));

    ctx.beginPath();
    ctx.roundRect(x, y, w, h, cell * 0.35);
    ctx.moveTo(tx - tail, y + h - 0.5);
    ctx.lineTo(tx, y + h + tail);
    ctx.lineTo(tx + tail, y + h - 0.5);
    ctx.closePath();
    ctx.fillStyle = COLOR.bubble;
    ctx.strokeStyle = COLOR.outline;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fill();
    ctx.fillStyle = COLOR.bubbleText;
    lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad * 0.6 + lineH * (i + 0.5)));
    ctx.restore();
    return y;
  }

  /** Text with a dark outline, so it reads on light and dark backgrounds alike. */
  private outlinedText(text: string, x: number, y: number): void {
    const ctx = this.ctx;
    const fill = ctx.fillStyle;
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(3, this.cell * 0.22);
    ctx.strokeStyle = COLOR.outline;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  /** A panel: rounded, translucent, with a thin border. */
  private box(x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    const r = this.cell * 0.4;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = COLOR.panel;
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r);
    ctx.strokeStyle = COLOR.rule;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** Forget everything carried over from the previous world or view. */
  reset(): void {
    this.light = new LightField();
    this.camY = undefined;
    this.cursor = undefined;
    this.shownHp = MAX_HP;
  }

  /** Round a length in CSS pixels to whole device pixels, so glyphs don't shimmer. */
  private snap(v: number): number {
    return Math.round(v * this.dpr) / this.dpr;
  }

  /**
   * Status panel, anchored to the lower left over the world and growing upward: health,
   * day and time, location, position, undo/redo depth, the chat key when hints are on,
   * and the lock indicator. Returns its top edge.
   */
  private drawPanel(game: Game): number {
    const { ctx, cell } = this;
    const h = game.history;
    const lineH = cell * 1.3;
    const pad = cell * 0.6;
    const rows = 5 + (this.hints ? 1 : 0) + (game.locked ? 1 : 0);
    const x0 = cell * 0.75;
    const hgt = pad * 2 + rows * lineH;
    const y0 = VIEW_ROWS * cell - cell * 0.75 - hgt;

    // Where the player is: the region's generated name and its biome.
    const world = game.world;
    const region = world.terrain.regionAt(Math.round(game.player.x));
    const location = `Location: ${regionName(world.seed, region.index, region.biome)} (${BIOMES[region.biome].name})`;

    // The panel is a fixed width, widening only if the location line needs it.
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(cell * 0.72)}px ${FONT}`;
    const baseW = cell * 9.6;
    const stackSlots = Math.max(game.stackLimit, h.undoStack.length + h.redoStack.length);
    const stackW =
      ctx.measureText("stack").width + cell * 0.75 + stackSlots * (Math.round(cell * 0.5) + Math.max(2, Math.round(cell * 0.16))) + (this.hints ? cell * 2.4 : 0);
    const w = Math.max(baseW, ctx.measureText(location).width + pad * 2, stackW + pad * 2);
    ctx.fillStyle = COLOR.panel;
    this.box(x0, y0, w, hgt);
    const left = x0 + pad;
    let y = y0 + pad + lineH / 2;

    // Health: a bar with one segment per hit point. Losses slide down rather than jump;
    // the part just lost shows pale until the bar catches up.
    const hp = Math.max(0, game.player.hp);
    if (hp >= this.shownHp) this.shownHp = hp;
    else this.shownHp = Math.max(hp, this.shownHp - this.frameDt * 3);
    const barW = baseW - pad * 2;
    const barH = Math.round(cell * 0.5);
    const barY = y - barH / 2;
    const seg = barW / MAX_HP;
    const gap = 2;
    ctx.fillStyle = COLOR.rule;
    ctx.beginPath();
    ctx.roundRect(left, barY, barW, barH, barH / 2);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(left, barY, barW, barH, barH / 2);
    ctx.clip();
    ctx.fillStyle = COLOR.hpLost;
    ctx.fillRect(left, barY, seg * this.shownHp, barH);
    ctx.fillStyle = COLOR.health;
    ctx.fillRect(left, barY, seg * hp, barH);
    ctx.fillStyle = COLOR.panelSolid;
    for (let i = 1; i < MAX_HP; i++) ctx.fillRect(left + seg * i - gap / 2, barY, gap, barH);
    ctx.restore();
    y += lineH;

    // Clock and position. y counts up from sea level.
    const minutes = Math.floor(game.hour * 60);
    const clock = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    ctx.fillStyle = COLOR.text;
    ctx.fillText(`day ${game.day}  ${clock}`, left, y);
    y += lineH;
    ctx.fillText(location, left, y);
    y += lineH;
    ctx.fillStyle = COLOR.muted;
    ctx.fillText(`x ${Math.round(game.player.x)}  y ${SEA - Math.round(game.player.y)}`, left, y);
    y += lineH;

    // The stack: a slot per action it can hold. Filled slots are actions that can be
    // undone, outlined ones actions that can be redone; when every slot is filled, new
    // actions are refused. The undo and redo keys follow when hints are on.
    ctx.textAlign = "left";
    ctx.fillStyle = COLOR.muted;
    let hx = left;
    ctx.fillText("stack", hx, y);
    hx += ctx.measureText("stack").width + cell * 0.45;
    const undos = h.undoStack.length;
    const redos = h.redoStack.length;
    const limit = game.stackLimit;
    const full = undos >= limit;
    const slots = Math.max(limit, undos + redos);
    // Slots from day pickups are the last ones, and show empty in their own color.
    const dayFrom = BASE_STACK + game.keptSlots;
    const size = Math.round(cell * 0.5);
    const step = size + Math.max(2, Math.round(cell * 0.16));
    for (let i = 0; i < slots; i++) {
      const sx0 = Math.round(hx + i * step) + 0.5;
      const sy0 = Math.round(y - size / 2) + 0.5;
      ctx.beginPath();
      ctx.roundRect(sx0, sy0, size - 1, size - 1, size * 0.22);
      if (i < undos) {
        ctx.fillStyle = full ? COLOR.full : COLOR.accent;
        ctx.fill();
      } else if (i < undos + redos) {
        ctx.strokeStyle = COLOR.accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = i >= dayFrom && i < limit ? COLOR.daySlot : COLOR.rule;
        ctx.fill();
      }
    }
    hx += slots * step + cell * 0.3;
    if (this.hints) {
      hx = this.keyCap("U", hx, y) + cell * 0.2;
      this.keyCap("I", hx, y);
    }
    y += lineH;

    if (this.hints) {
      const after = this.keyCap("T", left, y) + cell * 0.35;
      ctx.fillStyle = COLOR.muted;
      ctx.textAlign = "left";
      ctx.fillText("chat", after, y);
      y += lineH;
    }

    if (game.locked) {
      ctx.fillStyle = COLOR.accent;
      ctx.fillText("LOCK", left, y);
    }
    return y0;
  }

  /** A small key cap with a label, its left edge at x and centered on y. Returns its right edge. */
  private keyCap(label: string, x: number, y: number): number {
    const { ctx, cell } = this;
    ctx.save();
    ctx.font = `${Math.round(cell * 0.58)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = Math.max(cell * 0.95, ctx.measureText(label).width + cell * 0.45);
    const h = cell * 0.95;
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y - h / 2 + 0.5, w - 1, h - 1, cell * 0.2);
    ctx.fillStyle = COLOR.keyFill;
    ctx.fill();
    ctx.strokeStyle = COLOR.keyEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = COLOR.text;
    ctx.fillText(label, x + w / 2, y + 1);
    ctx.restore();
    return x + w;
  }

  /**
   * The held block, in the lower right: swatch, name and count, flanked by the Q and E keys
   * when hints are on. Just after cycling (Q, E, 1–9), every carried block shows above it,
   * the selected one outlined.
   */
  private drawHeld(game: Game): void {
    const { ctx, cell } = this;
    const inv = game.inventory;
    const selected = inv.selectedBlock();
    if (selected === undefined) return;
    const pad = cell * 0.6;
    const viewW = COLS * cell;
    const viewH = VIEW_ROWS * cell;
    ctx.save();
    ctx.font = `${Math.round(cell * 0.72)}px ${FONT}`;
    ctx.textBaseline = "middle";

    // The held block.
    const def = BLOCKS[selected];
    const label = `${def.name}  ${inv.count(selected)}`;
    const keyW = this.hints ? cell * 1.3 : 0;
    const w = pad * 2 + cell * 1.2 + cell * 0.5 + ctx.measureText(label).width + keyW * 2;
    const h = cell * 2;
    const x0 = viewW - cell * 0.75 - w;
    const y0 = viewH - cell * 0.75 - h;
    this.box(x0, y0, w, h);
    const mid = y0 + h / 2;
    let x = x0 + pad;
    if (this.hints) x = this.keyCap("Q", x, mid) + cell * 0.35;
    this.swatch(selected, x, mid, cell * 1.2);
    x += cell * 1.2 + cell * 0.5;
    ctx.textAlign = "left";
    ctx.fillStyle = COLOR.text;
    ctx.fillText(label, x, mid);
    if (this.hints) this.keyCap("E", x0 + w - pad - cell * 0.95, mid);

    // The whole inventory, briefly, after cycling.
    if (game.inventoryShown > 0) {
      const held = inv.held();
      const PER_ROW = 8;
      const slot = cell * 2.6;
      const rows = Math.ceil(held.length / PER_ROW);
      const gw = pad * 2 + Math.min(held.length, PER_ROW) * slot;
      const gh = pad * 2 + rows * cell * 1.5;
      const gx = viewW - cell * 0.75 - gw;
      const gy = y0 - cell * 0.4 - gh;
      ctx.globalAlpha = Math.min(1, game.inventoryShown / 0.3);
      this.box(gx, gy, gw, gh);
      held.forEach((b, i) => {
        const sx = gx + pad + (i % PER_ROW) * slot;
        const sy = gy + pad + Math.floor(i / PER_ROW) * cell * 1.5 + cell * 0.75;
        this.swatch(b, sx, sy, cell);
        if (b === selected) {
          ctx.strokeStyle = COLOR.accent;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(sx - 1.5, sy - cell / 2 - 1.5, cell + 3, cell + 3);
        }
        ctx.textAlign = "left";
        ctx.fillStyle = b === selected ? COLOR.accent : COLOR.text;
        ctx.fillText(String(inv.count(b)), sx + cell * 1.25, sy);
      });
    }
    ctx.restore();
  }

  /** A block's swatch: its color and glyph, `size` square, left edge x, centered on y. */
  private swatch(b: Block, x: number, y: number, size: number): void {
    const { ctx } = this;
    const def = BLOCKS[b];
    if (def.bg) {
      ctx.fillStyle = this.shade(def.bg, MAX_LIGHT, MAX_LIGHT, MAX_LIGHT);
      ctx.beginPath();
      ctx.roundRect(x, y - size / 2, size, size, size * 0.2);
      ctx.fill();
    }
    ctx.save();
    ctx.font = `${Math.round(size * 0.8)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillStyle = this.shade(def.fg, MAX_LIGHT, MAX_LIGHT, MAX_LIGHT);
    ctx.fillText(def.glyphs[0], x + size / 2, y + 1);
    ctx.restore();
  }
}

function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
