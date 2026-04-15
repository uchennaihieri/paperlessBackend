import { Router, Request, Response } from "express";
import puppeteer from "puppeteer";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";

const router = Router();
router.use(authenticate as any);

// ── GET /api/v1/pdf?id=<submissionId>&action=print|download ──────────────────
router.get("/", async (req: Request, res: Response) => {
  const id = req.query.id as string | undefined;
  const action = req.query.action as string | undefined;

  if (!id) {
    res.status(400).json({ error: "Missing submission ID" });
    return;
  }

  const submission = await prisma.formSubmission.findUnique({
    where: { id },
    include: {
      signatories: { orderBy: { position: "asc" } },
      template: true,
    },
  });

  if (!submission) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  let htmlContent = "";

  if (submission.template?.htmlTemplate) {
    // Use the custom administrator HTML template with {{variable}} interpolation
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
    // Auto-generate HTML from submission data
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

  // Launch Puppeteer (pre-installed Chrome first, fallback to Edge)
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

  const filename = `${submission.formName.replace(/\s+/g, "_")}-${submission.id.slice(-6)}.pdf`;
  const disposition =
    action === "print" ? `inline; filename="${filename}"` : `attachment; filename="${filename}"`;

  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": disposition,
  });
  res.send(Buffer.from(pdfBuffer));
});

export default router;
