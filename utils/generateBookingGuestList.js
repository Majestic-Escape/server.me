function generateBookingGuestListHTML(bookingData) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Booking Guest List - Majestic Escape</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #f8f9fa;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      color: #2d3748;
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
      max-width: 800px;
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.08);
      padding: 36px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #36621F;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }

    .header-left h1 {
      font-size: 24px;
      margin: 0;
      font-weight: 700;
      color: #36621F;
    }

    .header-left .subtitle {
      font-size: 14px;
      color: #718096;
      margin-top: 6px;
    }

    .logo {
      width: 60px;
      height: 60px;
    }

    .booking-info {
      background: #f7fafc;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 30px;
      border-left: 4px solid #36621F;
    }

    .info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
    }

    .info-item {
      margin-bottom: 8px;
    }

    .info-label {
      font-size: 13px;
      color: #718096;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }

    .info-value {
      font-size: 15px;
      color: #2d3748;
      font-weight: 500;
    }

    .info-value.highlight {
      color: #36621F;
      font-weight: 600;
    }

    .section-title {
      font-size: 18px;
      font-weight: 600;
      color: #36621F;
      margin: 0 0 16px 0;
      padding-bottom: 8px;
      border-bottom: 1px solid #e2e8f0;
    }

    .guest-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
    }

    .guest-table thead {
      background: #36621F;
      color: white;
    }

    .guest-table th {
      padding: 14px 16px;
      text-align: left;
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .guest-table tbody tr {
      border-bottom: 1px solid #e2e8f0;
      transition: background-color 0.2s;
    }

    .guest-table tbody tr:hover {
      background: #f7fafc;
    }

    .guest-table td {
      padding: 16px;
      font-size: 14px;
      color: #4a5568;
    }

    .guest-table .sno {
      font-weight: 600;
      color: #36621F;
      width: 60px;
    }

    .guest-table .guest-name {
      font-weight: 500;
    }

    .guest-table .guest-type {
      font-size: 12px;
      color: #718096;
      margin-top: 4px;
    }

    .guest-table .adult-badge {
      background: #e6fffa;
      color: #234e52;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }

    .guest-table .child-badge {
      background: #fef3c7;
      color: #92400e;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }

    .guest-table .infant-badge {
      background: #dbeafe;
      color: #1e40af;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
    }

    .totals {
      margin-top: 24px;
      padding: 20px;
      background: #f0fff4;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .total-item {
      text-align: center;
    }

    .total-count {
      font-size: 28px;
      font-weight: 700;
      color: #36621F;
      margin-bottom: 4px;
    }

    .total-label {
      font-size: 13px;
      color: #718096;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
      text-align: center;
      font-size: 12px;
      color: #718096;
      line-height: 1.6;
    }

    .footer-links a {
      color: #36621F;
      text-decoration: none;
      margin: 0 12px;
      font-weight: 500;
    }

    .footer-links a:hover {
      text-decoration: underline;
    }

    .print-date {
      margin-top: 8px;
      font-size: 11px;
      color: #a0aec0;
    }

    @media print {
      body {
        background: white;
      }
      .card {
        box-shadow: none;
        padding: 0;
      }
      .page {
        padding: 0;
      }
    }
  </style>
</head>

<body>
  <div class="page">
    <div class="card">

      <!-- HEADER -->
      <div class="header">
        <div class="header-left">
          <h1>Booking Guest List</h1>
          <div class="subtitle">Majestic Escape - Guest Information</div>
        </div>
        <img
          src="https://majesticescape.in/logo.svg"
          alt="Majestic Escape"
          class="logo"
        />
      </div>

      <!-- BOOKING INFORMATION -->
      <div class="booking-info">
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Booking ID</div>
            <div class="info-value highlight">${bookingData?._id || "N/A"}</div>
          </div>
          
          <div class="info-item">
            <div class="info-label">Booked By</div>
            <div class="info-value">${bookingData?.userId?.firstName || "Guest"}</div>
          </div>
          
          <div class="info-item">
            <div class="info-label">Check-in Date</div>
            <div class="info-value">${
              bookingData?.checkIn
                ? new Date(bookingData.checkIn).toLocaleDateString("en-US", {
                    weekday: "short",
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })
                : "N/A"
            }</div>
          </div>
          
          <div class="info-item">
            <div class="info-label">Check-out Date</div>
            <div class="info-value">${
              bookingData?.checkOut
                ? new Date(bookingData.checkOut).toLocaleDateString("en-US", {
                    weekday: "short",
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })
                : "N/A"
            }</div>
          </div>
          
          <div class="info-item">
            <div class="info-label">Property</div>
            <div class="info-value">${bookingData?.propertyId?.title || "N/A"}</div>
          </div>
          
          <div class="info-item">
            <div class="info-label">Total Nights</div>
            <div class="info-value">${bookingData?.nights || "0"} nights</div>
          </div>
        </div>
      </div>

      <!-- GUEST LIST SECTION -->
      <h2 class="section-title">Guest Information</h2>
      <table class="guest-table">
        <thead>
          <tr>
            <th class="sno">#</th>
            <th>Name</th>
            <th>Age</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          ${generateGuestRows(bookingData)}
        </tbody>
      </table>

      <!-- TOTALS SUMMARY -->
      <div class="totals">
        <div class="total-item">
          <div class="total-count">${bookingData?.adults || 0}</div>
          <div class="total-label">Adults</div>
        </div>
        
        <div class="total-item">
          <div class="total-count">${bookingData?.children || 0}</div>
          <div class="total-label">Children</div>
        </div>
        
        <div class="total-item">
          <div class="total-count">${bookingData?.infants || 0}</div>
          <div class="total-label">Infants</div>
        </div>
        
        <div class="total-item">
          <div class="total-count">${(bookingData?.guests || 0) + (bookingData?.children || 0) + (bookingData?.infants || 0)}</div>
          <div class="total-label">Total Guests</div>
        </div>
      </div>

      <!-- FOOTER -->
      <div class="footer">
        <div class="footer-links">
          <a href="https://majesticescape.in">Visit Website</a> • 
          
          <a href="https://majesticescape.in/help-center">Help Center</a>
        </div>
        <p>Majestic Escape </p>
        <p class="print-date">Document generated on ${new Date().toLocaleDateString(
          "en-US",
          {
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          },
        )}</p>
      </div>

    </div>
  </div>
</body>
</html>
  `;
}
// <a href="https://majesticescape.in/contact">Contact Support</a>
// Helper function to generate guest rows
function generateGuestRows(bookingData) {
  if (!bookingData?.guestData) {
    return '<tr><td colspan="4" style="text-align: center; padding: 40px; color: #718096;">No guest information available</td></tr>';
  }

  let rows = "";
  let count = 1;

  // Add adults
  if (
    bookingData.guestData.adults &&
    Array.isArray(bookingData.guestData.adults)
  ) {
    bookingData.guestData.adults.forEach((adult, index) => {
      rows += `
        <tr>
          <td class="sno">${count++}</td>
          <td>
            <div class="guest-name">${adult?.name?.toUpperCase() || `Adult ${index + 1}`}</div>
            ${index === 0 ? '<div class="guest-type">Primary Guest</div>' : ""}
          </td>
          <td>${adult?.age || "N/A"}</td>
          <td><span class="adult-badge">Adult</span></td>
        </tr>
      `;
    });
  }

  // Add children
  if (
    bookingData.guestData.children &&
    Array.isArray(bookingData.guestData.children)
  ) {
    bookingData.guestData.children.forEach((child, index) => {
      rows += `
        <tr>
          <td class="sno">${count++}</td>
          <td>
            <div class="guest-name">${child?.name?.toUpperCase() || `Child ${index + 1}`}</div>
          </td>
          <td>${child?.age || "N/A"}</td>
          <td><span class="child-badge">Child</span></td>
        </tr>
      `;
    });
  }

  // Add infants (if available in guestData)
  if (
    bookingData.guestData.infants &&
    Array.isArray(bookingData.guestData.infants)
  ) {
    bookingData.guestData.infants.forEach((infant, index) => {
      rows += `
        <tr>
          <td class="sno">${count++}</td>
          <td>
            <div class="guest-name">${infant?.name?.toUpperCase() || `Infant ${index + 1}`}</div>
          </td>
          <td>${infant?.age || "N/A"}</td>
          <td><span class="infant-badge">Infant</span></td>
        </tr>
      `;
    });
  } else if (bookingData?.infants > 0) {
    // If infants count is available but not in guestData
    for (let i = 0; i < (bookingData.infants || 0); i++) {
      rows += `
        <tr>
          <td class="sno">${count++}</td>
          <td>
            <div class="guest-name">INFANT ${i + 1}</div>
          </td>
          <td>Under 3</td>
          <td><span class="infant-badge">Infant</span></td>
        </tr>
      `;
    }
  }

  return rows;
}

// Export the main function
module.exports = { generateBookingGuestListHTML };
