import { Block, hex, RGB } from "./blocks";

export enum Biome {
  Fungal,
  Crystal,
  Coral,
  Ember,
  Dunes,
  Tangle,
  Mesa,
  Frost,
}

export const BIOME_COUNT = 8;

export interface BiomeDef {
  name: string;
  /** Top block of exposed ground. */
  turf: Block;
  /** Layer under the turf, and how many cells of it. */
  soil: Block;
  soilDepth: number;
  stone: Block;
  /** Strength of the 2D noise that bends the surface into overhangs and arches (cells). */
  overhang: number;
  /** Sky at night, and in full daylight. */
  sky: RGB;
  daySky: RGB;
  star: RGB;
  water: RGB;
  waterFg: RGB;
}

export const BIOMES: Record<Biome, BiomeDef> = {
  [Biome.Fungal]: {
    name: "fungal forest",
    turf: Block.Mycel, soil: Block.Loam, soilDepth: 4, stone: Block.Plumstone, overhang: 3,
    sky: hex("#1f1830"), daySky: hex("#8a72b8"), star: hex("#6a5a8e"), water: hex("#4d4696"), waterFg: hex("#8079c9"),
  },
  [Biome.Crystal]: {
    name: "crystal barrens",
    turf: Block.Chalk, soil: Block.Chalk, soilDepth: 2, stone: Block.Quartzite, overhang: 0,
    sky: hex("#1a1b33"), daySky: hex("#7f94d8"), star: hex("#7f86c4"), water: hex("#3a86ae"), waterFg: hex("#7cc4e6"),
  },
  [Biome.Coral]: {
    name: "coral sea",
    turf: Block.Silt, soil: Block.Silt, soilDepth: 4, stone: Block.Reefstone, overhang: 0,
    sky: hex("#12252d"), daySky: hex("#5fb0bc"), star: hex("#4f8a94"), water: hex("#278e98"), waterFg: hex("#6fd0d4"),
  },
  [Biome.Ember]: {
    name: "ember wastes",
    turf: Block.Ash, soil: Block.Cinder, soilDepth: 3, stone: Block.Basalt, overhang: 4,
    sky: hex("#2a1619"), daySky: hex("#c07a62"), star: hex("#8a4a44"), water: hex("#6a3a5c"), waterFg: hex("#a8688e"),
  },
  [Biome.Dunes]: {
    name: "verdigris dunes",
    turf: Block.Tealsand, soil: Block.Tealsand, soilDepth: 6, stone: Block.Duneshale, overhang: 0,
    sky: hex("#2b2218"), daySky: hex("#c4a46c"), star: hex("#8a7450"), water: hex("#3a9c86"), waterFg: hex("#7fd4bc"),
  },
  [Biome.Tangle]: {
    name: "tangle",
    turf: Block.Bluemoss, soil: Block.Peat, soilDepth: 3, stone: Block.Tealstone, overhang: 10,
    sky: hex("#0f1d2b"), daySky: hex("#4f8fb0"), star: hex("#4a6f94"), water: hex("#2a66a8"), waterFg: hex("#6fa6e0"),
  },
  [Biome.Mesa]: {
    name: "strata mesa",
    turf: Block.Lichen, soil: Block.Lichen, soilDepth: 0, stone: Block.StrataUmber, overhang: 0,
    sky: hex("#2a1b24"), daySky: hex("#c48a98"), star: hex("#8a5a74"), water: hex("#38867f"), waterFg: hex("#7cc8c0"),
  },
  [Biome.Frost]: {
    name: "frost spires",
    turf: Block.Rime, soil: Block.Permafrost, soilDepth: 3, stone: Block.Glacierstone, overhang: 4,
    sky: hex("#17212d"), daySky: hex("#9ec2dc"), star: hex("#6f8aa6"), water: hex("#4f8fb8"), waterFg: hex("#9cd0ee"),
  },
};

export const DEEP_WATER: RGB = hex("#1f3a66");
export const DEEP_WATER_FG: RGB = hex("#4f76b0");

export const STRATA: Block[] = [
  Block.StrataRust,
  Block.StrataCream,
  Block.StrataViolet,
  Block.StrataTeal,
  Block.StrataUmber,
];

export const CRYSTALS: Block[] = [
  Block.CrystalRose,
  Block.CrystalCyan,
  Block.CrystalAmber,
  Block.CrystalViolet,
];

export const CAPS: Block[] = [Block.CapRose, Block.CapTeal, Block.CapAmber];
export const CORALS: Block[] = [Block.CoralPink, Block.CoralOrange, Block.CoralViolet];
