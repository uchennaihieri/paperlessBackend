import { Router, Response } from "express";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { getCustomerBVN, getCustomerNIN } from "../lib/qoreid";
import { logger } from "../lib/logger";
import prisma from "../lib/prisma";
import { generateIdentityReportPdf } from "../lib/identityPdfGenerator";
import { downloadFromSharePoint, isSharePointEnabled } from "../lib/sharepoint";
import * as fs from "fs";
import * as path from "path";

const router = Router();
router.use(authenticate as any);

const CACHE_HOURS = 96;
const CACHE_MS = CACHE_HOURS * 60 * 60 * 1000;

// ── Reference generator ──────────────────────────────────────────────────────
async function generateReference(prefix: string): Promise<string> {
  const latest = await prisma.identityVerificationLog.findFirst({
    where: { reference: { startsWith: prefix } },
    orderBy: { createdAt: "desc" },
    select: { reference: true },
  });
  let next = 1;
  if (latest?.reference) {
    const match = latest.reference.match(/\d+$/);
    if (match) next = parseInt(match[0], 10) + 1;
  }
  return `${prefix}${String(next).padStart(3, "0")}`;
}

// Helper to log the verification action to a submission's audit trail
async function logToAuditTrail(
  submissionId: string | undefined,
  user: any,
  actionMsg: string
) {
  if (!submissionId) return;
  try {
    const form = await prisma.formSubmission.findUnique({ where: { id: submissionId } });
    if (!form) return;
    await prisma.formAuditTrail.create({
      data: {
        submissionId: form.id,
        formReference: form.reference,
        prevStatus: form.status,
        newStatus: form.status,
        action: "identity_verified",
        actorName: user?.user_name || "Unknown",
        actorEmail: user?.email || "Unknown",
        note: actionMsg,
      },
    });
  } catch (err) {
    logger.error(`Failed to write to audit trail for ${submissionId}:`, err);
  }
}

