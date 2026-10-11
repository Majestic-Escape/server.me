import { changeTime } from "./changeTime.js";
import { changeToUpperCase } from "./convertToUpperCase.js";

// Stay dates in e-mails: "12 Oct 2026". The old toLocaleDateString() used the
// server's locale (en-US on the hosting platform: "10/12/2026"), which an
// Indian reader takes for 10 December, and its timezone; the stay's nights are
// UTC days, so the date is written in UTC.
export function stayDate(value) {
  return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Template parameters for the booking emails.
//
// Contact lock-down: the counterpart's email / phone and the property's street
// are voucher data, emitted only when the caller says the lifecycle allows it
// (`reveal.contact` / `reveal.street`: the confirmation emails of a confirmed,
// paid booking, and every admin email). Emails about a pending, rejected or
// cancelled booking carry names, dates and the locality only. Callers pass
// the names already shaped for the recipient (own full name, counterpart
// first name).
export function paramsToObject(userName, hostName, booking, reveal = { contact: false, street: false }) {
  const address = (booking.propertyId && booking.propertyId.address) || {};
  const params = {
    userName: changeToUpperCase(userName),
    hostName: changeToUpperCase(hostName),
    bookingId: booking._id,
    from: stayDate(booking.checkIn),
    to: stayDate(booking.checkOut),
    checkInTime: changeTime(booking.propertyId?.checkinTime),
    checkOutTime: changeTime(booking.propertyId?.checkoutTime),
    propertyTitle: booking.propertyId?.title,
    city: address.city,
    state: address.state,
    district: address.district,
    pincode: address.pincode,
    adults: booking.adults,
    children: booking.children,
    amount: typeof booking.price === "number" ? booking.price.toLocaleString("en-IN") : booking.price,
    paymentId: booking.payment?.paymentId,
  };
  if (reveal && reveal.contact) {
    params.hostEmail = booking.hostId?.email;
    params.hostContact = booking.hostId?.phoneNumber;
    params.guestEmail = booking.userId?.email;
    params.guestContact = booking.userId?.phoneNumber;
  }
  if (reveal && reveal.street) {
    params.street = address.street;
  }
  return params;
}
