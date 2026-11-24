import { Block } from "./blocks";
import { World } from "./world";

/** Most cells one action can flood. */
export const FLOOD_CAP = 500;

const key = (x: number, y: number): number => (x + 1048576) * 256 + y;

/**
 * Which cells fill with water once the `opened` cells have turned to air. Water runs down
 * and sideways, never up, and settles lowest-first: it falls to the bottom of whatever it
 * pours into and rises level by level from there. Nothing in the world is changed; the
 * caller records the returned cells in the action that opened them, so undo takes the
 * flood back too.
 */
export function flood(world: World, opened: [number, number][]): [number, number][] {
  const state = new Map<number, Block>();
  for (const [x, y] of opened) state.set(key(x, y), Block.Air);
  const get = (x: number, y: number): Block => state.get(key(x, y)) ?? world.get(x, y);

  const rows = new Map<number, [number, number][]>();
  let lowest = -Infinity;
  const push = (x: number, y: number): void => {
    let row = rows.get(y);
    if (!row) rows.set(y, (row = []));
    row.push([x, y]);
    if (y > lowest) lowest = y;
  };
  for (const [x, y] of opened) push(x, y);

  const filled: [number, number][] = [];
  while (filled.length < FLOOD_CAP && lowest > -Infinity) {
    const row = rows.get(lowest);
    if (!row || row.length === 0) {
      rows.delete(lowest);
      lowest = -Infinity;
      for (const y of rows.keys()) if (y > lowest) lowest = y;
      continue;
    }
    const [x, y] = row.shift()!;
    if (get(x, y) !== Block.Air) continue;
    if (get(x, y - 1) !== Block.Water && get(x - 1, y) !== Block.Water && get(x + 1, y) !== Block.Water) continue;
    state.set(key(x, y), Block.Water);
    filled.push([x, y]);
    if (get(x, y + 1) === Block.Air) push(x, y + 1);
    if (get(x - 1, y) === Block.Air) push(x - 1, y);
    if (get(x + 1, y) === Block.Air) push(x + 1, y);
  }
  return filled;
}
