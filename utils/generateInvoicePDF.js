const puppeteer = require("puppeteer");

async function generateInvoicePDF(html) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  // Load the HTML content
  await page.setContent(html, { waitUntil: "networkidle0" });

  // Create PDF buffer
  const pdfBuffer = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: {
      top: "20px",
      bottom: "20px",
    },
  });

  await browser.close();
  return pdfBuffer;
}

module.exports = generateInvoicePDF;
