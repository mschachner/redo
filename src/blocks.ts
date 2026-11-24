export enum Block {
  Air = 0,
  Water,
  Bedrock,

  // Fungal forest
  Mycel,
  Loam,
  Plumstone,
  Stalk,
  CapRose,
  CapTeal,
  CapAmber,
  Gills,
  Sporelight,
  Shroomlet,

  // Crystal barrens
  Chalk,
  Quartzite,
  CrystalRose,
  CrystalCyan,
  CrystalAmber,
  CrystalViolet,
  GeodeShell,

  // Coral sea
  Silt,
  Reefstone,
  CoralPink,
  CoralOrange,
  CoralViolet,
  Anemone,
  Pearl,
  Kelp,
  Glowweed,

  // Ember wastes
  Ash,
  Cinder,
  Basalt,
  Obsidian,
  Magma,
  Emberstone,

  // Verdigris dunes
  Tealsand,
  Duneshale,
  Bone,
  Salt,

  // Tangle
  Bluemoss,
  Peat,
  Tealstone,
  Vinewood,
  Frond,
  BulbLantern,
  Vine,

  // Strata mesa
  Lichen,
  StrataRust,
  StrataCream,
  StrataViolet,
  StrataTeal,
  StrataUmber,

  // Frost spires
  Rime,
  Permafrost,
  Glacierstone,
  Ice,
  LumenIce,
  Frostflower,

  // Sky islands
  Skyturf,
  Cloudstone,
  Glowroot,

  // Underground
  Glowmoss,
  Deepstone,
  Starstone,

  // Placed by players
  Sign,
  /** The fire at the spawn, where the player rests. */
  Campfire,
  /** Pickups: one more stack slot until the player next sleeps, or for good. */
  DayStack,
  KeepStack,
}

export type RGB = readonly [number, number, number];

export interface BlockDef {
  name: string;
  /** Blocks movement. */
  solid: boolean;
  /** Swimmable: water itself, and plants that grow in it. */
  liquid: boolean;
  breakable: boolean;
  /** Cell color; null draws whatever is behind the block (sky, cave wall, water). */
  bg: RGB | null;
  fg: RGB;
  /** Texture glyphs; one is picked per cell by position hash. */
  glyphs: string;
  /** Light given off, per color channel, 0–15. */
  emit: RGB | null;
  /** Solid, but lets light through easily (crystals, ice, foliage). */
  translucent: boolean;
}

