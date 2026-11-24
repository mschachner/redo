import { Biome } from "./biomes";
import { hex, isLiquid, RGB } from "./blocks";
import { World } from "./world";

/**
 * How a monster moves:
 * - walker: walks along the ground and hops one-cell ledges
 * - hopper: waits, then leaps toward its target
 * - charger: ambles; on seeing its target level with it, winds up and charges
 * - flyer: drifts through the air, ignoring gravity but not blocks
 * - swimmer: moves freely in water and cannot leave it; flops on dry land
 */
export type Behavior = "walker" | "hopper" | "charger" | "flyer" | "swimmer";

export interface MonsterDef {
  name: string;
  glyph: string;
  color: RGB;
  behavior: Behavior;
  hp: number;
  /** Top speed, cells per second. */
  speed: number;
  /** How far away (cells) it notices the player. */
  sight: number;
}

const def = (name: string, glyph: string, color: string, behavior: Behavior, hp: number, speed: number, sight: number): MonsterDef => ({
  name, glyph, color: hex(color), behavior, hp, speed, sight,
});

export const MONSTERS = {
  sporeling: def("sporeling", "m", "#e3a1c8", "walker", 3, 4.2, 14),
  puffball: def("puffball", "o", "#c9a0e8", "flyer", 3, 2.2, 16),
  shardling: def("shardling", "k", "#7fe0f0", "hopper", 2, 6, 15),
  glint: def("glint", "v", "#ffc1e0", "flyer", 2, 3.4, 18),
  eel: def("eel", "s", "#ff9f80", "swimmer", 2, 5, 14),
  jelly: def("jelly", "j", "#ffb3e6", "swimmer", 3, 2.2, 12),
  cinderhound: def("cinderhound", "h", "#ff8a4a", "charger", 3, 3.5, 18),
  ashwing: def("ashwing", "v", "#d0a090", "flyer", 2, 3, 18),
  scuttler: def("scuttler", "c", "#e9e1cf", "walker", 2, 5.5, 14),
  dunehopper: def("dunehopper", "q", "#7fd4bc", "hopper", 3, 5, 15),
  vinestalker: def("vinestalker", "n", "#4fd0a0", "walker", 3, 3.8, 12),
  mothling: def("mothling", "y", "#d8f06a", "flyer", 2, 3.2, 16),
  rockback: def("rockback", "b", "#cc6f55", "charger", 4, 3, 18),
  skink: def("skink", "z", "#e3c9a0", "walker", 2, 5.8, 14),
  rimewalker: def("rimewalker", "u", "#dfeaf2", "walker", 4, 3.2, 14),
  frostwisp: def("frostwisp", "w", "#9cd0ee", "flyer", 2, 3, 18),
  abyssal: def("abyssal", "e", "#8fa0ff", "swimmer", 4, 4, 16),
  deepcrawler: def("deepcrawler", "x", "#c8d0ff", "walker", 4, 4, 14),
} satisfies Record<string, MonsterDef>;

export type MonsterKind = keyof typeof MONSTERS;

/** The kinds that live in each biome; water anywhere also has eels. */
export const BIOME_MONSTERS: Record<Biome, MonsterKind[]> = {
  [Biome.Fungal]: ["sporeling", "puffball"],
  [Biome.Crystal]: ["shardling", "glint"],
  [Biome.Coral]: ["eel", "jelly"],
  [Biome.Ember]: ["cinderhound", "ashwing"],
  [Biome.Dunes]: ["scuttler", "dunehopper"],
  [Biome.Tangle]: ["vinestalker", "mothling"],
  [Biome.Mesa]: ["rockback", "skink"],
  [Biome.Frost]: ["rimewalker", "frostwisp"],
};
export const WATER_MONSTERS: MonsterKind[] = ["eel"];
export const DEEP_MONSTERS: MonsterKind[] = ["abyssal", "deepcrawler"];

const GRAVITY = 62;
const MAX_FALL = 26;
const STEP_HOP = 13; // apex ≈ 1.4 cells: enough for a one-cell ledge
const LEAP = 16; // hoppers: apex ≈ 2 cells
const EPS = 1e-6;
const SIGHT_RECHECK = 0.15; // seconds

/** Monsters are 1×1 boxes with top-left corner (x, y), like the player. */
export class Monster {
  /** Identifies the monster to players in a shared world. */
  id = 0;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  vx = 0;
  vy = 0;
  grounded = false;
  hp: number;
  readonly speed: number;
  readonly sight: number;
  /** Hearts taken from the player on contact. */
  readonly damage: number;
  /** Seconds left of the white flash after being hit. */
  hurt = 0;
  /** Seconds left during which knockback overrides its own movement. */
  stunned = 0;
  private wanderDir = 0;
  private wanderTimer = 0;
  private age = Math.random() * 10;
  private sightTimer = 0;
  private seesTarget = false;
  /** Hoppers: time until the next leap. Chargers: time left in the current phase. */
  private timer = 0.5 + Math.random();
  private phase: "roam" | "windup" | "charge" | "rest" = "roam";
  private chargeDir = 0;

