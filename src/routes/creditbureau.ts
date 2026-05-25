import { Router, Response } from "express";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { consumerMatchByBvn, getConsumerDetailedCreditReport } from "../lib/firstcentral";
import { logger } from "../lib/logger";
import prisma from "../lib/prisma";
import { launchBrowser } from "../lib/puppeteerBrowser";
import { uploadToSharePoint, downloadFromSharePoint, isSharePointEnabled } from "../lib/sharepoint";
import * as fs from "fs";
import * as path from "path";

const router = Router();
router.use(authenticate as any);

// ── Reference generator ───────────────────────────────────────────────────────
async function generateRef(prefix: string): Promise<string> {
  const latest = await prisma.creditBureauLog.findFirst({
    where: { reference: { startsWith: prefix } },
    orderBy: { createdAt: "desc" },
    select: { reference: true },
  });
  let next = 1;
  if (latest?.reference) {
    const m = latest.reference.match(/\d+$/);
    if (m) next = parseInt(m[0], 10) + 1;
  }
  return `${prefix}${String(next).padStart(3, "0")}`;
}

// ── Report HTML builder (dynamic — handles any FC response shape) ─────────────
const SKIP_REPORT_KEYS = new Set(["DataTicket", "statusCode", "status"]);

function buildKVRows(obj: Record<string, any>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `<tr><td class="lbl">${k.replace(/([A-Z])/g," $1").trim()}</td><td>${typeof v === "object" ? JSON.stringify(v) : String(v)}</td></tr>`)
    .join("");
}

function buildReportSection(report: any): string {
  if (!report || typeof report !== "object") return "";
  const sections = Object.entries(report).filter(([k]) => !SKIP_REPORT_KEYS.has(k));
  if (sections.length === 0) return "";

  const body = sections.map(([key, val]) => {
    const label = key.replace(/([A-Z])/g, " $1").trim();
    if (Array.isArray(val) && val.length > 0) {
      const cards = val.map((item: any, i: number) => {
        if (typeof item !== "object" || item === null) return `<div style="padding:6px 0;font-size:11px;">${String(item)}</div>`;
        return `<div class="match-card"><div class="match-header"><span class="match-index">#${i + 1}</span></div><table><tbody>${buildKVRows(item)}</tbody></table></div>`;
      }).join("");
      return `<h3 style="margin-bottom:8px;">${label} (${val.length})</h3>${cards}`;
    }
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      const rows = buildKVRows(val);
      return rows ? `<h3 style="margin-bottom:8px;">${label}</h3><table style="margin-bottom:16px;"><tbody>${rows}</tbody></table>` : "";
    }
    return `<tr><td class="lbl">${label}</td><td>${String(val)}</td></tr>`;
  }).join("");

  return `
    <div style="margin-top:28px;border-top:2px solid #e5e7eb;padding-top:20px;">
      <h3 style="color:#B50938;margin-bottom:16px;">Consumer Detailed Credit Report</h3>
      ${body}
    </div>`;
}

