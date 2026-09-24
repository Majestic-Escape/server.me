// GET /api/v1/places/index — the customer site's destination suggestions
// (services/placeSearch.clientIndex). Public, edge-cached like the rest of
// the catalogue (5 min + purge on listing changes via the `listings` tag):
// one small read per cache miss, zero per keystroke — the site matches
// locally.
const ListingProperty = require("../models/ListingProperty");
const placeSearch = require("../services/placeSearch");
const { catalogueCache } = require("../utils/httpCache");
const { CARD_PROJECTION } = require("../utils/listingProjection");
const { sanitizeProperty } = require("../utils/sanitizeResponse");
const { normalizePlaceText } = require("../utils/placeText");

const MAX_STAYS = 5;

// GET /api/v1/places/stays?q= — stays whose NAME matches what is being
// typed ("dev bhoo" → "Dev Bhoomi Retreat - Classic Tent"), for guests who
// remember a property but not where it is. At most 5, best title match
// first; titles exactly as the public card shows them (contact details
// masked by sanitizeProperty). Edge-cached per query like the catalogue;
// ≤ 2 small reads per cache miss, none for queries under 3 letters.
exports.suggestStays = async (req, res) => {
  const { q } = req.query;
  if (typeof q !== "string" || q.length > 100) {
    return res.status(400).json({ success: false, code: "INVALID_SEARCH_PARAM", param: "q", message: "q must be a single value of up to 100 characters", statusCode: 400 });
  }
  try {
    if (!catalogueCache(req, res)) return;
    const tokens = placeSearch.keywordTokens(normalizePlaceText(q));
    if (!tokens.length || tokens.join("").length < 3) return res.json({ stays: [] });
    const phrase = tokens.join(" ");
    const docs = await ListingProperty.find({ status: "active" }).select(placeSearch.LOCATION_PROJECTION).lean();
    const scored = [];
    for (const c of placeSearch.classifyAll(docs)) {
      const s = placeSearch.keywordScore(c, tokens, phrase);
      // a name suggestion needs the title to match (a place alone is the
      // destination list's job): scores 0-2
      if (s >= 0 && s <= 2) scored.push([c, s]);
    }
    scored.sort((x, y) => x[1] - y[1] || (new Date(y[0].createdAt) - new Date(x[0].createdAt)) || (x[0].id < y[0].id ? 1 : -1));
    const ids = scored.slice(0, MAX_STAYS).map(([c]) => c.id);
    if (!ids.length) return res.json({ stays: [] });
    const cards = await ListingProperty.find({ _id: { $in: ids }, status: "active" }).select(CARD_PROJECTION).lean();
    const byId = new Map(cards.map((d) => [String(d._id), sanitizeProperty(d)]));
    const stays = ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((p) => {
        const a = p.address || {};
        const same = a.city && a.state && a.district && String(a.city).trim().toLowerCase() === String(a.state).trim().toLowerCase();
        const city = same ? String(a.district).trim() : a.city;
        return { id: String(p._id), title: p.title || "", type: p.propertyType || "", label: [city, a.state].filter(Boolean).join(", ") };
      });
    res.json({ stays });
  } catch (error) {
    console.error("stay suggestions error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

exports.getPlacesIndex = async (req, res) => {
  try {
    if (!catalogueCache(req, res)) return;
    const docs = await ListingProperty.find({ status: "active" }).select(placeSearch.LOCATION_PROJECTION).lean();
    const inv = placeSearch.classifyAll(docs);
    const live = placeSearch.livePlaces(inv);
    res.json(placeSearch.clientIndex(placeSearch.countPlaces(inv, live), live));
  } catch (error) {
    console.error("places index error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};
