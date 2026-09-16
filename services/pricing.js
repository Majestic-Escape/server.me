// The one server-side pricing authority.
//
// This reproduces, step for step, the formula the checkout has charged
// customers with (user.website BookStay.jsx#calculateTotal), which is also
// what utils/tax.js applies on invoices:
//
//   subTotal   = basePrice × nights
//   serviceFee = round(subTotal × 12 %)
//   gst        = basePrice ≤ 7,500 ? round(subTotal × 5 %) : round(subTotal × 18 %)
//   total      = subTotal + serviceFee + gst
//
// Rupee figures keep the exact same Math.round steps so that every amount a
// customer has been charged so far equals the new quote (parity tests in
// tests/batch-s/pricing.test.js). The integer-paise figures are what Razorpay
// orders are created from and what payment verification compares against —
// never floating-point rupees.
//
// The card / widget / invoice *display* formulas in the frontends differ from
// this one; they are deliberately out of scope here (product decision).

const SERVICE_FEE_RATE = 0.12;
const GST_THRESHOLD_RUPEES = 7500;
const GST_LOW_RATE = 0.05;
const GST_HIGH_RATE = 0.18;

function toPaise(rupees) {
  return Math.round(rupees * 100);
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// basePrice: number (rupees per night, as stored on ListingProperty)
// nights:    positive integer
function quoteStay({ basePrice, nights }) {
  if (!isFiniteNumber(basePrice) || basePrice < 0) {
    const err = new Error("Listing has no valid base price");
    err.code = "PRICING_UNAVAILABLE";
    throw err;
  }
  if (!Number.isInteger(nights) || nights < 1) {
    const err = new Error("nights must be a positive integer");
    err.code = "INVALID_NIGHTS";
    throw err;
  }
  const subTotal = basePrice * nights;
  const serviceFee = Math.round(subTotal * SERVICE_FEE_RATE);
  const gst =
    basePrice <= GST_THRESHOLD_RUPEES
      ? Math.round(subTotal * GST_LOW_RATE)
      : Math.round(subTotal * GST_HIGH_RATE);
  const total = subTotal + serviceFee + gst;
  return {
    basePrice,
    nights,
    currency: "INR",
    // rupees (what Booking.price / Booking.subTotal have always stored)
    subTotal,
    serviceFee,
    gst,
    total,
    // integer paise (authoritative for Razorpay and equality checks)
    subTotalPaise: toPaise(subTotal),
    serviceFeePaise: toPaise(serviceFee),
    gstPaise: toPaise(gst),
    totalPaise: toPaise(total),
  };
}

// Host blocks and iCal imports occupy inventory without a price.
function zeroQuote(nights) {
  return {
    basePrice: 0,
    nights,
    currency: "INR",
    subTotal: 0,
    serviceFee: 0,
    gst: 0,
    total: 0,
    subTotalPaise: 0,
    serviceFeePaise: 0,
    gstPaise: 0,
    totalPaise: 0,
  };
}

module.exports = {
  quoteStay,
  zeroQuote,
  toPaise,
  SERVICE_FEE_RATE,
  GST_THRESHOLD_RUPEES,
  GST_LOW_RATE,
  GST_HIGH_RATE,
};
