import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";

const router = Router();
router.use(authenticate as any);

// ── GET /api/v1/audit ─────────────────────────────────────────────────────────
// All audit records, newest first.
// Query params (all optional, combinable):
//   ?reference=PCL1          → filter by formReference (partial, case-insensitive)
//   ?email=jane@finca.ng     → filter by actorEmail (exact, case-insensitive)
//   ?status=Completed        → filter by newStatus (exact, case-insensitive)
//   ?date=2026-04-20         → filter to records created on that date (YYYY-MM-DD)
//   ?page=1&limit=50         → pagination (default: page 1, 50 per page)
router.get("/", async (req, res: Response) => {
  const { reference, email, status, date, page, limit } = req.query as Record<string, string | undefined>;

  const take   = Math.min(parseInt(limit  ?? "50",  10), 200);
  const skip   = (Math.max(parseInt(page  ?? "1",  10), 1) - 1) * take;

  // Build the where clause dynamically
  const where: Record<string, any> = {};

  if (reference) {
    where.formReference = { contains: reference, mode: "insensitive" };
  }
  if (email) {
    where.actorEmail = { equals: email, mode: "insensitive" };
  }
  if (status) {
    where.newStatus = { equals: status, mode: "insensitive" };
  }
  if (date) {
    // Match any record created during the given calendar day (UTC)
    const from = new Date(`${date}T00:00:00.000Z`);
    const to   = new Date(`${date}T23:59:59.999Z`);
    where.createdAt = { gte: from, lte: to };
  }

  const [total, records] = await Promise.all([
    prisma.formAuditTrail.count({ where }),
    prisma.formAuditTrail.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
    }),
  ]);

  res.json({
    success: true,
    data: records,
    meta: {
      total,
      page:  Math.max(parseInt(page ?? "1", 10), 1),
      limit: take,
      pages: Math.ceil(total / take),
    },
  });
});

// ── GET /api/v1/audit/:submissionId ──────────────────────────────────────────
// Full trail for one submission, newest first.
router.get("/:submissionId", async (req, res: Response) => {
  const submission = await prisma.formSubmission.findUnique({
    where: { id: req.params.submissionId },
    select: { id: true },
  });

  if (!submission) {
    res.status(404).json({ success: false, error: "Submission not found" });
    return;
  }

  const trail = await prisma.formAuditTrail.findMany({
    where: { submissionId: req.params.submissionId },
    orderBy: { createdAt: "desc" },
  });

  res.json({ success: true, data: trail });
});

// ── GET /api/v1/audit/by-reference/:reference ────────────────────────────────
// Look up by form reference code, newest first.
router.get("/by-reference/:reference", async (req, res: Response) => {
  const trail = await prisma.formAuditTrail.findMany({
    where: { formReference: req.params.reference },
    orderBy: { createdAt: "desc" },
  });

  res.json({ success: true, data: trail });
});

export default router;
