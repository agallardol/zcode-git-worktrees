// Friendly auto-generated worktree names (adjective-animal), like Claude Code's
// "bright-running-fox". Deterministic uniqueness against a taken set.
import { randomInt } from "node:crypto";

const ADJECTIVES = [
  "amber", "arctic", "autumn", "azure", "brisk", "calm", "candid", "clever",
  "cobalt", "cosmic", "crisp", "dawn", "delta", "diverse", "eager", "early",
  "ebony", "echo", "ember", "fern", "flint", "forge", "frost", "gentle",
  "golden", "harbor", "hazel", "ionic", "ivory", "jasper", "jolly", "keen",
  "lagoon", "later", "lilac", "lucid", "lunar", "mellow", "misty", "noble",
  "northern", "opal", "pacific", "polar", "quiet", "rapid", "royal", "rustic",
  "savvy", "scarlet", "serene", "silent", "silver", "solar", "southern", "steady",
  "summer", "sunset", "terse", "thermal", "tidal", "urban", "verbal", "vivid",
  "western", "wired", "witty", "zesty",
];

const ANIMALS = [
  "anchovy", "avocet", "badger", "barnacle", "beagle", "bobcat", "bonobo",
  "burrito", "capibara", "cardinal", "chinchilla", "cormorant", "crab",
  "cricket", "dachshund", "dolphin", "dragonfly", "dunlin", "eagle", "echidna",
  "falcon", "flamingo", "fox", "gecko", "gibbon", "grouse", "harrier", "heron",
  "honeybee", "humboldt", "ibex", "iguana", "jackal", "jellyfish", "kakapo",
  "koala", "ladybug", "lemur", "loris", "lynx", "marmot", "meerkat", "narwhal",
  "numbat", "ocelot", "octopus", "orca", "osprey", "otter", "pangolin",
  "parakeet", "penguin", "pika", "puffin", "puma", "quokka", "raven", "red panda",
  "salamander", "sandpiper", "seahorse", "shrimp", "stoat", "sunfish", "tapir",
  "toucan", "tarsier", "walrus", "wombat", "yak",
].map((a) => a.replace(/[^a-z]/g, "")); // keep names single-segment

// Exported for tests and future customization.
export const WORD_LISTS = { adjectives: ADJECTIVES, animals: ANIMALS };

export function friendlyName(taken = new Set()) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${
      ANIMALS[randomInt(ANIMALS.length)]
    }`;
    if (!taken.has(name)) return name;
  }
  // Extremely unlikely; fall back to a random-suffixed name.
  return `worktree-${randomInt(0xffffff).toString(16).padStart(6, "0")}`;
}
