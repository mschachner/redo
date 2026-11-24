import { MAX_LIGHT } from "./light";

/** Real seconds per in-game day. */
export const DAY_SECONDS = 720;
/** The hour a world starts at, and that sleeping wakes the player at. */
export const START_HOUR = 7;
/** The hour from which the player can rest at the campfire (and it's lit). */
export const BEDTIME = 21;
/** The hour at which the player is told they're getting sleepy. */
export const SLEEPY_HOUR = 23;

/** How much daylight there is at an hour of the day, from 0 (night) to 1 (full day). */
export function daylight(hour: number): number {
  const ramp = (a: number, b: number): number => {
    const t = Math.max(0, Math.min(1, (hour - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  return ramp(5, 7.5) * (1 - ramp(17.5, 20));
}

/** Sunlight at night, as a light level. */
const NIGHT_SUN = 4;

/** The strength of sunlight at the top of the sky at an hour (a light level, 0–15). */
export function sunLevel(hour: number): number {
  return Math.round(NIGHT_SUN + (MAX_LIGHT - NIGHT_SUN) * daylight(hour));
}

/** The light the player carries, per channel. */
export const LAMP = [11, 10, 8];
