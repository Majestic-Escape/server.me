// Property-type words people put in a search ("tent in dharamshala",
// "villas in goa", "panjim hotel", "guest house calangute"), mapped to the
// stored `propertyType` values. Normalised (utils/placeText) phrases; the
// longest phrase wins. Words that mean "any stay" are not types.
const { normalizePlaceText } = require("./placeText");

const TYPES = {
  villa: ["villa", "villas"],
  hotel: ["hotel", "hotels", "resort", "resorts"],
  apartment: ["apartment", "apartments", "flat", "flats", "apt", "apts", "condo apartment"],
  house: ["house", "houses", "independent house"],
  guesthouse: ["guesthouse", "guesthouses", "guest house", "guest houses"],
  farmhouse: ["farmhouse", "farmhouses", "farm house", "farm houses", "farmstay", "farmstays", "farm stay", "farm stays"],
  cottage: ["cottage", "cottages"],
  cabin: ["cabin", "cabins"],
  bungalow: ["bungalow", "bungalows"],
  condo: ["condo", "condos"],
  townhouse: ["townhouse", "townhouses", "town house", "town houses"],
  treehouse: ["treehouse", "treehouses", "tree house", "tree houses"],
  houseboat: ["houseboat", "houseboats", "house boat", "house boats"],
  tent: ["tent", "tents", "camp", "camps", "camping", "glamping"],
  yurt: ["yurt", "yurts"],
  dome: ["dome", "domes"],
  lighthouse: ["lighthouse", "lighthouses"],
};

const PHRASES = new Map(); // "guest house" -> "guesthouse"
for (const [type, words] of Object.entries(TYPES)) for (const w of words) PHRASES.set(normalizePlaceText(w), type);
const MAX_WORDS = Math.max(...[...PHRASES.keys()].map((p) => p.split(" ").length));

// Glue between a type and a place, and words that mean "any stay".
const CONNECTORS = new Set(["in", "at", "near", "around", "on", "the", "a", "an", "of", "for", "to", "with", "and", "stay", "stays", "homestay", "homestays", "home", "homes", "property", "properties", "place", "places", "rental", "rentals", "accommodation", "accommodations"]);

/**
 * { type, rest } when the normalised text names a property type:
 *   "tent in dharamshala" → { type:"tent", rest:"dharamshala" }
 *   "north goa villas"    → { type:"villa", rest:"north goa" }
 *   "villas"              → { type:"villa", rest:"" }
 * null when it names none.
 */
function extractPropertyType(norm) {
  const tokens = String(norm || "").split(" ").filter(Boolean);
  for (let n = Math.min(MAX_WORDS, tokens.length); n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const type = PHRASES.get(tokens.slice(i, i + n).join(" "));
      if (!type) continue;
      const rest = [...tokens.slice(0, i), ...tokens.slice(i + n)].filter((t) => !CONNECTORS.has(t)).join(" ");
      return { type, rest };
    }
  }
  return null;
}

/** The searchable words of a stored type ("guesthouse" → guesthouse, guest, house). */
function typeWords(type) {
  const t = String(type || "").toLowerCase();
  const words = new Set([t]);
  for (const w of TYPES[t] || []) for (const x of normalizePlaceText(w).split(" ")) words.add(x);
  return [...words].filter(Boolean);
}

module.exports = { extractPropertyType, typeWords, CONNECTORS, TYPES };
