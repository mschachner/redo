import { Block } from "./blocks";
import type { LightField } from "./light";
import { BIOME_MONSTERS, boxesOverlap, DEEP_MONSTERS, Monster, MonsterKind, MONSTERS, WATER_MONSTERS } from "./monsters";
import type { Facing } from "./protocol";
import { World } from "./world";
import { wildness, WORLD_H } from "./worldgen";

/** How far past the player's facing edge J reaches (cells). */
export const ATTACK_REACH = 1.25;
/** How hard a hit knocks a monster back, and a monster's touch knocks the player back. */
export const ATTACK_KNOCKBACK = 9;
export const HIT_KNOCKBACK = 10;
const MAX_MONSTERS = 8; // near the origin; more out in the wilds
const SPAWN_INTERVAL = 1.5; // seconds, near the origin; shorter out in the wilds
/** Monsters appear within this many columns and rows of a player. */
export const SPAWN_RANGE_X = 44;
export const SPAWN_RANGE_Y = 30;
const SPAWN_MAX_LIGHT = 5; // monsters only appear in cells at most this bright
const DESPAWN_DISTANCE = 72;
/** How close (cells) counts as near a player, for the monster cap. */
const NEARBY = 60;

/** The region J attacks for a player at (x, y): a strip ATTACK_REACH deep past their facing edge. */
export function attackArea(x: number, y: number, facing: Facing): [number, number, number, number] {
  switch (facing) {
    case "right":
      return [x + 1, y, x + 1 + ATTACK_REACH, y + 1];
    case "left":
      return [x - ATTACK_REACH, y, x, y + 1];
    case "down":
      return [x, y + 1, x + 1, y + 1 + ATTACK_REACH];
    case "up":
      return [x, y - ATTACK_REACH, x + 1, y];
  }
}

/** Seconds between spawn attempts near column x: shorter out in the wilds. */
export function spawnInterval(x: number): number {
  return SPAWN_INTERVAL / (1 + 0.35 * wildness(x));
}

/** The most monsters near a player in column x: more out in the wilds. */
export function spawnCap(x: number): number {
  return Math.min(20, Math.round(MAX_MONSTERS + 3 * wildness(x)));
}

/** The monster kinds, by index, for sending over the wire. */
export const MONSTER_KINDS = Object.keys(MONSTERS) as MonsterKind[];

/**
 * The monsters in a world: where they are, how they move, appear, get hit and get
 * crushed. Alone, the game runs one; in a shared world, the server does.
 */
export class Population {
  readonly monsters: Monster[] = [];
  private nextId = 1;

  constructor(private world: World) {}

  /**
   * Move every monster a step toward the nearest target (players), and drop those far from
   * all of them.
   */
  step(dt: number, targets: { x: number; y: number }[]): void {
    for (let i = this.monsters.length - 1; i >= 0; i--) {
      const m = this.monsters[i];
      let best: { x: number; y: number } | undefined;
      let bestD = Infinity;
      for (const t of targets) {
        const d = Math.abs(t.x - m.x) + Math.abs(t.y - m.y);
        if (d < bestD) [best, bestD] = [t, d];
      }
      if (!best || Math.abs(m.x - best.x) > DESPAWN_DISTANCE || Math.abs(m.y - best.y) > DESPAWN_DISTANCE) {
        this.monsters.splice(i, 1);
        continue;
      }
      m.step(dt, this.world, best.x, best.y);
    }
  }

  /** A monster touching a player's box at (x, y), if any. */
  touching(x: number, y: number): Monster | undefined {
    return this.monsters.find((m) => boxesOverlap(m.x, m.y, x, y, 0.15));
  }

  /** The monsters within a region [x0, y0, x1, y1]. */
  inArea([x0, y0, x1, y1]: [number, number, number, number]): Monster[] {
    return this.monsters.filter((m) => m.x < x1 && m.x + 1 > x0 && m.y < y1 && m.y + 1 > y0);
  }

