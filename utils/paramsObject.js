import { changeTime } from "./changeTime.js";
import { changeToUpperCase } from "./convertToUpperCase.js";

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
    from: new Date(booking.checkIn).toLocaleDateString(),
    to: new Date(booking.checkOut).toLocaleDateString(),
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
