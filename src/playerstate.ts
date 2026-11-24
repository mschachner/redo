import type { Block } from "./blocks";
import type { Game } from "./game";
import type { Action } from "./history";
import type { PlayerState, WireAction } from "./protocol";

/**
 * A player's state in a shared world, as kept by the server between visits: position,
 * health, inventory, stack slots and both stacks.
 */
export function exportState(game: Game): PlayerState {
  const p = game.player;
  const inv = game.inventory;
  const wire = (a: Action): WireAction => ({
    kind: a.kind,
    cells: a.cells.map((c) => [c.x, c.y, c.before, c.after, c.beforeText ?? null, c.afterText ?? null]),
    inventory: [...a.inventory],
  });
  return {
    x: Math.round(p.x * 100) / 100,
    y: Math.round(p.y * 100) / 100,
    hp: p.hp,
    facing: p.facing,
    day: game.day,
    inventory: inv.slots.map((b) => [b, inv.count(b)]),
    selected: inv.selectedBlock() ?? null,
    keptSlots: game.keptSlots,
    daySlots: game.daySlots,
    undo: game.history.undoStack.map(wire),
    redo: game.history.redoStack.map(wire),
  };
}

/**
 * Restore a returning player. If a morning has come since they left, their changes were
 * committed then (as for everyone) and the day's extra slots are gone. Any action whose
 * cells others have changed in the meantime can't be undone or redone any more, so it
 * leaves the stacks.
 */
export function importState(game: Game, s: PlayerState): void {
  const p = game.player;
  p.x = p.prevX = s.x;
  p.y = p.prevY = s.y;
  p.vx = p.vy = 0;
  p.hp = s.hp;
  p.facing = s.facing;
  for (const [b, n] of s.inventory) game.inventory.add(b as Block, n);
  game.inventory.select(s.selected === null ? undefined : (s.selected as Block));
  game.keptSlots = s.keptSlots;
  const sameDay = s.day >= game.day;
  game.daySlots = sameDay ? s.daySlots : 0;
  if (!sameDay) return;
  const action = (w: WireAction): Action => ({
    kind: w.kind,
    cells: w.cells.map(([x, y, before, after, bt, at]) => ({
      x,
      y,
      before: before as Block,
      after: after as Block,
      ...(bt !== null ? { beforeText: bt } : {}),
      ...(at !== null ? { afterText: at } : {}),
    })),
    inventory: new Map(w.inventory.map(([b, n]) => [b as Block, n])),
  });
  game.history.undoStack.push(...still(game, s.undo.map(action), "backward"));
  game.history.redoStack.push(...still(game, s.redo.map(action), "forward"));
}

/**
 * The actions of a stack (bottom first) that can still be applied in order from the top:
 * each is checked against the world as the ones above it would leave it, and one that no
 * longer fits is dropped (it stays as it is, committed).
 */
function still(game: Game, stack: Action[], way: "forward" | "backward"): Action[] {
  const overlay = new Map<string, Block>();
  const at = (x: number, y: number): Block => overlay.get(`${x},${y}`) ?? game.world.get(x, y);
  const kept: Action[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const a = stack[i];
    const fits = a.cells.every((c) => at(c.x, c.y) === (way === "forward" ? c.before : c.after));
    if (!fits) continue;
    for (const c of a.cells) overlay.set(`${c.x},${c.y}`, way === "forward" ? c.after : c.before);
    kept.unshift(a);
  }
  return kept;
}
