// Parity: the server quote must equal what the checkout charged before
// Batch S (BookStay.jsx#calculateTotal, verbatim below), for every price
// band, night count and rounding edge.
const test = require("node:test");
const assert = require("node:assert/strict");
const { quoteStay, toPaise } = require("../../services/pricing");

// Verbatim copy of the pre-Batch-S checkout formula (user.website).
function legacyCheckoutTotal(basePrice, nightsCount) {
  const nightlyRate = basePrice;
  const cleaningFee = 0;
  const subtotal = nightlyRate * nightsCount;
  const serviceFee = Math.round(subtotal * 0.12);
  let taxes;
  if (nightlyRate <= 7500) taxes = Math.round(subtotal * 0.05) + Math.round(serviceFee);
  else if (nightlyRate > 7500) taxes = Math.round(subtotal * 0.18) + Math.round(serviceFee);
  return { subtotal, serviceFee, taxes, total: subtotal + cleaningFee + taxes };
}

test("quoteStay reproduces the legacy checkout total for real price bands", () => {
  // Real listing prices seen on the site plus rounding edges around the
  // ₹7,500 GST threshold and fractional fee results.
  const prices = [10, 999, 1000, 1500, 2500, 4999, 5000, 7499, 7500, 7501, 9000, 12000, 13000, 30000, 45000, 99999];
  const nights = [1, 2, 3, 5, 7, 14, 30];
  let cases = 0;
  for (const p of prices) {
    for (const n of nights) {
      const legacy = legacyCheckoutTotal(p, n);
      const q = quoteStay({ basePrice: p, nights: n });
      assert.equal(q.total, legacy.total, `total mismatch for ₹${p} × ${n}`);
      assert.equal(q.subTotal, legacy.subtotal);
      assert.equal(q.serviceFee, legacy.serviceFee);
      assert.equal(q.gst + q.serviceFee, legacy.taxes);
      assert.equal(q.totalPaise, legacy.total * 100, "paise must be the exact rupee total × 100");
      assert.ok(Number.isInteger(q.totalPaise));
      cases += 1;
    }
  }
  assert.equal(cases, prices.length * nights.length);
});

test("known worked examples", () => {
  // ₹9,000 × 5 nights (the stay used throughout Batch D verification):
  // 45,000 + 5,400 (12 %) + 8,100 (18 %) = 58,500
  const q = quoteStay({ basePrice: 9000, nights: 5 });
  assert.deepEqual([q.subTotal, q.serviceFee, q.gst, q.total, q.totalPaise], [45000, 5400, 8100, 58500, 5850000]);
  // ₹2,500 × 2 nights: 5,000 + 600 + 250 (5 %) = 5,850
  const low = quoteStay({ basePrice: 2500, nights: 2 });
  assert.deepEqual([low.subTotal, low.serviceFee, low.gst, low.total], [5000, 600, 250, 5850]);
  // exactly ₹7,500 is the low band; ₹7,501 is the high band
  assert.equal(quoteStay({ basePrice: 7500, nights: 1 }).gst, 375);
  assert.equal(quoteStay({ basePrice: 7501, nights: 1 }).gst, 1350);
});

test("fractional base prices keep the legacy rounding and produce integer paise", () => {
  for (const p of [2500.5, 999.99, 7500.4, 1234.56]) {
    for (const n of [1, 3]) {
      const legacy = legacyCheckoutTotal(p, n);
      const q = quoteStay({ basePrice: p, nights: n });
      assert.equal(q.total, legacy.total);
      assert.equal(q.totalPaise, toPaise(legacy.total));
      assert.ok(Number.isInteger(q.totalPaise));
    }
  }
});

test("rejects unusable input instead of inventing a price", () => {
  for (const bad of [undefined, null, NaN, Infinity, -1, "9000"]) {
    assert.throws(() => quoteStay({ basePrice: bad, nights: 2 }), /base price/);
  }
  for (const bad of [0, -1, 1.5, "2", NaN]) {
    assert.throws(() => quoteStay({ basePrice: 9000, nights: bad }), /nights/);
  }
});