export const hex = (s: string): RGB => {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

type Extra = Partial<Pick<BlockDef, "emit" | "translucent" | "breakable">>;

function solid(name: string, bg: string, fg: string, glyphs: string, extra: Extra = {}): BlockDef {
  return {
    name, solid: true, liquid: false, breakable: true,
    bg: hex(bg), fg: hex(fg), glyphs, emit: null, translucent: false, ...extra,
  };
}

/** A plant or strand the player walks through; `aquatic` ones count as water for swimming. */
function passable(name: string, fg: string, glyphs: string, aquatic = false, emit: RGB | null = null): BlockDef {
  return {
    name, solid: false, liquid: aquatic, breakable: true,
    bg: null, fg: hex(fg), glyphs, emit, translucent: false,
  };
}

export const BLOCKS: BlockDef[] = [];
const B = BLOCKS;

B[Block.Air] = {
  name: "air", solid: false, liquid: false, breakable: false,
  bg: null, fg: hex("#2c2934"), glyphs: " ", emit: null, translucent: false,
};
B[Block.Water] = {
  name: "water", solid: false, liquid: true, breakable: false,
  bg: null, fg: hex("#5fa0cf"), glyphs: "~", emit: null, translucent: false,
};
B[Block.Bedrock] = solid("bedrock", "#201e26", "#34303d", "×▪×", { breakable: false });

B[Block.Mycel] = solid("mycel", "#7b5ea7", "#a98bd6", "\"',\"");
B[Block.Loam] = solid("loam", "#4a3556", "#5e4670", "·., ·");
B[Block.Plumstone] = solid("plumstone", "#5a4f6b", "#70647f", ":.  ·'");
B[Block.Stalk] = solid("stalk", "#d9cbb0", "#bfae90", "║│║");
B[Block.CapRose] = solid("rose cap", "#c8527a", "#e58aa6", "°o ·", { translucent: true });
B[Block.CapTeal] = solid("teal cap", "#3f9c95", "#7fd0c4", "°o ·", { translucent: true });
B[Block.CapAmber] = solid("amber cap", "#d49a45", "#f0c987", "°o ·", { translucent: true });
B[Block.Gills] = solid("gills", "#cdb8e8", "#f1e6ff", "╥┬", { emit: [8, 6, 11], translucent: true });
B[Block.Sporelight] = solid("sporelight", "#58e0c8", "#d6fff5", "*°", { emit: [3, 13, 11], translucent: true });
B[Block.Shroomlet] = passable("shroomlet", "#7fe3d0", "τ", false, [1, 6, 5]);

B[Block.Chalk] = solid("chalk", "#c4bccf", "#a9a0b8", "·. '");
B[Block.Quartzite] = solid("quartzite", "#8c84a6", "#a39bbd", "/. \\ ");
B[Block.CrystalRose] = solid("rose crystal", "#e06aa8", "#ffc1e0", "◆/\\", { emit: [12, 4, 9], translucent: true });
B[Block.CrystalCyan] = solid("cyan crystal", "#49c6e0", "#c4f4ff", "◆/\\", { emit: [3, 11, 13], translucent: true });
B[Block.CrystalAmber] = solid("amber crystal", "#e9b44c", "#fff0b8", "◆/\\", { emit: [13, 10, 3], translucent: true });
B[Block.CrystalViolet] = solid("violet crystal", "#9a6be0", "#dcc8ff", "◆/\\", { emit: [8, 5, 13], translucent: true });
B[Block.GeodeShell] = solid("geode shell", "#3d3a4a", "#595468", "#%#");

B[Block.Silt] = solid("silt", "#d9a99a", "#c48f82", "·.:, ");
B[Block.Reefstone] = solid("reefstone", "#7d6a78", "#94808e", "o. ·°");
B[Block.CoralPink] = solid("pink coral", "#f07a9a", "#ffb3c4", "Y%&");
B[Block.CoralOrange] = solid("orange coral", "#f09a4f", "#ffd0a0", "Y%&");
B[Block.CoralViolet] = solid("violet coral", "#a678e0", "#d4b8ff", "Y%&");
B[Block.Anemone] = solid("anemone", "#ff8fd0", "#ffe0f3", "*", { emit: [12, 5, 10], translucent: true });
B[Block.Pearl] = solid("pearl", "#f4f0e6", "#ffffff", "o", { emit: [10, 10, 9], translucent: true });
B[Block.Kelp] = passable("kelp", "#5fc48a", "(){}", true);
B[Block.Glowweed] = passable("glowweed", "#7fffd4", "!;:", true, [2, 9, 7]);

B[Block.Ash] = solid("ash", "#6b6468", "#857d82", "·.: ");
B[Block.Cinder] = solid("cinder", "#4f4347", "#6b5c60", "·,. ");
B[Block.Basalt] = solid("basalt", "#3a363d", "#4d4852", "|║ .");
B[Block.Obsidian] = solid("obsidian", "#231c2e", "#5a3f7a", "/\\ ");
B[Block.Magma] = solid("magma", "#f0762a", "#ffd24a", "~≈∙", { emit: [14, 7, 2] });
B[Block.Emberstone] = solid("emberstone", "#4a2f33", "#ff7a3c", "•∙ ", { emit: [8, 3, 1] });

B[Block.Tealsand] = solid("teal sand", "#6fb8a8", "#57a090", "·.~ ");
B[Block.Duneshale] = solid("dune shale", "#3f6e68", "#4f8580", "-= .");
B[Block.Bone] = solid("bone", "#e9e1cf", "#cfc5ad", "=≡|");
B[Block.Salt] = solid("salt", "#f2f2f4", "#d0d0da", "·+ ");

B[Block.Bluemoss] = solid("bluemoss", "#3f7fb8", "#7fb8e8", "\"',\"");
B[Block.Peat] = solid("peat", "#2f4f5a", "#3f6672", "·., ");
B[Block.Tealstone] = solid("tealstone", "#3d5560", "#51707c", ":.  ·");
B[Block.Vinewood] = solid("vinewood", "#2b5e62", "#3f8a86", "║│║");
B[Block.Frond] = solid("frond", "#2fa7b8", "#7fe0e8", "%&*%", { translucent: true });
B[Block.BulbLantern] = solid("bulb lantern", "#d8f06a", "#fbffcc", "o°", { emit: [11, 13, 4], translucent: true });
B[Block.Vine] = passable("vine", "#4fd0a0", "|¦:");

B[Block.Lichen] = solid("lichen", "#b8c05a", "#d8e08a", "\"·'");
B[Block.StrataRust] = solid("rust strata", "#b5543c", "#cc6f55", "-= _");
B[Block.StrataCream] = solid("cream strata", "#e3c9a0", "#cdb288", "-= _");
B[Block.StrataViolet] = solid("violet strata", "#7a5a9a", "#9173b1", "-= _");
B[Block.StrataTeal] = solid("teal strata", "#4f9a94", "#68b3ad", "-= _");
B[Block.StrataUmber] = solid("umber strata", "#6e4a3a", "#86604f", "-= _");

B[Block.Rime] = solid("rime", "#dfeaf2", "#bccfde", "·*' ");
B[Block.Permafrost] = solid("permafrost", "#6f8a9e", "#87a2b6", "·., ");
B[Block.Glacierstone] = solid("glacierstone", "#55687c", "#6b8096", ":.  ·");
B[Block.Ice] = solid("ice", "#9fd4e8", "#d4f0fa", "/ \\ ", { translucent: true });
B[Block.LumenIce] = solid("lumen ice", "#7ff0e8", "#ffffff", "*/", { emit: [4, 12, 12], translucent: true });
B[Block.Frostflower] = passable("frostflower", "#d4f0fa", "*");

B[Block.Skyturf] = solid("skyturf", "#7fe0b0", "#b8f5d4", "\"',\"");
B[Block.Cloudstone] = solid("cloudstone", "#c9c0de", "#e3dcf2", "~· ·");
B[Block.Glowroot] = passable("glowroot", "#ffd27a", "¦|:", false, [10, 8, 3]);

B[Block.Glowmoss] = solid("glowmoss", "#3f8f5a", "#9fffb0", "\"·'", { emit: [3, 10, 5] });
B[Block.Deepstone] = solid("deepstone", "#2a2c40", "#383b55", "·. ·");
B[Block.Starstone] = solid("starstone", "#2a2c40", "#e8f0ff", "∙·+", { emit: [8, 9, 12] });

B[Block.Sign] = passable("sign", "#e0bf8a", "¶");
B[Block.DayStack] = { ...passable("stack slot for the day", "#7fe0e8", "+", false, [3, 9, 11]), breakable: false };
B[Block.KeepStack] = { ...passable("stack slot", "#ffd24a", "+", false, [13, 10, 3]), breakable: false };
B[Block.Campfire] = { ...passable("campfire", "#ffa53c", "▲▴", false, [14, 9, 4]), breakable: false };

for (const v of Object.values(Block)) {
  if (typeof v === "number" && !BLOCKS[v]) throw new Error(`Block ${Block[v]} has no definition`);
}

export const isSolid = (b: Block): boolean => BLOCKS[b].solid;
export const isLiquid = (b: Block): boolean => BLOCKS[b].liquid;