  /** `wild` is the wildness where it spawned: more health, speed, sight and damage. */
  constructor(readonly kind: MonsterKind, x: number, y: number, wild = 0) {
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    const d = MONSTERS[kind];
    this.hp = Math.round(d.hp * (1 + 0.4 * wild));
    this.speed = d.speed * (1 + 0.1 * wild);
    this.sight = d.sight + 2 * wild;
    this.damage = 1 + Math.floor(wild / 2.5);
  }

  get def(): MonsterDef {
    return MONSTERS[this.kind];
  }

  /** A charger about to charge, drawn in a warning color. */
  get winding(): boolean {
    return this.phase === "windup";
  }

  /** Show a charger winding up or not, as reported by the server. */
  showWinding(on: boolean): void {
    if (on) this.phase = "windup";
    else if (this.phase === "windup") this.phase = "roam";
  }

  /** Knock the monster away from a point, e.g. the player who hit it. */
  knockFrom(fromX: number, fromY: number, strength: number): void {
    const dx = this.x - fromX;
    const dy = this.y - fromY;
    const len = Math.hypot(dx, dy) || 1;
    const free = this.def.behavior === "flyer" || this.def.behavior === "swimmer";
    this.vx = (dx / len) * strength;
    this.vy = free ? (dy / len) * strength : -strength * 0.6;
    this.grounded = false;
    this.stunned = 0.25;
    if (this.phase === "charge" || this.phase === "windup") {
      this.phase = "rest";
      this.timer = 0.6;
    }
  }

