// Place-name normalisation shared by the gazetteer build (scripts/build-places.js),
// the server resolver (utils/places.js) and — byte-for-byte, pinned by the
// fixture tests/batch-s/fixtures/place-normalize-vectors.json — the customer
// site's suggestion matcher. Change it in all three places or not at all.
//
// "Panaji", " PANAJI ", "Panají" → "panaji"; "Vasco-da-Gama" → "vasco da gama";
// "J&K" → "j and k". compactKey drops the spaces so "Narendra Nagar" and
// "Narendranagar" (or "Dona Paula" / "Donapaula") compare equal.
const MAX_INPUT = 200;
const MAX_KEY = 100;

function normalizePlaceText(value) {
  if (value == null) return "";
  return String(value)
    .slice(0, MAX_INPUT)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2018\u2019`]/g, "") // apostrophes join: "St. Xavier's" -> "st xaviers"
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, MAX_KEY)
    .trim();
}

function compactKey(normalized) {
  return String(normalized || "").replace(/ /g, "");
}

// Damerau-Levenshtein (optimal string alignment) with an early exit once
// every cell of a row exceeds `max`; returns max + 1 when over the bound.
// Inputs are short normalised keys, so this stays in the microseconds.
function boundedEditDistance(a, b, max) {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (a === b) return 0;
  let prev2 = null;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[lb] > max ? max + 1 : prev[lb];
}

// How many edits a typed key may be away from a place name and still be
// auto-corrected: none below 4 characters ("goa" must never become "gaya"),
// one up to 7, two from 8.
function fuzzyBudget(len) {
  if (len < 4) return 0;
  if (len < 8) return 1;
  return 2;
}

module.exports = { normalizePlaceText, compactKey, boundedEditDistance, fuzzyBudget, MAX_INPUT, MAX_KEY };
