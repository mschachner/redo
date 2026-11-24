/**
 * World seeds as words: a seed is any sequence of lowercase words in kebab-case, like
 * `fuzzy-violet-comet`. New worlds get three random words (a size, a color, a thing);
 * any other phrase works too, and is hashed to the number the generator uses.
 */

const FIRST = [
  "tiny", "wee", "small", "little", "big", "huge", "giant", "tall", "long", "short", "round",
  "flat", "soft", "hard", "fuzzy", "fluffy", "spiky", "lumpy", "bumpy", "wobbly", "crooked",
  "tangled", "hollow", "sleepy", "drowsy", "dizzy", "giddy", "grumpy", "jolly", "merry", "shy",
  "bold", "brave", "lazy", "busy", "quiet", "loud", "noisy", "silly", "odd", "strange", "curious",
  "clever", "humble", "proud", "lucky", "plucky", "sneaky", "nimble", "clumsy", "gentle", "wild",
  "tame", "ancient", "young", "early", "late", "frosty", "sunny", "rainy", "windy", "foggy",
  "misty", "stormy", "dusty", "sandy", "muddy", "salty", "sweet", "sour", "spicy", "crispy",
  "crunchy", "chewy", "sticky", "squishy", "bouncy", "rusty", "shiny", "glossy", "velvet",
  "woolly", "hairy", "feathered", "scaly", "speckled", "spotted", "striped", "dappled", "patched",
  "sparkly", "glowing", "humming", "singing", "whistling", "dancing", "drifting", "floating",
  "sunken", "buried", "lost", "hidden", "secret", "forgotten",
];

const SECOND = [
  "red", "orange", "amber", "golden", "yellow", "lemon", "lime", "green", "olive", "mossy",
  "minty", "jade", "teal", "aqua", "cyan", "azure", "blue", "navy", "indigo", "violet", "purple",
  "plum", "lilac", "lavender", "magenta", "pink", "rosy", "coral", "peach", "apricot", "tawny",
  "brown", "copper", "bronze", "ochre", "tan", "beige", "ivory", "cream", "white", "pearly",
  "silver", "gray", "ashen", "slate", "charcoal", "inky", "black", "smoky", "cloudy", "pale",
  "dusky", "frosted", "sugared", "toasted", "candied", "pickled", "minted", "honeyed", "buttered",
];

const THIRD = [
  "comet", "moon", "star", "planet", "meteor", "nebula", "quasar", "galaxy", "orbit", "eclipse",
  "pebble", "boulder", "crystal", "geode", "gem", "shard", "ember", "cinder", "spark", "flame",
  "puddle", "pond", "lake", "river", "brook", "ocean", "wave", "tide", "reef", "lagoon", "island",
  "cove", "cliff", "canyon", "valley", "meadow", "hill", "mountain", "volcano", "glacier", "dune",
  "mesa", "cave", "grotto", "tunnel", "burrow", "nest", "hive", "garden", "orchard", "forest",
  "thicket", "jungle", "swamp", "marsh", "bog", "tundra", "desert", "oasis", "prairie", "moss",
  "fern", "mushroom", "toadstool", "acorn", "pinecone", "thistle", "clover", "daisy", "tulip",
  "lily", "orchid", "cactus", "kelp", "coral", "sponge", "shell", "snail", "slug", "beetle",
  "moth", "firefly", "cricket", "spider", "crab", "lobster", "squid", "octopus", "jellyfish",
  "eel", "newt", "frog", "toad", "turtle", "tortoise", "lizard", "gecko", "badger", "otter",
  "beaver", "mole", "vole", "shrew", "hedgehog", "ferret", "weasel", "rabbit", "hare", "fox",
  "wolf", "bear", "moose", "yak", "llama", "camel", "goat", "sheep", "pig", "duck", "goose",
  "swan", "heron", "owl", "crow", "raven", "sparrow", "finch", "penguin", "puffin", "walrus",
  "noodle", "dumpling", "muffin", "biscuit", "pancake", "waffle", "pudding", "teapot", "kettle",
  "lantern", "bucket", "spoon", "button", "thimble", "trumpet", "banjo", "kazoo", "drum",
];

const pick = (list: string[]): string => list[Math.floor(Math.random() * list.length)];

/** Three random words for a new world. */
export function randomSeedName(): string {
  return `${pick(FIRST)}-${pick(SECOND)}-${pick(THIRD)}`;
}

/**
 * Tidy a typed seed into kebab-case (lowercase letters, words joined by hyphens), or
 * undefined if no letters are left. Numbers aren't seeds; a URL left over from before
 * word seeds (`?seed=1426465597`) is ignored, and the new world gets random words.
 */
export function normalizeSeed(text: string): string | undefined {
  const words = text.trim().toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.length ? words.join("-") : undefined;
}

/**
 * The number the world generator uses for a seed: a hash of its words (FNV-1a). Worlds
 * saved before word seeds have a number for a seed, which is used directly.
 */
export function seedNumber(name: string): number {
  if (/^\d+$/.test(name)) return Number(name);
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 1 + ((h >>> 0) % (2 ** 31 - 1));
}
