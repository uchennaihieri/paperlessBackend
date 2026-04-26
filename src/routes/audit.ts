import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";

const router = Router();
router.use(authenticate as any);

// ── GET /api/v1/audit ─────────────────────────────────────────────────────────
// Latest audit record per form submission, newest first overall.
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
    const from = new Date(`${date}T00:00:00.000Z`);
    const to   = new Date(`${date}T23:59:59.999Z`);
    where.createdAt = { gte: from, lte: to };
  }

  // 1. Group by submissionId to get the latest createdAt for each form
  const latestGroups = await prisma.formAuditTrail.groupBy({
    by: ['submissionId'],
    _max: { createdAt: true },
    where,
    orderBy: { _max: { createdAt: 'desc' } },
    skip,
    take,
  });

  // 2. Fetch the actual full records using the grouping results
  let records: any[] = [];
  if (latestGroups.length > 0) {
    const orConditions = latestGroups.map(g => ({
      submissionId: g.submissionId,
      createdAt: g._max.createdAt!
    }));

    records = await prisma.formAuditTrail.findMany({
      where: { OR: orConditions },
      orderBy: { createdAt: "desc" },
    });
  }

  // 3. Count total unique submissions for pagination metadata
  const totalGroups = await prisma.formAuditTrail.groupBy({
    by: ['submissionId'],
    where
  });
  const total = totalGroups.length;

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
// Full trail for one submission, from 1st activity to the latest (oldest first).
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
    orderBy: { createdAt: "asc" }, // 1st activity to latest
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