// ── GET /api/v1/identity/logs ─────────────────────────────────────────────────
// List all identity verification logs. Supports filtering by type and search.
router.get("/logs", async (req: AuthRequest, res: Response) => {
  const { type, search, page = "1", limit = "20" } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where: any = {};
  if (type && type !== "all") where.idType = type;
  if (search) {
    where.OR = [
      { reference:   { contains: search, mode: "insensitive" } },
      { subjectName: { contains: search, mode: "insensitive" } },
      { idNumber:    { contains: search, mode: "insensitive" } },
      { verifiedBy:  { contains: search, mode: "insensitive" } },
    ];
  }

  const [total, logs] = await Promise.all([
    prisma.identityVerificationLog.count({ where }),
    prisma.identityVerificationLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: parseInt(limit),
      select: {
        id: true,
        reference: true,
        idType: true,
        idNumber: true,
        subjectName: true,
        status: true,
        pdfPath: true,
        verifiedBy: true,
        createdAt: true,
        requestData: true,
        responseData: true,
      },
    }),
  ]);

  res.json({ success: true, data: logs, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── POST /api/v1/identity/bvn/:idNumber ───────────────────────────────────────
router.post("/bvn/:idNumber", async (req: AuthRequest, res: Response) => {
  const { idNumber } = req.params;
  const { firstname, lastname, dob, phone, email, gender, submissionId } = req.body;

  if (!firstname || !lastname) {
    res.status(400).json({ success: false, error: "firstname and lastname are required" });
    return;
  }

  try {
    const cutoffTime = new Date(Date.now() - CACHE_MS);

    // 1. Check Cache
    const existingLog = await prisma.identityVerificationLog.findFirst({
      where: { idType: "bvn", idNumber, createdAt: { gte: cutoffTime } },
      orderBy: { createdAt: "desc" },
    });

    let data: any;
    let reference: string;
    let status = "Verified";

    if (existingLog) {
      data = existingLog.responseData;
      reference = existingLog.reference;
    } else {
      // 2. Fetch fresh from QoreID
      try {
        data = await getCustomerBVN(idNumber, { firstname, lastname, dob, phone, email, gender });
        const state = (data as any)?.status?.state?.toLowerCase();
        if (state === "id_mismatch") status = "Partial";
      } catch (err: any) {
        status = "Failed";
        data = { error: err.message };
      }

      // 3. Generate reference and cache
      reference = await generateReference("BVN");
      const newLog = await prisma.identityVerificationLog.create({
        data: {
          reference,
          idType: "bvn",
          idNumber,
          subjectName: `${firstname} ${lastname}`,
          status,
          requestData: { firstname, lastname, dob, phone, email, gender },
          responseData: data as any,
          verifiedBy: req.user?.email || "Unknown",
        },
      });

      // 4. Generate PDF in background
      setImmediate(async () => {
        try {
          const pdfPath = await generateIdentityReportPdf({
            reference,
            idType: "bvn",
            idNumber,
            subjectName: `${firstname} ${lastname}`,
            status,
            verifiedBy: req.user?.email || "Unknown",
            checkedAt: newLog.createdAt,
            requestData: { firstname, lastname, dob, phone, email, gender },
            responseData: data as any,
          });
          await prisma.identityVerificationLog.update({
            where: { id: newLog.id },
            data: { pdfPath },
          });
        } catch (e) {
          logger.error("Failed to generate BVN PDF report:", e);
        }
      });
    }

    // 4. Log to Audit Trail if tied to a submission
    await logToAuditTrail(submissionId, req.user, `BVN Verified for ${firstname} ${lastname} [${reference}]`);

    res.json({ success: true, data, reference, status });
  } catch (error: any) {
    logger.error("Error in getBVNData route:", error);
    res.status(500).json({ success: false, error: error.message || "Failed to verify BVN" });
  }
});

// ── POST /api/v1/identity/nin/:idNumber ───────────────────────────────────────
router.post("/nin/:idNumber", async (req: AuthRequest, res: Response) => {
  const { idNumber } = req.params;
  const { firstname, lastname, middlename, dob, phone, email, gender, submissionId } = req.body;

  if (!firstname || !lastname) {
    res.status(400).json({ success: false, error: "firstname and lastname are required" });
    return;
  }

  try {
    const cutoffTime = new Date(Date.now() - CACHE_MS);

    // 1. Check Cache
    const existingLog = await prisma.identityVerificationLog.findFirst({
      where: { idType: "nin", idNumber, createdAt: { gte: cutoffTime } },
      orderBy: { createdAt: "desc" },
    });

    let data: any;
    let reference: string;
    let status = "Verified";

    if (existingLog) {
      data = existingLog.responseData;
      reference = existingLog.reference;
    } else {
      // 2. Fetch fresh from QoreID
      try {
        data = await getCustomerNIN(idNumber, { firstname, lastname, middlename, dob, phone, email, gender });
        const state = (data as any)?.status?.state?.toLowerCase();
        if (state === "id_mismatch") status = "Partial";
      } catch (err: any) {
        status = "Failed";
        data = { error: err.message };
      }

      // 3. Generate reference and cache
      reference = await generateReference("NIN");
      const newNinLog = await prisma.identityVerificationLog.create({
        data: {
          reference,
          idType: "nin",
          idNumber,
          subjectName: `${firstname} ${lastname}`,
          status,
          requestData: { firstname, lastname, middlename, dob, phone, email, gender },
          responseData: data as any,
          verifiedBy: req.user?.email || "Unknown",
        },
      });

      // 4. Generate PDF in background
      setImmediate(async () => {
        try {
          const pdfPath = await generateIdentityReportPdf({
            reference,
            idType: "nin",
            idNumber,
            subjectName: `${firstname} ${lastname}`,
            status,
            verifiedBy: req.user?.email || "Unknown",
            checkedAt: newNinLog.createdAt,
            requestData: { firstname, lastname, middlename, dob, phone, email, gender },
            responseData: data as any,
          });
          await prisma.identityVerificationLog.update({
            where: { id: newNinLog.id },
            data: { pdfPath },
          });
        } catch (e) {
          logger.error("Failed to generate NIN PDF report:", e);
        }
      });
    }

    // 4. Log to Audit Trail if tied to a submission
    await logToAuditTrail(submissionId, req.user, `NIN Verified for ${firstname} ${lastname} [${reference}]`);

    res.json({ success: true, data, reference, status });
  } catch (error: any) {
    logger.error("Error in getNINData route:", error);
    res.status(500).json({ success: false, error: error.message || "Failed to verify NIN" });
  }
});

// ── GET /api/v1/identity/pdf/:reference ───────────────────────────────────────
// Download the generated PDF report for a given check reference.
router.get("/pdf/:reference", async (req: AuthRequest, res: Response) => {
  const { reference } = req.params;

  const log = await prisma.identityVerificationLog.findUnique({
    where: { reference },
    select: { pdfPath: true, idType: true, subjectName: true },
  });

  if (!log) {
    res.status(404).json({ success: false, error: "Check not found." });
    return;
  }

  if (!log.pdfPath) {
    res.status(202).json({ success: false, error: "PDF is still being generated. Please try again in a few seconds." });
    return;
  }

  try {
    let pdfBuffer: Buffer;

    if (isSharePointEnabled()) {
      const { buffer } = await downloadFromSharePoint(log.pdfPath);
      pdfBuffer = buffer;
    } else {
      const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "uploads";
      pdfBuffer = fs.readFileSync(path.join(UPLOAD_DIR, log.pdfPath));
    }

    const filename = `${reference}-${log.idType.toUpperCase()}-Verification.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err: any) {
    logger.error("Failed to serve identity PDF:", err);
    res.status(500).json({ success: false, error: "Failed to retrieve PDF." });
  }
});


// ── GET /api/v1/identity/validate?service=nin|bvn&reference=XXX ──────────────
// Used by the form filler to live-validate an extended service reference.
router.get("/validate", async (req: AuthRequest, res: Response) => {
  const { service, reference } = req.query as { service?: string; reference?: string };
  if (!service || !reference) {
    res.status(400).json({ valid: false, error: "service and reference are required." });
    return;
  }
  try {
    const log = await prisma.identityVerificationLog.findFirst({
      where: { reference: reference.trim(), idType: service.trim() as any },
      select: { pdfPath: true, subjectName: true },
    });
    if (!log) {
      res.json({ valid: false, error: `No ${service.toUpperCase()} check found with reference "${reference}".` });
      return;
    }
    res.json({
      valid: true,
      pdfUrl: log.pdfPath ? `/api/v1/identity/pdf/${reference.trim()}` : null,
      label: log.subjectName ?? reference,
    });
  } catch (err: any) {
    logger.error("Extended service validate (identity):", err);
    res.status(500).json({ valid: false, error: "Server error." });
  }
});

export default router;
