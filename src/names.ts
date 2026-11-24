import { Biome } from "./biomes";
import { hash2 } from "./noise";

const ONSETS = [
  "b", "bl", "br", "d", "dr", "f", "fl", "g", "gl", "gr", "j", "k", "kl", "l", "m", "n",
  "p", "pl", "qu", "r", "s", "sk", "sn", "sp", "squ", "t", "tw", "v", "w", "wh", "z",
];
const INNER = ["b", "d", "g", "k", "l", "m", "n", "p", "r", "s", "t", "v", "z", "sh", "ff"];
const VOWELS = ["a", "a", "e", "i", "o", "o", "u", "oo", "ee", "ai", "ou", "y"];
const CODAS = [
  "", "", "", "", "b", "bb", "g", "k", "m", "mp", "n", "nk", "p", "r", "rp", "sh", "t", "x", "z", "zz", "nd",
];
const SUFFIXES = [
  "", "", "", "", "", "ington", "bottom", "wick", "ola", "ford", "shire", "ton", "ville", "worth",
  "opolis", "bury", "dingle", "flap",
];
const TITLES = [
  "Lesser", "Greater", "Old", "Upper", "Lower", "Uncle", "Auntie", "Saint", "Big", "Little",
  "Sir", "Lady", "Grand", "Wee",
];

/** Place words for each biome, so a name says what kind of place it is. */
const FEATURES: Record<Biome, string[]> = {
  [Biome.Fungal]: ["Grove", "Woods", "Thicket", "Shroomery", "Sporelands"],
  [Biome.Crystal]: ["Barrens", "Shardlands", "Flats", "Glitterfield"],
  [Biome.Coral]: ["Sea", "Shallows", "Reef", "Lagoon", "Soup"],
  [Biome.Ember]: ["Wastes", "Badlands", "Cinders", "Scorchlands"],
  [Biome.Dunes]: ["Dunes", "Desert", "Sandpit", "Erg"],
  [Biome.Tangle]: ["Tangle", "Snarl", "Jungle", "Kerfuffle"],
  [Biome.Mesa]: ["Mesa", "Canyons", "Buttes", "Layercake"],
  [Biome.Frost]: ["Spires", "Peaks", "Tundra", "Icebox"],
};

/**
 * A silly name for a region of the world, the same every time for the same seed and
 * region: e.g. "Jihara Desert", "Uncle Snorf's Grove", "Lesser Plookington Shallows".
 */
export function regionName(seed: number, region: number, biome: Biome): string {
  let n = 0;
  const pick = <T>(list: T[]): T => list[hash2(seed + 700, region, n++) % list.length];
  const chance = (p: number): boolean => hash2(seed + 701, region, n++) / 4294967296 < p;

  // A root of one to three syllables: a cluster may start the word, but inside it only
  // single consonants, and consonants end a syllable only at the end of the root.
  let word = "";
  const syllables = chance(0.65) ? 2 : chance(0.6) ? 1 : 3;
  for (let i = 0; i < syllables; i++) {
    word += i === 0 ? pick(ONSETS) : pick(INNER);
    word += pick(VOWELS);
    if (i === syllables - 1) word += pick(CODAS);
  }
  if (word.length <= 6) word += pick(SUFFIXES);
  word = word[0].toUpperCase() + word.slice(1);

  const possessive = chance(0.2);
  const titled = chance(0.25);
  if (possessive) word += "'s";
  if (titled) word = `${pick(TITLES)} ${word}`;
  return `${word} ${pick(FEATURES[biome])}`;
}
