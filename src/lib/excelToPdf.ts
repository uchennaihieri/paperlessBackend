import * as XLSX from "xlsx";
import { launchBrowser } from "./puppeteerBrowser";

export async function convertExcelToPdf(buffer: Buffer): Promise<Buffer> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  
  let combinedHtml = "";
  for (let i = 0; i < workbook.SheetNames.length; i++) {
    const sheetName = workbook.SheetNames[i];
    const sheet = workbook.Sheets[sheetName];
    const htmlTable = XLSX.utils.sheet_to_html(sheet);
    
    const pageBreak = i > 0 ? '<div style="page-break-before: always;"></div>' : '';
    
    combinedHtml += `
      ${pageBreak}
      <div class="sheet-container" style="display: inline-block; min-width: 100%;">
        <h2 style="text-align: center; color: #333; margin-top: 20px;">${sheetName}</h2>
        ${htmlTable}
      </div>
    `;
  }

  const htmlSource = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: sans-serif; margin: 0; padding: 20px; background: #fff; }
          table { border-collapse: collapse; white-space: nowrap; }
          th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
        </style>
      </head>
      <body>
        ${combinedHtml}
      </body>
    </html>
  `;

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setContent(htmlSource, { waitUntil: "domcontentloaded", timeout: 15000 });
  
  // Dynamically calculate the maximum width and height among all sheets
  // so we can set the PDF page size to perfectly fit 1 sheet per page!
  const dimensions = await page.evaluate(() => {
    let maxWidth = 0;
    let maxHeight = 0;
    // @ts-ignore - document is available in the browser context but not in the Node typings
    const containers = document.querySelectorAll('.sheet-container');
    containers.forEach((container: any) => {
      if (container.offsetWidth > maxWidth) maxWidth = container.offsetWidth;
      if (container.offsetHeight > maxHeight) maxHeight = container.offsetHeight;
    });
    // Add 100px of padding to the max dimensions, with minimum fallback of A4 sizes
    return {
      width: Math.max(maxWidth + 100, 794),
      height: Math.max(maxHeight + 100, 1123)
    };
  });

  const pdfBuffer = await page.pdf({
    width: `${dimensions.width}px`,
    height: `${dimensions.height}px`,
    printBackground: true
  });

  await browser.close();
  return Buffer.from(pdfBuffer);
}
