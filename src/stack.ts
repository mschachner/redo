/**
 * The most actions the undo stack holds to begin with; pickups and kills add to it. When
 * it's full, new actions (and attacks) are refused until something is undone. (A new action
 * clears the redo stack, so the two stacks together never hold more than the limit either.)
 */
export const BASE_STACK = 4;

/**
 * How hard a swing hits: one point of damage for each empty stack slot, so a player who has
 * done less is stronger, and one with a full stack can't attack at all.
 */
export function swingStrength(keptSlots: number, daySlots: number, used: number): number {
  return Math.max(0, BASE_STACK + keptSlots + daySlots - used);
}
