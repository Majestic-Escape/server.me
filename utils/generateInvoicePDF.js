const puppeteer = require("puppeteer");

async function generateInvoicePDF(html) {
  try {
    console.log("Enter Generate PDF");
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    console.log("Launch pupeteer");
    const page = await browser.newPage();
    console.log("browser page");
    // Load the HTML content
    await page.setContent(html, { waitUntil: "networkidle0" });
    console.log("set browser content");
    // Create PDF buffer
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "20px",
        bottom: "20px",
      },
    });
    console.log("Generated page pdf content");
    await browser.close();
    console.log("close browser");
    return pdfBuffer;
  } catch (error) {
    console.error("Puppeteer Error", error);
  }
}

module.exports = generateInvoicePDF;
