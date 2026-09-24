// routes/placesRoutes.js — place gazetteer reads for location search.
const express = require("express");
const router = express.Router();
const placesController = require("../controllers/placesController");

router.get("/index", placesController.getPlacesIndex);

module.exports = router;
