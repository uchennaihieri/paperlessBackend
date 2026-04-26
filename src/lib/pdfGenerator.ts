import puppeteer from "puppeteer";
import Handlebars from "handlebars";
import prisma from "./prisma";
import { PDFDocument, rgb } from "pdf-lib";
import { downloadFromSharePoint } from "./sharepoint";

// ─────────────────────────────────────────────────────────────────────────────
// resolveContextPath
// Resolves a dot-notation mappingPath against the unified context object.
// Supports numeric index segments (e.g. "Signatories.0.name" → array[0].name).
// ─────────────────────────────────────────────────────────────────────────────
function resolveContextPath(path: string, ctx: Record<string, any>): any {
  const segments = path.split(".");
  let cur: any = ctx;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return "";
    const idx = Number(seg);
    cur = isNaN(idx) ? cur[seg] : (Array.isArray(cur) ? cur[idx] : cur[seg]);
  }
  return cur ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────
// buildUnifiedContext
// Builds the canonical unified object available in every HTML render.
// Array properties (Questions, Signatories) are always proper JS Arrays.
// ─────────────────────────────────────────────────────────────────────────────
async function buildUnifiedContext(submission: any, pdfDataMapping: Record<string, any>) {
  const raw = submission.formResponses as Record<string, any>;

  // Build Questions array — skip file attachments
  const Questions: { index: number; label: string; value: string }[] = [];
  let qi = 1;
  for (const [label, val] of Object.entries(raw)) {
    if (Array.isArray(val) && val[0]?.isAttachment) continue;
    const displayVal = Array.isArray(val) ? val.join(", ") : String(val ?? "");
    Questions.push({ index: qi++, label, value: displayVal });
  }

  // Batch-lookup Users by email to get job title (user_role) for each signatory
  const signatoryEmails = (submission.signatories as any[]).map((s: any) => s.email).filter(Boolean);
  const userRecords = await prisma.user.findMany({
    where: { finca_email: { in: signatoryEmails } },
    select: { finca_email: true, user_role: true },
  });
  const roleByEmail = new Map(userRecords.map((u) => [u.finca_email, u.user_role ?? ""]));

  // Build Signatories array
  const Signatories = (submission.signatories as any[]).map((s, i) => ({
    index:          i + 1,
    name:           s.userName,
    email:          s.email,
    // jobTitle resolved from Users.user_role via email lookup
    jobTitle:       roleByEmail.get(s.email) ?? "",
    status:         s.status,
    dateSigned:     s.signedAt ? new Date(s.signedAt).toLocaleDateString("en-GB") : "",
    timeSigned:     s.signedAt ? new Date(s.signedAt).toLocaleTimeString() : "",
    // combined date+time alias used by templates with {{this.dateTime}}
    dateTime:       s.signedAt ? new Date(s.signedAt).toLocaleString("en-GB") : "",
    signatureImage: s.signatureData ?? "",
    // alias used by templates with {{this.signatureUrl}}
    signatureUrl:   s.signatureData ?? "",
  }));

  const submitter = submission.submittedBy as any;

  const unified: Record<string, any> = {
    // Structured sections (capital keys = new standard)
    Metadata: {
      formTitle:     submission.formName,
      reference:     submission.reference ?? "",
      dateSubmitted: new Date(submission.createdAt).toLocaleDateString("en-GB"),
      dateTime:      new Date(submission.createdAt).toLocaleString(),
      submitter: {
        name:   submitter?.user_name  ?? submitter?.full_name ?? "",
        email:  submitter?.finca_email ?? submitter?.email ?? "",
        branch: submitter?.branch ?? "",
      },
    },
    Questions,
    Responses: raw,
    Signatories,

    // Legacy flat aliases — keep so older templates keep working
    formTitle:      submission.formName,
    formName:       submission.formName,
    formDate:       new Date(submission.createdAt).toLocaleDateString("en-GB"),
    dateSubmitted:  new Date(submission.createdAt).toLocaleString(),
    reference:      submission.reference ?? "",
    submittedBy:    submitter?.user_name ?? "",
    submitterEmail: submitter?.finca_email ?? "",
    submitterBranch:submitter?.branch ?? "",
    questions:      Questions,
    // `responses` as [{question, answer}] — matches templates using {{#each responses}}{{this.question}}
    responses:      Questions.map((q) => ({ question: q.label, answer: q.value })),
    // `signatories` lowercase — full alias array so {{#each signatories}} works with all field names
    signatories:    Signatories,
    sign_name:      Signatories[0]?.name ?? "",
    signature:      Signatories[0]?.signatureImage ?? "",
    signTime:       Signatories[0]?.dateSigned ?? "",

    // Form-input mapped fields (e.g. amount → "5000")
    ...pdfDataMapping,
  };

  return unified;
}

