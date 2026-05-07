import puppeteer from "puppeteer";
import { uploadToSharePoint, isSharePointEnabled } from "./sharepoint";
import * as fs from "fs";
import * as path from "path";

/**
 * Builds an HTML report for an identity verification result,
 * generates a PDF via Puppeteer, uploads it to SharePoint (or disk fallback),
 * and returns the storage path.
 */
export async function generateIdentityReportPdf(opts: {
  reference: string;   // e.g. "NIN001"
  idType: string;      // "nin" | "bvn"
  idNumber: string;
  subjectName: string;
  status: string;
  verifiedBy: string;
  checkedAt: Date;
  requestData: Record<string, any>;
  responseData: Record<string, any>;
}): Promise<string> {
  const {
    reference, idType, idNumber, subjectName, status,
    verifiedBy, checkedAt, requestData, responseData,
  } = opts;

  // ── Extract key response data ─────────────────────────────────────────────
  const idKey   = idType.toLowerCase();  // "nin" | "bvn"
  const idData: Record<string, any>  = responseData[idKey] ?? responseData.bvn ?? responseData.nin ?? {};
  const summary: Record<string, any> = responseData.summary ?? {};
  const photoB64: string | undefined = idData.photo ?? idData.image ?? undefined;

  // ── Field match chips ─────────────────────────────────────────────────────
  const matchChips = Object.entries(summary)
    .flatMap(([, svcVal]: [string, any]) =>
      Object.entries((svcVal as any)?.fieldMatches ?? {})
        .map(([field, matched]) => `
          <span class="chip ${matched ? "chip-ok" : "chip-fail"}">
            ${matched ? "✓" : "✗"} ${field}
          </span>`)
    ).join("");

  // ── Bio-data rows ─────────────────────────────────────────────────────────
  const skipKeys = new Set(["photo", "image", "signature"]);
  const bioRows = Object.entries(idData)
    .filter(([k]) => !skipKeys.has(k.toLowerCase()))
    .map(([k, v]) => `
      <tr>
        <td class="label">${k.replace(/_/g, " ")}</td>
        <td>${String(v ?? "—")}</td>
      </tr>`)
    .join("");

  // ── Status colours ────────────────────────────────────────────────────────
  const statusColour = status === "Verified" ? "#059669" : status === "Partial" ? "#d97706" : "#dc2626";
  const statusBg     = status === "Verified" ? "#ecfdf5"  : status === "Partial" ? "#fffbeb"  : "#fef2f2";

  // ── HTML ──────────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${idType.toUpperCase()} Verification — ${reference}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1f2937;background:#fff;padding:40px;}
    .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #b50938;padding-bottom:20px;margin-bottom:28px;}
    .org{font-size:26px;font-weight:900;color:#b50938;letter-spacing:-0.5px;}
    .org-sub{font-size:11px;color:#6b7280;margin-top:2px;}
    .doc-title{font-size:18px;font-weight:700;text-align:right;}
    .doc-ref{font-size:11px;color:#6b7280;margin-top:4px;text-align:right;font-family:monospace;}
    .meta-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:24px;}
    .meta-item h4{font-size:9px;font-weight:700;text-transform:uppercase;color:#9ca3af;letter-spacing:.8px;margin-bottom:4px;}
    .meta-item p{font-size:12px;color:#111827;font-weight:500;}
    .status-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;font-size:12px;font-weight:700;background:${statusBg};color:${statusColour};border:1px solid ${statusColour}33;}
    .photo-wrap{display:flex;justify-content:center;margin-bottom:24px;}
    .photo-wrap img{width:120px;height:140px;object-fit:cover;border-radius:10px;border:3px solid #e5e7eb;box-shadow:0 4px 12px rgba(0,0,0,.08);}
    .photo-wrap .no-photo{width:120px;height:140px;border-radius:10px;border:2px dashed #d1d5db;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:11px;font-style:italic;}
    h3{font-size:11px;font-weight:700;text-transform:uppercase;color:#6b7280;letter-spacing:.8px;margin-bottom:10px;}
    table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:24px;}
    table tbody tr:nth-child(odd){background:#f9fafb;}
    td{padding:9px 12px;border-bottom:1px solid #f3f4f6;vertical-align:top;}
    td.label{font-weight:600;color:#374151;width:38%;text-transform:capitalize;}
    .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:24px;}
    .chip{padding:4px 10px;border-radius:999px;font-size:10px;font-weight:600;}
    .chip-ok{background:#ecfdf5;color:#059669;border:1px solid #6ee7b7;}
    .chip-fail{background:#fef2f2;color:#dc2626;border:1px solid #fca5a5;}
    .footer{margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;font-size:9px;color:#9ca3af;}
    .section{margin-bottom:24px;}
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="org">FINCA</div>
      <div class="org-sub">Identity Verification Report</div>
    </div>
    <div>
      <div class="doc-title">${idType.toUpperCase()} Verification</div>
      <div class="doc-ref">${reference}</div>
    </div>
  </div>

  <!-- Meta -->
  <div class="meta-grid">
    <div class="meta-item"><h4>Reference</h4><p style="font-family:monospace;font-size:14px;font-weight:700;">${reference}</p></div>
    <div class="meta-item"><h4>Date Checked</h4><p>${checkedAt.toLocaleString("en-GB")}</p></div>
    <div class="meta-item"><h4>Checked By</h4><p>${verifiedBy}</p></div>
    <div class="meta-item"><h4>Subject</h4><p>${subjectName}</p></div>
    <div class="meta-item"><h4>${idType.toUpperCase()} Number</h4><p style="font-family:monospace;">${idNumber}</p></div>
    <div class="meta-item"><h4>Result</h4><p><span class="status-badge">${status}</span></p></div>
  </div>

  <!-- Photo -->
  <div class="photo-wrap">
    ${photoB64
      ? `<img src="${photoB64.startsWith("data:") ? photoB64 : `data:image/jpeg;base64,${photoB64}`}" alt="Subject Photo"/>`
      : `<div class="no-photo">No photo available</div>`
    }
  </div>

  <!-- Bio-data -->
  ${bioRows ? `
  <div class="section">
    <h3>Registry Data</h3>
    <table><tbody>${bioRows}</tbody></table>
  </div>` : ""}

  <!-- Field Matches -->
  ${matchChips ? `
  <div class="section">
    <h3>Field Match Summary</h3>
    <div class="chips">${matchChips}</div>
  </div>` : ""}

  <!-- Inputs used -->
  <div class="section">
    <h3>Inputs Provided</h3>
    <table><tbody>
      ${Object.entries(requestData)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `<tr><td class="label">${k}</td><td>${String(v)}</td></tr>`)
        .join("")}
    </tbody></table>
  </div>

  <div class="footer">
    <span>Generated by Paperless 2.0 — FINCA Operations Platform</span>
    <span>${reference} | ${new Date().toISOString()}</span>
  </div>
</body>
</html>`;

  // ── Generate PDF via Puppeteer ────────────────────────────────────────────
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  } catch {
    browser = await puppeteer.launch({ headless: true, channel: "chrome" });
  }
  const pg = await browser.newPage();
  await pg.setContent(html, { waitUntil: "networkidle0" });
  const pdfBuffer = Buffer.from(await pg.pdf({ format: "A4", printBackground: true }));
  await browser.close();

  // ── Upload ────────────────────────────────────────────────────────────────
  const folder   = `checks/${idType.toUpperCase()}/${reference}`;
  const fileName = "report.pdf";

  if (isSharePointEnabled()) {
    return uploadToSharePoint(pdfBuffer, fileName, "application/pdf", folder);
  }

  // Disk fallback
  const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "uploads";
  const dir = path.join(UPLOAD_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), pdfBuffer);
  return `${folder}/${fileName}`;
}
