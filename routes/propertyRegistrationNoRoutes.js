const express = require('express');
const router = express.Router();
const propertyController = require('../controllers/propertyRegistrationNoController');
const authMiddleware = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/authz');

// The whole registry dump and the bulk insert are admin tools (no client
// calls them; seeding goes through loadData.js). Anonymous, the insert let
// anyone register a fake Goa number and the dump served ~1.6 MB per call.
router.get('/', authMiddleware, requireAdmin, propertyController.getAll);
router.post('/', authMiddleware, requireAdmin, propertyController.saveProperties);

// GET endpoint to check if a registration number exists (ignores case)
router.get('/:registrationNo', propertyController.checkRegistrationNoExists);

module.exports = router;