  /** How many monsters are within NEARBY cells of (x, y). */
  near(x: number, y: number): number {
    return this.monsters.filter((m) => Math.abs(m.x - x) < NEARBY && Math.abs(m.y - y) < NEARBY).length;
  }

  /**
   * Hit every monster in a region, knocking it away from (fromX, fromY). Returns what
   * happened, for the activity log.
   */
  hit(area: [number, number, number, number], fromX: number, fromY: number): string[] {
    const events: string[] = [];
    for (const m of this.inArea(area)) {
      m.hp -= 1;
      m.hurt = 0.18;
      m.knockFrom(fromX, fromY, ATTACK_KNOCKBACK);
      if (m.hp <= 0) {
        this.monsters.splice(this.monsters.indexOf(m), 1);
        events.push(`Killed ${m.def.name}`);
      } else {
        events.push(`Hit ${m.def.name}`);
      }
    }
    return events;
  }

  /** Remove monsters that a block now overlaps. Returns what happened, for the log. */
  crush(): string[] {
    const events: string[] = [];
    for (let i = this.monsters.length - 1; i >= 0; i--) {
      const m = this.monsters[i];
      if (!this.world.boxHitsSolid(m.x, m.y)) continue;
      this.monsters.splice(i, 1);
      events.push(`Crushed ${m.def.name}`);
    }
    return events;
  }

  /**
   * Spawn a monster in a random dark cell near (but not right next to) a player at
   * (px, py), using `light` (which must cover that area). The kind is chosen first, from
   * those of the biome (or the deep) at a random spot; then a cell that suits it is
   * searched for: water for swimmers, open air for flyers, and the first floor below for
   * walkers, hoppers and chargers.
   */
  trySpawn(light: LightField, px: number, py: number): void {
    const world = this.world;
    const terrain = world.terrain;
    const pickX = () => Math.round(px) + Math.floor((Math.random() * 2 - 1) * SPAWN_RANGE_X);
    const pickY = () => Math.round(py) + Math.floor((Math.random() * 2 - 1) * SPAWN_RANGE_Y);
    const dark = (x: number, y: number): boolean => {
      const i = light.index(x, y);
      if (i < 0) return false;
      const [r, g, b] = light.rgb;
      return Math.max(r[i], g[i], b[i]) <= SPAWN_MAX_LIGHT;
    };

    const ax = pickX();
    const ay = pickY();
    const pool: MonsterKind[] = ay >= terrain.deepLine(ax) ? DEEP_MONSTERS : BIOME_MONSTERS[terrain.biomeAt(ax)];
    let kind = pool[Math.floor(Math.random() * pool.length)];
    const behavior = MONSTERS[kind].behavior;

    for (let attempt = 0; attempt < 40; attempt++) {
      const x = attempt === 0 ? ax : pickX();
      let y = attempt === 0 ? ay : pickY();
      if (behavior === "walker" || behavior === "hopper" || behavior === "charger") {
        // Drop to the first floor below, through air only.
        let fall = 0;
        while (fall < SPAWN_RANGE_Y && world.get(x, y + 1) === Block.Air) {
          y++;
          fall++;
        }
        if (world.get(x, y) !== Block.Air || !world.solid(x, y + 1)) continue;
      } else if (behavior === "swimmer") {
        if (world.get(x, y) !== Block.Water) continue;
      } else if (world.get(x, y) !== Block.Air) {
        // Flyers can't use water; send an eel there instead.
        if (world.get(x, y) !== Block.Water) continue;
        kind = WATER_MONSTERS[0];
      }
      if (Math.abs(x - px) < 14 && Math.abs(y - py) < 10) continue;
      if (y < 1 || y >= WORLD_H - 1) continue;
      if (!dark(x, y)) continue;
      if (this.monsters.some((m) => boxesOverlap(m.x, m.y, x, y))) continue;
      const m = new Monster(kind, x, y, wildness(x));
      m.id = this.nextId++;
      this.monsters.push(m);
      return;
    }
  }
}
