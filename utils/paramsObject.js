import { changeTime } from "./changeTime.js";
import { changeToUpperCase } from "./convertToUpperCase.js";

export function paramsToObject(userName, hostName, booking) {
  const params = {
    userName: changeToUpperCase(userName),
    hostName: changeToUpperCase(hostName),
    hostEmail: booking.hostId.email,
    hostContact: booking.hostId.phoneNumber,
    guestEmail: booking.userId.email,
    guestContact: booking.userId.phoneNumber,
    bookingId: booking._id,
    from: new Date(booking.checkIn).toLocaleDateString(),
    to: new Date(booking.checkOut).toLocaleDateString(),
    checkInTime: changeTime(booking.propertyId.checkinTime),
    checkOutTime: changeTime(booking.propertyId.checkoutTime),
    propertyTitle: booking.propertyId.title,
    adults: booking.adults,
    children: booking.children,
    amount: booking.price,
    paymentId: booking.payment.paymentId,
  };
  return params;
}
