import puppeteer from "puppeteer";
import prisma from "./prisma";
import { PDFDocument, rgb } from "pdf-lib";
import { downloadFromSharePoint } from "./sharepoint";

export async function generateSubmissionPdf(id: string): Promise<{ buffer: Buffer, filename: string } | null> {
  const submission = await prisma.formSubmission.findUnique({
    where: { id },
    include: {
      signatories: { orderBy: { position: "asc" } },
      template: true,
    },
  });

  if (!submission) return null;

  // ── 1. Check for PdfTemplate field mappings ──
  const formFields = (submission.template?.fields as any[]) || [];
  const pdfDataMapping: Record<string, any> = {};
  const templateIdHits: Record<string, number> = {};

  for (const ff of formFields) {
    if (ff.mappedPdfField) {
      // Find the response value using the label as key
      pdfDataMapping[ff.mappedPdfField] = (submission.formResponses as any)[ff.label];
      
      const matchingFields = await prisma.pdfTemplateField.findMany({
        where: { name: ff.mappedPdfField }
      });
      for (const mf of matchingFields) {
        templateIdHits[mf.templateId] = (templateIdHits[mf.templateId] || 0) + 1;
      }
    }
  }

  let targetPdfTemplateId: string | null = null;
  let maxHits = 0;
  for (const [tId, hits] of Object.entries(templateIdHits)) {
    if (hits > maxHits) {
      maxHits = hits;
      targetPdfTemplateId = tId;
    }
  }

  if (targetPdfTemplateId) {
    const pdfTemplate = await prisma.pdfTemplate.findUnique({
      where: { id: targetPdfTemplateId },
      include: { fields: true }
    });

    if (pdfTemplate) {
      try {
        const { buffer: pdfBuffer } = await downloadFromSharePoint(pdfTemplate.sharepointPath);
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const pages = pdfDoc.getPages();

        const signatureValues = submission.signatories.map(s => s.signatureData).filter(Boolean);
        let sigIndex = 0;

        for (const field of pdfTemplate.fields) {
          let val = pdfDataMapping[field.name];

          if (field.type === "signature") {
             val = signatureValues[sigIndex];
             sigIndex++;
          }

          if (!val) continue;

          const pageIndex = field.page ?? 0;
          if (pageIndex >= pages.length || pageIndex < 0) continue;

          const pdfPage = pages[pageIndex];
          const { width: pWidth, height: pHeight } = pdfPage.getSize();

          const x = field.x * pWidth;
          const y = (1 - field.y - field.height) * pHeight;
          const fWidth = field.width * pWidth;
          const fHeight = field.height * pHeight;

          if (field.type === "image" || field.type === "signature") {
            try {
              let imageBytes: Buffer;
              let image;
              const valStr = String(val);
              
              if (valStr.startsWith("data:image/jpeg") || valStr.startsWith("data:image/jpg")) {
                imageBytes = Buffer.from(valStr.split(',')[1], 'base64');
                image = await pdfDoc.embedJpg(imageBytes);
              } else if (valStr.startsWith("data:image/png") || valStr.startsWith("data:image/")) {
                imageBytes = Buffer.from(valStr.split(',')[1], 'base64');
                image = await pdfDoc.embedPng(imageBytes);
              } else {
                imageBytes = Buffer.from(valStr, 'base64');
                image = await pdfDoc.embedPng(imageBytes).catch(() => pdfDoc.embedJpg(imageBytes));
              }

              if (image) {
                pdfPage.drawImage(image, { x, y, width: fWidth, height: fHeight });
              }
            } catch (e) {
              console.error(`Error embedding image for field ${field.name}`, e);
            }
          } else {
            pdfPage.drawText(String(val), {
              x,
              y: pHeight - (field.y * pHeight) - 12,
              size: 12,
              color: rgb(0, 0, 0),
            });
          }
        }

        const finalPdfBytes = await pdfDoc.save();
        const filename = `${submission.formName.replace(/\\s+/g, "_")}-${submission.id.slice(-6)}.pdf`;
        return { buffer: Buffer.from(finalPdfBytes), filename };
      } catch (err) {
        console.error("Failed generating overlaid PDF, falling back to HTML auto-gen:", err);
        // We catch errors and just let it fall back naturally to HTML generation
      }
    }
  }

  let htmlContent = "";

  if (submission.template?.htmlTemplate) {
    htmlContent = submission.template.htmlTemplate.replace(/\{\{([^}]+)\}\}/g, (_match: any, p1: any) => {
      const key = p1.trim();
      const responses = submission.formResponses as Record<string, any>;

      if (responses[key] !== undefined) {
        const val = responses[key];
        return Array.isArray(val) ? val.join(", ") : String(val);
      }
      if (key === "FormName") return submission.formName;
      if (key === "SubmissionID") return submission.id.toUpperCase();
      if (key === "DateSubmitted") return new Date(submission.createdAt).toLocaleString();
      return _match;
    });
  } else {
    const responses = submission.formResponses as Record<string, any>;
    let tableRows = "";
    Object.entries(responses).forEach(([key, val]) => {
      const valStr = Array.isArray(val) ? val.join(", ") : String(val);
      tableRows += `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #eee;font-weight:bold;width:40%;vertical-align:top;">${key}</td>
          <td style="padding:10px;border-bottom:1px solid #eee;width:60%;vertical-align:top;">${valStr}</td>
        </tr>`;
    });

    let signatoriesList = "";
    submission.signatories.forEach((sig: any) => {
      const sigDisplay = sig.signatureData
        ? `<img src="${sig.signatureData}" alt="Signature" style="max-height:50px;max-width:200px;" />`
        : `<div style="font-family:'Brush Script MT',cursive;font-size:24px;color:#B50938;opacity:0.8;">~${sig.userName.split(" ")[0]}</div>`;

      signatoriesList += `
        <div style="border-bottom:1px solid #eee;padding-bottom:10px;margin-bottom:15px;">
          <div style="display:flex;justify-content:space-between;">
            <strong>${sig.userName}</strong>
            <span style="color:#666;font-size:12px;">${sig.signedAt ? new Date(sig.signedAt).toLocaleDateString() : ""}</span>
          </div>
          <div style="color:grey;font-size:14px;margin-bottom:10px;">${sig.email}</div>
          ${sigDisplay}
        </div>`;
    });

    htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${submission.formName}</title>
          <style>
            body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;padding:40px;color:#333;}
            .header{display:flex;justify-content:space-between;border-bottom:2px solid #B50938;padding-bottom:20px;margin-bottom:30px;}
            .title{margin:0;font-size:24px;text-transform:uppercase;}
            .ref{color:grey;font-size:12px;}
            .logo{font-weight:bold;color:#B50938;font-size:28px;}
            .info-grid{display:flex;justify-content:space-between;margin-bottom:30px;font-size:14px;}
            .info-item h4{margin:0 0 5px 0;color:grey;font-size:10px;text-transform:uppercase;}
            table{width:100%;border-collapse:collapse;font-size:14px;margin-bottom:40px;}
            thead{background:#333;color:white;}
            th{padding:10px;text-align:left;}
            .sign-grid{display:grid;grid-template-columns:1fr 1fr;gap:30px;}
          </style>
        </head>
        <body>
          <div class="header">
            <div class="logo">FINCA</div>
            <div style="text-align:right;">
              <h1 class="title">${submission.formName}</h1>
              <p class="ref">REF: ${submission.id.toUpperCase()}</p>
            </div>
          </div>
          <div class="info-grid">
            <div class="info-item">
              <h4>Date Submitted</h4>
              <div>${new Date(submission.createdAt).toLocaleString()}</div>
            </div>
            <div class="info-item">
              <h4>Form Treater</h4>
              <div>${(submission.template as any)?.formTreater ?? "N/A"}</div>
            </div>
          </div>
          <table>
            <thead><tr><th>FORM FIELD</th><th>RESPONSE</th></tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
          <div class="info-item" style="margin-bottom:20px;"><h4>Digitally Signed By</h4></div>
          <div class="sign-grid">${signatoriesList}</div>
        </body>
      </html>`;
  }

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch({ headless: true, channel: "chrome" });
  } catch {
    browser = await puppeteer.launch({ headless: true, channel: "msedge" as any });
  }

  const page = await browser.newPage();
  await page.setContent(htmlContent, { waitUntil: "load" });
  const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
  await browser.close();

  const filename = `${submission.formName.replace(/\\s+/g, "_")}-${submission.id.slice(-6)}.pdf`;
  return { buffer: Buffer.from(pdfBuffer), filename };
}
