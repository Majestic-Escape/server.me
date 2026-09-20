function generateInvoiceHTML(invoiceData, payment, tax) {
  return `
 <!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Majestic Escape Receipt</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #f5f5f5;
      font-family: Arial, Helvetica, sans-serif;
      color: #1f2937;
    }

    .page {
      min-height: 100vh;
      display: flex;
      justify-content: center;
      padding: 40px 16px;
    }

    .card {
      background: #ffffff;
      width: 100%;
      max-width: 720px;
      border-radius: 12px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.08);
      padding: 32px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 16px;
      margin-bottom: 24px;
    }

    .header h1 {
      font-size: 22px;
      margin: 0;
      font-weight: 600;
    }

    .header p {
      font-size: 13px;
      color: #6b7280;
      margin-top: 6px;
    }

    .logo {
      width: 48px;
      height: 48px;
    }

    .section {
      margin-bottom: 24px;
    }

    .row {
      display: flex;
      justify-content: space-between;
      gap: 16px;
    }

    .property-img {
      width: 160px;
      height: auto;
      border-radius: 8px;
      object-fit: cover;
    }

    h2 {
      font-size: 18px;
      margin: 0 0 4px;
      font-weight: 600;
    }

    h3 {
      font-size: 14px;
      margin-bottom: 8px;
      font-weight: 600;
    }

    p {
      font-size: 13px;
      color: #4b5563;
      margin: 4px 0;
      line-height: 1.5;
    }

    .links a {
      color: #2563eb;
      text-decoration: underline;
      font-size: 13px;
      margin-right: 12px;
    }

    .divider {
      border-top: 1px solid #e5e7eb;
      margin: 16px 0;
    }

    .price-row {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      margin: 4px 0;
    }

    .price-total {
      font-weight: 600;
      border-top: 1px solid #e5e7eb;
      padding-top: 8px;
      margin-top: 8px;
    }

    .footer {
      border-top: 1px solid #e5e7eb;
      padding-top: 16px;
      font-size: 11px;
      color: #6b7280;
      line-height: 1.6;
    }

    .footer a {
      color: #2563eb;
      text-decoration: underline;
    }
  </style>
</head>

<body>
  <div class="page">
    <div class="card">

      <!-- HEADER -->
      <div class="header">
        <div>
          <h1>Your receipt from Majestic Escape</h1>
          <p>
            Booking ID:
            <strong>${invoiceData?._id || ""}</strong>
            • ${new Date(invoiceData?.createdAt).toDateString()}
          </p>
        </div>
        <img
          src="https://majesticescape.in/logo.svg"
          alt="Majestic Escape"
          class="logo"
        />
      </div>

      <!-- PROPERTY INFO -->
      <div class="section row">
        <div>
          <h2>${invoiceData?.propertyId?.title || ""}</h2>
          <p>${invoiceData?.propertyId?.address.street || ""},${invoiceData?.propertyId?.address.district || ""}</p>
          <p>${invoiceData?.propertyId?.address.city || ""}, ${invoiceData?.propertyId?.address.state || ""}</p>
          <p>${invoiceData?.propertyId?.address.pincode || ""}</p>
          <br/>
          <p>
            ${new Date(invoiceData?.checkIn).toDateString()} –
            ${new Date(invoiceData?.checkOut).toDateString()}
          </p>
          <p>
            ${(invoiceData?.propertyId?.placeType || "").toUpperCase()}
            ${(invoiceData?.propertyId?.propertyType || "").toUpperCase()}
            • ${invoiceData?.propertyId?.beds || ""} bed
            • ${invoiceData?.propertyId?.guests || ""} guest
          </p>
          <p>
            Hosted by
            <strong>
              ${(invoiceData?.hostId?.firstName || "").toUpperCase()}
            </strong>
          </p>

          
        </div>

        <img
          src="${invoiceData?.propertyId?.photos?.[0] || ""}"
          alt="Property"
          class="property-img"
        />
      </div>

      <!-- TRAVELER INFO -->
      <div class="section">
        <div class="divider"></div>
        <p>
          <strong>Traveler:</strong><br/>
          ${invoiceData?.guestData?.adults
            .map((a) => `${a?.name?.toUpperCase() || ""}, ${a.age || ""}`)
            .join("<br/>")}
        </p>
        <div class="divider"></div>
      </div>

      <!-- CANCELLATION -->
      <div class="section">
        <h3>Cancellation policy</h3>
        <p>
          ${
            invoiceData?.cancellationPolicy === "moderate"
              ? "Moderate cancellation policy applies."
              : invoiceData?.cancellationPolicy === "flexible"
                ? "Flexible cancellation policy applies."
                : "Strict cancellation policy applies."
          }
        </p>
      </div>

      <!-- PRICE BREAKDOWN -->
      <div class="section">
        <h3>Price breakdown</h3>
        <div class="price-row">
          <span>Rs. ${invoiceData?.propertyId?.basePrice} × ${invoiceData?.nights} night</span>
          <span>Rs. ${invoiceData?.subTotal}</span>
        </div>
        <div class="price-row">
          <span>Service fee</span>
          <span>${`Rs. ${Math.round(invoiceData?.subTotal * 0.12).toLocaleString("en-IN")}`}</span>
        </div>
        <div class="price-row">
          <span>Taxes</span>
          <span>Rs. ${tax?.toLocaleString("en-IN")}</span>
        </div>
        <div class="price-row price-total">
          <span>Total (INR)</span>
          <span>Rs. ${invoiceData?.price.toLocaleString("en-IN")}</span>
        </div>
      </div>

      <!-- PAYMENT -->
      <div class="section">
        <h3>Payment</h3>
        <p>${payment?.paymentMethod?.toUpperCase()}</p>
        <p>${new Date(payment?.createdAt).toDateString()}</p>
        <p><strong>Rs. ${invoiceData?.price?.toLocaleString("en-IN")}</strong></p>
         <div class="price-row price-total">
          <span>Amount Paid (INR)</span>
          <span>Rs. ${invoiceData?.price?.toLocaleString("en-IN")}</span>
        </div>
      </div>
      

      <!-- FOOTER -->
      <div class="footer">
     
        <p>
          <a href="https://www.majesticescape.in">www.majesticescape.in</a>
        </p>
      </div>

    </div>
  </div>
</body>
</html>

  `;
}

module.exports = generateInvoiceHTML;
{
  /* <div class="links">
            <a href="#">Go to itinerary</a>
            <a href="#">Go to listing</a>
          </div> */
}
