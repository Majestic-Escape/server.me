const express = require('express');
const router = express.Router();
const { createBooking, getBookings } = require('../controllers/bookingInterestController');
const authMiddleware = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/authz');

// Contact lock-down: an enquiry is recorded for the caller (no user id in the
// body is trusted, no email is echoed); the list of every enquiry — with the
// enquirers' emails — is for admins only. Both routes were anonymous.
router.post('/availability', authMiddleware, createBooking);
router.get('/', authMiddleware, requireAdmin, getBookings);

module.exports = router;
