function generateInvoiceHTML(invoiceData, payment) {
  return `
  <html>
    <body style="font-family: Arial; padding: 20px;">
      <h2>Your receipt from Majestic Escape</h2>
      <p><strong>Booking ID:</strong> ${invoiceData._id}</p>

      <h3>Property Details</h3>
      <p>${invoiceData.propertyId.title}</p>
      <p>${invoiceData.nights} night in ${
    invoiceData.propertyId.address.city
  }</p>

      <h3>Price</h3>
      <p>Total Paid: ₹${invoiceData.price.toLocaleString()}</p>

      <h3>Payment</h3>
      <p>Method: ${payment.paymentMethod}</p>
      <p>Date: ${new Date(payment.createdAt).toLocaleString()}</p>

      <br/><br/>
      <p>Thank you for booking with Majestic Escape!</p>
    </body>
  </html>
  `;
}

module.exports = generateInvoiceHTML;