  step(dt: number, world: World, targetX: number, targetY: number): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.age += dt;
    this.hurt = Math.max(0, this.hurt - dt);
    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0) {
      this.wanderTimer = 1.5 + Math.random() * 2.5;
      this.wanderDir = Math.floor(Math.random() * 3) - 1;
    }

    const dx = targetX - this.x;
    const dy = targetY - this.y;
    // Sight needs range and a clear line between centers; rechecked a few times a second.
    this.sightTimer -= dt;
    if (this.sightTimer <= 0) {
      this.sightTimer = SIGHT_RECHECK;
      this.seesTarget =
        Math.hypot(dx, dy) < this.sight &&
        world.lineOfSight(this.x + 0.5, this.y + 0.5, targetX + 0.5, targetY + 0.5);
    }
    const sees = this.seesTarget;
    const speed = this.speed;
    const behavior = this.def.behavior;
    const wet = isLiquid(world.get(Math.floor(this.x + 0.5), Math.floor(this.y + 0.5)));

    if (this.stunned > 0) {
      this.stunned -= dt;
      if (behavior === "flyer" || (behavior === "swimmer" && wet)) {
        this.vx *= Math.exp(-dt * 4);
        this.vy *= Math.exp(-dt * 4);
      }
    } else {
      switch (behavior) {
        case "walker": {
          const want = sees ? (Math.abs(dx) > 0.3 ? Math.sign(dx) : 0) : this.wanderDir;
          this.vx = approach(this.vx, want * speed * (wet ? 0.5 : 1), 30 * dt);
          break;
        }
        case "hopper": {
          if (this.grounded) {
            this.vx = approach(this.vx, 0, 40 * dt);
            this.timer -= dt;
            if (this.timer <= 0) {
              const dir = sees ? Math.sign(dx) || 1 : this.wanderDir;
              this.timer = (sees ? 0.5 : 1.2) + Math.random() * 0.8;
              if (dir !== 0 || sees) {
                this.vx = dir * speed;
                this.vy = -LEAP * (wet ? 0.6 : 1);
                this.grounded = false;
              }
            }
          }
          break;
        }
        case "charger":
          this.stepCharger(dt, sees, dx, dy, wet);
          break;
        case "flyer": {
          let wx: number;
          let wy: number;
          if (sees) {
            const len = Math.hypot(dx, dy) || 1;
            wx = (dx / len) * speed;
            wy = (dy / len) * speed;
          } else {
            wx = this.wanderDir * speed * 0.4;
            wy = Math.sin(this.age * 1.7) * 0.8;
          }
          this.vx = approach(this.vx, wx, 8 * dt);
          this.vy = approach(this.vy, wy, 8 * dt);
          break;
        }
        case "swimmer": {
          if (!wet) break;
          let wx: number;
          let wy: number;
          if (sees) {
            const len = Math.hypot(dx, dy) || 1;
            wx = (dx / len) * speed;
            wy = (dy / len) * speed;
          } else {
            wx = this.wanderDir * speed * 0.5;
            wy = Math.sin(this.age * 1.3) * 1.2;
          }
          this.vx = approach(this.vx, wx, 10 * dt);
          this.vy = approach(this.vy, wy, 10 * dt);
          break;
        }
      }
    }

    // Gravity: not for flyers, nor swimmers in water; damped in water for everyone else.
    if (behavior !== "flyer" && !(behavior === "swimmer" && wet)) {
      if (wet) this.vy = Math.min(this.vy + GRAVITY * 0.3 * dt, 4);
      else this.vy = Math.min(this.vy + GRAVITY * dt, MAX_FALL);
      if (behavior === "swimmer") this.vx = approach(this.vx, 0, 10 * dt); // flopping on land
    }

    let blockedX: boolean;
    if (behavior === "swimmer" && wet) {
      // Swimmers stay in the water: a move that would take their center out is cancelled.
      blockedX = this.swimMove(world, this.vx * dt, 0);
      this.swimMove(world, 0, this.vy * dt);
    } else {
      blockedX = this.moveX(world, this.vx * dt);
      this.moveY(world, this.vy * dt);
    }

    if (blockedX && (behavior === "walker" || (behavior === "charger" && this.phase === "roam")) && this.grounded && this.stunned <= 0) {
      this.vy = -STEP_HOP;
      this.grounded = false;
    }
    if (blockedX && this.phase === "charge") {
      this.phase = "rest";
      this.timer = 0.9;
    }
    if (blockedX && !sees) this.wanderDir = -this.wanderDir;
  }

  private stepCharger(dt: number, sees: boolean, dx: number, dy: number, wet: boolean): void {
    this.timer -= dt;
    const slow = wet ? 0.5 : 1;
    switch (this.phase) {
      case "roam": {
        const want = sees ? Math.sign(dx) : this.wanderDir;
        this.vx = approach(this.vx, want * this.speed * 0.45 * slow, 20 * dt);
        if (sees && this.grounded && Math.abs(dy) < 2 && Math.abs(dx) < this.sight * 0.8) {
          this.phase = "windup";
          this.timer = 0.45;
          this.chargeDir = Math.sign(dx) || 1;
        }
        break;
      }
      case "windup":
        this.vx = approach(this.vx, 0, 40 * dt);
        if (this.timer <= 0) {
          this.phase = "charge";
          this.timer = 1;
        }
        break;
      case "charge":
        this.vx = approach(this.vx, this.chargeDir * this.speed * 2.6 * slow, 60 * dt);
        if (this.timer <= 0) {
          this.phase = "rest";
          this.timer = 0.8;
        }
        break;
      case "rest":
        this.vx = approach(this.vx, 0, 30 * dt);
        if (this.timer <= 0) this.phase = "roam";
        break;
    }
  }

  private swimMove(world: World, dx: number, dy: number): boolean {
    const nx = this.x + dx;
    const ny = this.y + dy;
    const centerWet = isLiquid(world.get(Math.floor(nx + 0.5), Math.floor(ny + 0.5)));
    if (!centerWet || world.boxHitsSolid(nx, ny)) {
      if (dx !== 0) this.vx = -this.vx * 0.3;
      if (dy !== 0) this.vy = -this.vy * 0.3;
      return dx !== 0;
    }
    this.x = nx;
    this.y = ny;
    return false;
  }

  private moveX(world: World, dx: number): boolean {
    if (dx === 0) return false;
    const nx = this.x + dx;
    if (!world.boxHitsSolid(nx, this.y)) {
      this.x = nx;
      return false;
    }
    this.x = dx > 0 ? Math.floor(nx + 1 - EPS) - 1 : Math.floor(nx + EPS) + 1;
    this.vx = 0;
    return true;
  }

  private moveY(world: World, dy: number): void {
    const ny = this.y + dy;
    if (!world.boxHitsSolid(this.x, ny)) {
      this.y = ny;
      this.grounded = world.boxHitsSolid(this.x, this.y + 2 * EPS) && this.vy >= 0;
      return;
    }
    if (dy > 0) {
      this.y = Math.floor(ny + 1 - EPS) - 1;
      this.grounded = true;
    } else {
      this.y = Math.floor(ny + EPS) + 1;
    }
    this.vy = 0;
  }
}

/** Whether two 1×1 boxes overlap, each shrunk by `inset` on every side. */
export function boxesOverlap(ax: number, ay: number, bx: number, by: number, inset = 0): boolean {
  const s = 1 - 2 * inset;
  return Math.abs(ax - bx) < s && Math.abs(ay - by) < s;
}

function approach(v: number, target: number, step: number): number {
  return v < target ? Math.min(v + step, target) : Math.max(v - step, target);
}
