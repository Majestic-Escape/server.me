// GST on a booking, in rupees. Prefers the quote the booking was priced
// (and charged) with — services/pricing.js — so the invoice can never
// disagree with the captured amount when the listing is repriced between
// booking and invoicing. Falls back to the legacy rule for pre-S rows.
export const calTax = (booking) => {
  const gstPaise = booking?.quote?.gstPaise;
  if (Number.isFinite(gstPaise)) return Math.round(gstPaise / 100);
  const nightlyRate = Number(booking?.propertyId?.basePrice);
  if (nightlyRate <= 7500) {
    return Math.round(booking?.subTotal * 0.05); // 5% GST in India
  } else if (nightlyRate > 7500) {
    return Math.round(booking?.subTotal * 0.18); // 18% GST in India
  }
};
