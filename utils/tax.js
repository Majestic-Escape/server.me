export const calTax = (booking) => {
  const nightlyRate = Number(booking?.propertyId?.basePrice);
  if (nightlyRate <= 7500) {
    return Math.round(booking?.subTotal * 0.05); // 5% GST in India
  } else if (nightlyRate > 7500) {
    return Math.round(booking?.subTotal * 0.18); // 18% GST in India
  }
};
