// GET /api/v1/places/index — the customer site's destination suggestions
// (services/placeSearch.clientIndex). Public, edge-cached like the rest of
// the catalogue (5 min + purge on listing changes via the `listings` tag):
// one small read per cache miss, zero per keystroke — the site matches
// locally.
const ListingProperty = require("../models/ListingProperty");
const placeSearch = require("../services/placeSearch");
const { catalogueCache } = require("../utils/httpCache");

exports.getPlacesIndex = async (req, res) => {
  try {
    if (!catalogueCache(req, res)) return;
    const docs = await ListingProperty.find({ status: "active" }).select(placeSearch.LOCATION_PROJECTION).lean();
    const inv = docs.map(placeSearch.classify);
    const live = placeSearch.livePlaces(inv);
    res.json(placeSearch.clientIndex(placeSearch.countPlaces(inv, live), live));
  } catch (error) {
    console.error("places index error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};