export async function generateSubmissionPdf(id: string): Promise<{ buffer: Buffer, filename: string } | null> {
  const submission = await prisma.formSubmission.findUnique({
    where: { id },
    include: {
      signatories: { orderBy: { position: "asc" } },
      template:    true,
      submittedBy: true,
    },
  });

  if (!submission) return null;

  const filename = `${submission.formName.replace(/\s+/g, "_")}-${submission.id.slice(-6)}.pdf`;

  // ── 1. Resolve PDF template from FormTemplate.pdfTemplateId ──────────────────
  const pdfTemplateId = (submission.template as any)?.pdfTemplateId ?? null;

  // ── 2. Build form-input mappings (form field label → PDF field name) ─────────
  const formFields = (submission.template?.fields as any[]) || [];
  const pdfDataMapping: Record<string, any> = {};
  for (const ff of formFields) {
    if (ff.mappedPdfField) {
      pdfDataMapping[ff.mappedPdfField] = (submission.formResponses as any)[ff.label];
    }
  }

  if (pdfTemplateId) {
    const pdfTemplate = await prisma.pdfTemplate.findUnique({
      where: { id: pdfTemplateId },
      include: { fields: true },
    });

    if (pdfTemplate) {

      // ── 2a. HTML Handlebars + Puppeteer ────────────────────────────────────
      if ((pdfTemplate as any).type === "html") {
        try {
          const { buffer: htmlBuffer } = await downloadFromSharePoint(pdfTemplate.sharepointPath);
          const htmlSource = htmlBuffer.toString("utf-8");

          // Build the canonical unified context
          const unified = await buildUnifiedContext(submission, pdfDataMapping);

          // Resolve every saved field's mappingPath into the flat Handlebars context
          for (const field of pdfTemplate.fields as any[]) {
            if (!field.mappingPath) continue;
            if (field.mappingPath === "FormInput") continue; // handled via pdfDataMapping already
            unified[field.name] = resolveContextPath(field.mappingPath, unified);
          }

          const compiled = Handlebars.compile(htmlSource);
          const html = compiled(unified);

          let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
          try {
            // Use bundled Chromium with Linux-friendly args
            browser = await puppeteer.launch({ 
              headless: true,
              args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
          } catch (e) {
            console.error("Primary launch failed, trying fallback:", e);
            // Fallback for local Windows testing if bundled Chromium is missing
            browser = await puppeteer.launch({ headless: true, channel: "chrome" });
          }

          const pg = await browser.newPage();
          await pg.setContent(html, { waitUntil: "networkidle0" });
          const pdfBuffer = await pg.pdf({ format: "A4", printBackground: true });
          await browser.close();

          return { buffer: Buffer.from(pdfBuffer), filename };
        } catch (err) {
          console.error("Failed generating HTML PDF, falling back to auto-gen:", err);
        }
      }

      // ── 2b. Document pdf-lib overlay ───────────────────────────────────────
      else {
        try {
          const { buffer: pdfBuffer } = await downloadFromSharePoint(pdfTemplate.sharepointPath);
          const pdfDoc = await PDFDocument.load(pdfBuffer);
          const pages = pdfDoc.getPages();

          const signatureValues = (submission.signatories as any[]).map((s) => s.signatureData).filter(Boolean);
          let sigIndex = 0;

          for (const field of pdfTemplate.fields as any[]) {
            let val = pdfDataMapping[field.name];
            if (field.type === "signature") { val = signatureValues[sigIndex]; sigIndex++; }
            if (!val) continue;

            const pageIndex = field.page ?? 0;
            if (pageIndex >= pages.length || pageIndex < 0) continue;
            const pdfPage = pages[pageIndex];
            const { width: pWidth, height: pHeight } = pdfPage.getSize();

            const x      = field.x * pWidth;
            const y      = (1 - field.y - field.height) * pHeight;
            const fWidth  = field.width * pWidth;
            const fHeight = field.height * pHeight;

            if (field.type === "image" || field.type === "signature") {
              try {
                let imageBytes: Buffer;
                let image;
                const valStr = String(val);
                if (valStr.startsWith("data:image/jpeg") || valStr.startsWith("data:image/jpg")) {
                  imageBytes = Buffer.from(valStr.split(",")[1], "base64");
                  image = await pdfDoc.embedJpg(imageBytes);
                } else {
                  imageBytes = Buffer.from(valStr.includes(",") ? valStr.split(",")[1] : valStr, "base64");
                  image = await pdfDoc.embedPng(imageBytes).catch(() => pdfDoc.embedJpg(imageBytes));
                }
                if (image) pdfPage.drawImage(image, { x, y, width: fWidth, height: fHeight });
              } catch (e) { console.error(`Error embedding image for field ${field.name}`, e); }
            } else {
              pdfPage.drawText(String(val), { x, y: pHeight - (field.y * pHeight) - 12, size: 12, color: rgb(0, 0, 0) });
            }
          }

          const finalPdfBytes = await pdfDoc.save();
          return { buffer: Buffer.from(finalPdfBytes), filename };
        } catch (err) {
          console.error("Failed generating overlaid PDF, falling back to auto-gen:", err);
        }
      }
    }
  }

  // ── 2. Fallback: auto-generated HTML via Puppeteer ───────────────────────────
  let htmlContent = "";

  if (submission.template?.htmlTemplate) {
    // Legacy FormTemplate.htmlTemplate (simple {{variable}} interpolation)
    htmlContent = (submission.template.htmlTemplate as string).replace(/\{\{([^}]+)\}\}/g, (_match: any, p1: any) => {
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
    // Use bundled Chromium with Linux-friendly args
    browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  } catch (e) {
    console.error("Primary launch failed, trying fallback:", e);
    // Fallback for local Windows testing if bundled Chromium is missing
    browser = await puppeteer.launch({ headless: true, channel: "chrome" });
  }

  const page = await browser.newPage();
  await page.setContent(htmlContent, { waitUntil: "load" });
  const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });
  await browser.close();

  return { buffer: Buffer.from(pdfBuffer), filename };
}