// ── PDF generator ─────────────────────────────────────────────────────────────
async function generateCrbPdf(opts: {
  reference: string; bvn: string; subjectName: string;
  status: string; matchCount: number; enquiryReason: string;
  verifiedBy: string; checkedAt: Date; matched: any[];
  report?: any; // full detailed credit report (optional)
}): Promise<string> {
  const { reference, bvn, subjectName, status, matchCount,
          enquiryReason, verifiedBy, checkedAt, matched, report } = opts;

  const statusColour = status === "Match Found" ? "#059669" : status === "No Match" ? "#d97706" : "#dc2626";
  const statusBg     = status === "Match Found" ? "#ecfdf5" : status === "No Match" ? "#fffbeb" : "#fef2f2";

  const matchRows = matched.map((m, i) => {
    const name = [m.FirstName, m.SecondName, m.Surname].filter(Boolean).join(" ") || "—";
    const rate = Number(m.MatchingRate ?? 0);
    return `
      <div class="match-card">
        <div class="match-header">
          <span class="match-index">Record #${i + 1}</span>
          <span class="match-rate ${rate >= 80 ? "rate-high" : "rate-low"}">${rate}% Match</span>
        </div>
        <table><tbody>
          <tr><td class="lbl">Name</td><td>${name}</td></tr>
          <tr><td class="lbl">Date of Birth</td><td>${m.BirthDate ?? "—"}</td></tr>
          <tr><td class="lbl">Address</td><td>${m.Address ?? "—"}</td></tr>
          <tr><td class="lbl">Phone</td><td>${m.TelePhoneNumber || "—"}</td></tr>
          <tr><td class="lbl">Consumer ID</td><td style="font-family:monospace">${m.ConsumerID ?? "—"}</td></tr>
          <tr><td class="lbl">Enquiry ID</td><td style="font-family:monospace">${m.EnquiryID ?? "—"}</td></tr>
          <tr><td class="lbl">FC Reference</td><td style="font-family:monospace">${m.Reference ?? "—"}</td></tr>
        </tbody></table>
      </div>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>FirstCentral CRB — ${reference}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1f2937;padding:40px;}
  .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #B50938;padding-bottom:20px;margin-bottom:24px;}
  .org{font-size:26px;font-weight:900;color:#B50938;}.org-sub{font-size:11px;color:#6b7280;margin-top:2px;}
  .doc-title{font-size:18px;font-weight:700;text-align:right;}.doc-ref{font-size:11px;color:#6b7280;font-family:monospace;text-align:right;margin-top:4px;}
  .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:24px;}
  .meta-item h4{font-size:9px;font-weight:700;text-transform:uppercase;color:#9ca3af;letter-spacing:.8px;margin-bottom:4px;}
  .meta-item p{font-size:12px;color:#111827;font-weight:500;}
  .status-badge{display:inline-block;padding:4px 12px;border-radius:999px;font-size:11px;font-weight:700;background:${statusBg};color:${statusColour};border:1px solid ${statusColour}33;}
  h3{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#6b7280;margin-bottom:12px;}
  .match-card{border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:14px;}
  .match-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
  .match-index{font-weight:700;color:#374151;font-size:13px;}
  .match-rate{font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;}
  .rate-high{background:#ecfdf5;color:#059669;border:1px solid #6ee7b7;}
  .rate-low{background:#fef2f2;color:#dc2626;border:1px solid #fca5a5;}
  table{width:100%;border-collapse:collapse;font-size:11px;}
  td{padding:6px 8px;border-bottom:1px solid #f3f4f6;vertical-align:top;}
  td.lbl{font-weight:600;color:#374151;width:35%;text-transform:capitalize;}
  .no-match{text-align:center;padding:40px;background:#f9fafb;border-radius:10px;border:1px dashed #e5e7eb;color:#6b7280;}
  .footer{margin-top:32px;padding-top:14px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;font-size:9px;color:#9ca3af;}
</style></head>
<body>
  <div class="header">
    <div><div class="org">FINCA</div><div class="org-sub">FirstCentral Credit Bureau Report</div></div>
    <div><div class="doc-title">CRB Consumer Match</div><div class="doc-ref">${reference}</div></div>
  </div>
  <div class="meta">
    <div class="meta-item"><h4>Reference</h4><p style="font-family:monospace;font-weight:700;font-size:14px;">${reference}</p></div>
    <div class="meta-item"><h4>Date Checked</h4><p>${checkedAt.toLocaleString("en-GB")}</p></div>
    <div class="meta-item"><h4>Checked By</h4><p>${verifiedBy}</p></div>
    <div class="meta-item"><h4>BVN</h4><p style="font-family:monospace">${bvn}</p></div>
    <div class="meta-item"><h4>Enquiry Reason</h4><p>${enquiryReason}</p></div>
    <div class="meta-item"><h4>Result</h4><p><span class="status-badge">${status} (${matchCount})</span></p></div>
  </div>
  <h3>${matchCount > 0 ? `${matchCount} Consumer Record${matchCount > 1 ? "s" : ""} Found` : "No Records Found"}</h3>
  ${matchCount > 0 ? matchRows : `<div class="no-match"><strong>No bureau record found for this BVN.</strong></div>`}
  ${report ? buildReportSection(report) : ""}
  <div class="footer">
    <span>Generated by FINCALite — FINCA Operations Platform</span>
    <span>${reference} | ${new Date().toISOString()}</span>
  </div>
</body></html>`;

  const browser = await launchBrowser();
  const pg = await browser.newPage();
  await pg.setContent(html, { waitUntil: "networkidle0" });
  const pdfBuffer = Buffer.from(await pg.pdf({ format: "A4", printBackground: true }));
  await browser.close();

  const folder = `checks/FCB/${reference}`;
  if (isSharePointEnabled()) return uploadToSharePoint(pdfBuffer, "report.pdf", "application/pdf", folder);
  const dir = path.join(process.env.UPLOAD_DIR ?? "uploads", folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.pdf"), pdfBuffer);
  return `${folder}/report.pdf`;
}

// ── GET /api/v1/credit-bureau/logs ───────────────────────────────────────────
router.get("/logs", async (req: AuthRequest, res: Response) => {
  const { bureau, search, page = "1", limit = "20" } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const where: any = {};
  if (bureau && bureau !== "all") where.bureau = bureau;
  where.verifiedBy = req.user?.email || "Unknown";
  if (search) {
    where.OR = [
      { reference:   { contains: search, mode: "insensitive" } },
      { subjectName: { contains: search, mode: "insensitive" } },
      { bvn:         { contains: search } },
      { verifiedBy:  { contains: search, mode: "insensitive" } },
    ];
  }
  const [total, data] = await Promise.all([
    prisma.creditBureauLog.count({ where }),
    prisma.creditBureauLog.findMany({
      where, orderBy: { createdAt: "desc" }, skip, take: parseInt(limit),
      select: { id: true, reference: true, bureau: true, bvn: true,
        subjectName: true, status: true, matchCount: true, pdfPath: true,
        enquiryReason: true, verifiedBy: true, createdAt: true,
        requestData: true, responseData: true, reportData: true },
    }),
  ]);
  res.json({ success: true, data, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── GET /api/v1/credit-bureau/lookup/:bvn ────────────────────────────────────
router.get("/lookup/:bvn", async (req: AuthRequest, res: Response) => {
  const { bvn } = req.params;
  try {
    const log = await prisma.creditBureauLog.findFirst({
      where: { bvn },
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, data: log || null });
  } catch (error: any) {
    logger.error("Error in CRB lookup:", error);
    res.status(500).json({ success: false, error: "Failed to lookup history" });
  }
});

// ── POST /api/v1/credit-bureau/consumer/bvn ──────────────────────────────────
router.post("/consumer/bvn", async (req: AuthRequest, res: Response) => {
  const { bvn, enquiryReason = "Credit Check", productId = 45, cloneFromReference } = req.body;

  if (!bvn || !/^\d{11}$/.test(String(bvn).trim())) {
    res.status(400).json({ success: false, error: "A valid 11-digit BVN is required." });
    return;
  }
  if (productId !== undefined && isNaN(Number(productId))) {
    res.status(400).json({ success: false, error: "productId must be a number." });
    return;
  }

  const currentUserEmail = req.user?.email || "Unknown";

  // 0. Handle explicit cloneFromReference request
  if (cloneFromReference) {
    try {
      const sourceLog = await prisma.creditBureauLog.findUnique({
        where: { reference: cloneFromReference }
      });
      if (!sourceLog) {
        res.status(404).json({ success: false, error: "Source check log not found" });
        return;
      }
      const reference = await generateRef("FCB");
      const clonedLog = await prisma.creditBureauLog.create({
        data: {
          reference,
          bureau: sourceLog.bureau,
          bvn: sourceLog.bvn,
          subjectName: sourceLog.subjectName,
          status: sourceLog.status,
          matchCount: sourceLog.matchCount,
          enquiryReason: sourceLog.enquiryReason,
          productId: sourceLog.productId,
          requestData: sourceLog.requestData as any,
          responseData: sourceLog.responseData as any,
          reportData: sourceLog.reportData as any,
          verifiedBy: currentUserEmail,
        }
      });

      // Generate PDF in background for cloned reference
      setImmediate(async () => {
        try {
          const matchData = sourceLog.responseData as any;
          const matched = matchData?.matched ?? [];
          const pdfPath = await generateCrbPdf({
            reference,
            bvn: sourceLog.bvn,
            subjectName: sourceLog.subjectName,
            status: sourceLog.status,
            matchCount: sourceLog.matchCount,
            enquiryReason: sourceLog.enquiryReason,
            verifiedBy: currentUserEmail,
            checkedAt: clonedLog.createdAt,
            matched,
            report: sourceLog.reportData,
          });
          await prisma.creditBureauLog.update({ where: { id: clonedLog.id }, data: { pdfPath } });
        } catch (e) {
          logger.error("Failed to generate cloned CRB PDF:", e);
        }
      });

      res.json({
        success: true,
        reference,
        status: sourceLog.status,
        count: sourceLog.matchCount,
        matched: (sourceLog.responseData as any)?.matched ?? [],
        id: clonedLog.id,
        bureau: clonedLog.bureau,
        bvn: clonedLog.bvn,
        subjectName: clonedLog.subjectName,
        verifiedBy: clonedLog.verifiedBy,
        createdAt: clonedLog.createdAt.toISOString()
      });
      return;
    } catch (err: any) {
      logger.error("Cloning CRB check failed:", err);
      res.status(500).json({ success: false, error: "Failed to clone CRB record." });
      return;
    }
  }

  let status = "Match Found";
  let matchResult: { count: number; matched: any[] } = { count: 0, matched: [] };

  try {
    matchResult = await consumerMatchByBvn(String(bvn).trim(), String(enquiryReason), Number(productId));
    if (matchResult.count === 0) status = "No Match";
  } catch (err: any) {
    logger.error("FirstCentral check failed:", err);
    status = "Failed";
  }

  const best        = [...matchResult.matched].sort((a, b) => Number(b.MatchingRate) - Number(a.MatchingRate))[0];
  const subjectName = best ? [best.FirstName, best.SecondName, best.Surname].filter(Boolean).join(" ") : "";
  const reference   = await generateRef("FCB");

  let reportData: any = null;
  if (best && best.ConsumerID && best.EnquiryID && best.MatchingEngineID) {
    try {
      reportData = await getConsumerDetailedCreditReport({
        consumerID: best.ConsumerID,
        enquiryID: best.EnquiryID,
        subscriberEnquiryEngineID: best.MatchingEngineID,
        productId: Number(productId),
      });
    } catch (err: any) {
      logger.error("Failed to automatically fetch FirstCentral report:", err);
    }
  }

  const newLog = await prisma.creditBureauLog.create({
    data: {
      reference, bureau: "firstcentral", bvn: String(bvn).trim(),
      subjectName, status, matchCount: matchResult.count,
      enquiryReason: String(enquiryReason), productId: Number(productId),
      requestData: { bvn, enquiryReason, productId } as any,
      responseData: matchResult as any,
      reportData: reportData,
      verifiedBy: currentUserEmail,
    },
  });

  setImmediate(async () => {
    try {
      const pdfPath = await generateCrbPdf({
        reference, bvn: String(bvn).trim(), subjectName, status,
        matchCount: matchResult.count, enquiryReason: String(enquiryReason),
        verifiedBy: currentUserEmail,
        checkedAt: newLog.createdAt, matched: matchResult.matched,
        report: reportData,
      });
      await prisma.creditBureauLog.update({ where: { id: newLog.id }, data: { pdfPath } });
    } catch (e) { logger.error("Failed to generate CRB PDF:", e); }
  });

  res.json({
    success: true,
    reference,
    status,
    count: matchResult.count,
    matched: matchResult.matched,
    id: newLog.id,
    bureau: newLog.bureau,
    bvn: newLog.bvn,
    subjectName: newLog.subjectName,
    verifiedBy: newLog.verifiedBy,
    createdAt: newLog.createdAt.toISOString()
  });
});

// ── GET /api/v1/credit-bureau/pdf/:reference ─────────────────────────────────
router.get("/pdf/:reference", async (req: AuthRequest, res: Response) => {
  const { reference } = req.params;
  const log = await prisma.creditBureauLog.findUnique({
    where: { reference }, select: { pdfPath: true },
  });
  if (!log) { res.status(404).json({ success: false, error: "Check not found." }); return; }
  if (!log.pdfPath) { res.status(202).json({ success: false, error: "PDF still generating. Try again shortly." }); return; }

  try {
    let buf: Buffer;
    if (isSharePointEnabled()) { const { buffer } = await downloadFromSharePoint(log.pdfPath); buf = buffer; }
    else { buf = fs.readFileSync(path.join(process.env.UPLOAD_DIR ?? "uploads", log.pdfPath)); }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${reference}-CRB-Report.pdf"`);
    res.send(buf);
  } catch (err: any) {
    logger.error("Failed to serve CRB PDF:", err);
    res.status(500).json({ success: false, error: "Failed to retrieve PDF." });
  }
});

// ── POST /api/v1/credit-bureau/consumer/report ───────────────────────────────
// Fetch the Consumer Detailed Credit Report for a matched consumer.
// Body: { reference, consumerID, enquiryID, subscriberEnquiryEngineID }
router.post("/consumer/report", async (req: AuthRequest, res: Response) => {
  const { reference, consumerID, enquiryID, subscriberEnquiryEngineID, productId = 45 } = req.body;

  if (!reference || !consumerID || !enquiryID || !subscriberEnquiryEngineID) {
    res.status(400).json({ success: false, error: "reference, consumerID, enquiryID, and subscriberEnquiryEngineID are required." });
    return;
  }

  const log = await prisma.creditBureauLog.findUnique({ where: { reference } });
  if (!log) { res.status(404).json({ success: false, error: "Check not found." }); return; }

  let report: any;
  try {
    report = await getConsumerDetailedCreditReport({
      consumerID: String(consumerID),
      enquiryID:  String(enquiryID),
      subscriberEnquiryEngineID: String(subscriberEnquiryEngineID),
      productId:  Number(productId),
    });
  } catch (err: any) {
    logger.error("FirstCentral report fetch failed:", err);
    res.status(502).json({ success: false, error: err.message ?? "Failed to fetch report from FirstCentral." });
    return;
  }

  // Debug: log the raw response structure so we can map it correctly
  logger.info(`FirstCentral report keys for ${reference}: ${JSON.stringify(Object.keys(report ?? {}))}`);
  logger.info(`FirstCentral report (truncated): ${JSON.stringify(report).slice(0, 500)}`);

  // Persist report data
  await prisma.creditBureauLog.update({
    where: { reference },
    data: { reportData: report as any },
  });

  // Regenerate PDF with full report data in background
  setImmediate(async () => {
    try {
      const matchData  = log.responseData as any;
      const matched    = matchData?.matched ?? [];
      const pdfPath    = await generateCrbPdf({
        reference, bvn: log.bvn, subjectName: log.subjectName,
        status: log.status, matchCount: log.matchCount,
        enquiryReason: log.enquiryReason,
        verifiedBy: log.verifiedBy, checkedAt: log.createdAt,
        matched, report,
      });
      await prisma.creditBureauLog.update({ where: { reference }, data: { pdfPath } });
    } catch (e) { logger.error("Failed to regenerate CRB PDF with report:", e); }
  });

  res.json({ success: true, report });
});


// ── GET /api/v1/credit-bureau/validate?service=firstcentral|creditregistry&reference=XXX
router.get("/validate", async (req: AuthRequest, res: Response) => {
  const { service, reference } = req.query as { service?: string; reference?: string };
  if (!service || !reference) {
    res.status(400).json({ valid: false, error: "service and reference are required." });
    return;
  }
  try {
    const log = await prisma.creditBureauLog.findFirst({
      where: { reference: reference.trim(), bureau: service.trim() },
      select: { pdfPath: true, subjectName: true },
    });
    if (!log) {
      res.json({ valid: false, error: `No ${service} check found with reference "${reference}".` });
      return;
    }
    res.json({
      valid: true,
      pdfUrl: log.pdfPath ? `/api/v1/credit-bureau/pdf/${reference.trim()}` : null,
      label: log.subjectName ?? reference,
    });
  } catch (err: any) {
    logger.error("Extended service validate (credit-bureau):", err);
    res.status(500).json({ valid: false, error: "Server error." });
  }
});

export default router;
