// const puppeteer = require("puppeteer");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const path = require("path");
const fs = require("fs");
async function generateInvoicePDF(html) {
  console.log("Enter Generate PDF");
  let browser;
  if (process.env.NEXT_PUBLIC_ENV == "dev") {
    function getChromePath() {
      const candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", // macOS
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ];

      return candidates.find((p) => fs.existsSync(p));
    }
    const chromePath = process.env.CHROME_EXECUTABLE_PATH || getChromePath();

    browser = await puppeteer.launch({
      headless: "new",
      executablePath:
        // process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome",
        chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  } else {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
  }

  console.log("Launched pupeteer");
  const page = await browser.newPage();
  console.log("browser page");
  await page.setContent(html, { waitUntil: "networkidle0" });
  console.log("set browser content");
  const pdfBuffer = await page.pdf({
    format: "A4",
    printBackground: true,
  });
  // if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
  //   throw new Error("Invalid PDF buffer received");
  // }
  console.log("Generated page pdf content");
  await browser.close();
  console.log("close browser");
  return pdfBuffer;
}

// async function generateInvoicePDF(html) {
//   try {
//     console.log("Enter Generate PDF");
//     const browser = await puppeteer.launch({
//       headless: "new",
//       args: ["--no-sandbox", "--disable-setuid-sandbox"],
//     });
//     console.log("Launch pupeteer");
//     const page = await browser.newPage();
//     console.log("browser page");
//     // Load the HTML content
//     await page.setContent(html, { waitUntil: "networkidle0" });
//     console.log("set browser content");
//     // Create PDF buffer
//     const pdfBuffer = await page.pdf({
//       format: "A4",
//       printBackground: true,
//       margin: {
//         top: "20px",
//         bottom: "20px",
//       },
//     });
//     console.log("Generated page pdf content");
//     await browser.close();
//     console.log("close browser");
//     return pdfBuffer;
//   } catch (error) {
//     console.error("Puppeteer Error", error);
//   }
// }

module.exports = generateInvoicePDF;
