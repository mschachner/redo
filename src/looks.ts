/**
 * How a player appears in a shared world: a character, its color, and the dark glow
 * around it. Each is chosen on the join screen from these sets, and the server accepts
 * nothing else.
 *
 * Monsters are lowercase letters and blocks use punctuation, so players get uppercase
 * letters (all but Y, which a block uses), Greek capitals, and old terminal symbols.
 */

/** Asks for the text (not emoji) form of a symbol. */
const TEXT = "︎";

export const CHARACTERS: readonly string[] = [
  "@",
  ...["☺", "☻", "♥", "♦", "♣", "♠", "♪", "☼", "★"].map((c) => c + TEXT),
  "$",
  "?",
  "§",
  "¤",
  ..."ΓΔΘΛΞΠΣΦΨΩ",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXZ",
];

export const COLORS: readonly { name: string; hex: string }[] = [
  { name: "cream", hex: "#f4e8cf" },
  { name: "butter", hex: "#ffe8a0" },
  { name: "peach", hex: "#ffc9a8" },
  { name: "coral", hex: "#ffb0a0" },
  { name: "pink", hex: "#ffb3c7" },
  { name: "orchid", hex: "#f0b8ec" },
  { name: "lavender", hex: "#d4bcff" },
  { name: "periwinkle", hex: "#b8c4ff" },
  { name: "sky", hex: "#a8d8ff" },
  { name: "seafoam", hex: "#a8ece0" },
  { name: "mint", hex: "#bdf2c4" },
  { name: "lime", hex: "#def2a8" },
];

export const GLOWS: readonly { name: string; hex: string }[] = [
  { name: "ink", hex: "#100e14" },
  { name: "plum", hex: "#2e1238" },
  { name: "wine", hex: "#3a1020" },
  { name: "rust", hex: "#3a1a0c" },
  { name: "umber", hex: "#2e2410" },
  { name: "moss", hex: "#16280e" },
  { name: "pine", hex: "#0c2a24" },
  { name: "navy", hex: "#0e1a3a" },
];

export interface Look {
  character: string;
  /** Hex colors, from COLORS and GLOWS. */
  color: string;
  glow: string;
}

/** The look before any choice: the classic @, cream on ink. */
export const DEFAULT_LOOK: Look = { character: "@", color: COLORS[0].hex, glow: GLOWS[0].hex };

/** A look from untrusted input: each part that isn't one of the choices is the default's. */
export function readLook(raw: unknown): Look {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Look, unknown>>;
  return {
    character: CHARACTERS.includes(r.character as string) ? (r.character as string) : DEFAULT_LOOK.character,
    color: COLORS.some((c) => c.hex === r.color) ? (r.color as string) : DEFAULT_LOOK.color,
    glow: GLOWS.some((g) => g.hex === r.glow) ? (r.glow as string) : DEFAULT_LOOK.glow,
  };
}

/** A favicon showing a look: the character on the page's charcoal, haloed in its glow. */
export function faviconSvg(look: Look): string {
  const ch = look.character.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  // The outline goes under the fill (paint-order), so it doesn't thin the character.
  const text = `x="32" y="34" text-anchor="middle" dominant-baseline="central" font-family="Menlo, ui-monospace, monospace" font-weight="bold" font-size="56" stroke="${look.glow}" stroke-linejoin="round" paint-order="stroke"`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    '<filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>',
    '<rect width="64" height="64" rx="14" fill="#26252b"/>',
    `<text ${text} stroke-width="10" fill="${look.glow}" filter="url(#g)">${ch}</text>`,
    `<text ${text} stroke-width="6" fill="${look.color}">${ch}</text>`,
    "</svg>",
  ].join("");
}
