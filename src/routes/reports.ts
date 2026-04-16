import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/authenticate";

const router = Router();
router.use(authenticate as any);

// ── Helper: resolve emails → deduplicated list of finca_email strings ─────────
async function resolveGrantedEmails(emails: string[]): Promise<{ valid: string[]; invalid: string[] }> {
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const email of emails) {
    const user = await prisma.user.findFirst({
      where: { finca_email: { equals: email, mode: "insensitive" }, status: { equals: "active", mode: "insensitive" } },
      select: { finca_email: true },
    });
    if (user?.finca_email) {
      valid.push(user.finca_email.toLowerCase());
    } else {
      invalid.push(email);
    }
  }

  return { valid: [...new Set(valid)], invalid };
}

// ── Helper: check if current user is an admin ─────────────────────────────────
function isAdmin(req: AuthRequest): boolean {
  return req.user?.user_role?.toLowerCase() === "administrator";
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN-ONLY ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/v1/reports ───────────────────────────────────────────────────────
// Admin: list all reports with their access lists
router.get("/", async (req: AuthRequest, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ success: false, error: "Forbidden: Administrators only" }); return; }

  const reports = await prisma.report.findMany({
    orderBy: { createdAt: "desc" },
    include: { access: { select: { userEmail: true, grantedAt: true } } },
  });

  res.json({ success: true, data: reports });
});

// ── GET /api/v1/reports/my-reports ────────────────────────────────────────────
// All users: returns only reports the user has access to (script excluded)
// NOTE: must be registered BEFORE /:id to avoid being matched as an id
router.get("/my-reports", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email;
  if (!email) { res.status(401).json({ success: false, error: "Unauthenticated" }); return; }

  let reports;

  if (isAdmin(req)) {
    reports = await prisma.report.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, description: true },
    });
  } else {
    reports = await prisma.report.findMany({
      where: {
        access: { some: { userEmail: { equals: email, mode: "insensitive" } } },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, description: true },
    });
  }

  res.json({ success: true, data: reports });
});

// ── GET /api/v1/reports/:id ───────────────────────────────────────────────────
// Admin: get full report details including script and access list
router.get("/:id", async (req: AuthRequest, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ success: false, error: "Forbidden: Administrators only" }); return; }

  const report = await prisma.report.findUnique({
    where: { id: req.params.id },
    include: { access: { select: { userEmail: true, grantedAt: true } } },
  });

  if (!report) { res.status(404).json({ success: false, error: "Report not found" }); return; }

  res.json({ success: true, data: report });
});

// ── POST /api/v1/reports ──────────────────────────────────────────────────────
// Admin: create a new report
router.post("/", requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const { name, description, script, granted_emails = [] } = req.body;

  if (!name || !description || !script) {
    res.status(400).json({ success: false, error: "name, description, and script are required" });
    return;
  }

  const { valid, invalid } = await resolveGrantedEmails(granted_emails);
  if (invalid.length > 0) {
    res.status(400).json({ success: false, error: `The following emails were not found as active users: ${invalid.join(", ")}` });
    return;
  }

  const report = await prisma.report.create({
    data: {
      name,
      description,
      script,
      createdBy: req.user!.email,
      access: {
        create: valid.map((userEmail) => ({ userEmail })),
      },
    },
    include: { access: { select: { userEmail: true, grantedAt: true } } },
  });

  res.status(201).json({ success: true, data: report });
});

// ── PUT /api/v1/reports/:id ───────────────────────────────────────────────────
// Admin: update an existing report and replace its access list
router.put("/:id", requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const { name, description, script, granted_emails } = req.body;

  const existing = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!existing) { res.status(404).json({ success: false, error: "Report not found" }); return; }

  // Resolve emails if provided
  let validEmails: string[] | undefined;
  if (granted_emails !== undefined) {
    const { valid, invalid } = await resolveGrantedEmails(granted_emails);
    if (invalid.length > 0) {
      res.status(400).json({ success: false, error: `The following emails were not found as active users: ${invalid.join(", ")}` });
      return;
    }
    validEmails = valid;
  }

  // Update report fields
  const updated = await prisma.report.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(script !== undefined && { script }),
    },
  });

  // Replace access list atomically if granted_emails was supplied
  if (validEmails !== undefined) {
    await prisma.reportAccess.deleteMany({ where: { reportId: req.params.id } });
    if (validEmails.length > 0) {
      await prisma.reportAccess.createMany({
        data: validEmails.map((userEmail) => ({ reportId: req.params.id, userEmail })),
      });
    }
  }

  const report = await prisma.report.findUnique({
    where: { id: req.params.id },
    include: { access: { select: { userEmail: true, grantedAt: true } } },
  });

  res.json({ success: true, data: report });
});

// ── DELETE /api/v1/reports/:id ────────────────────────────────────────────────
// Admin: delete a report (cascade deletes access records)
router.delete("/:id", requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const existing = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!existing) { res.status(404).json({ success: false, error: "Report not found" }); return; }

  await prisma.report.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// REPORT SPOOLING
// ══════════════════════════════════════════════════════════════════════════════

// ── POST /api/v1/reports/:id/spool ───────────────────────────────────────────
router.post("/:id/spool", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email;
  if (!email) { res.status(401).json({ success: false, error: "Unauthenticated" }); return; }

  const report = await prisma.report.findUnique({
    where: { id: req.params.id },
    include: { access: { select: { userEmail: true } } },
  });

  if (!report) { res.status(404).json({ success: false, error: "Report not found" }); return; }

  // Check access
  const hasAccess = isAdmin(req) || report.access.some(
    (a: any) => a.userEmail.toLowerCase() === email.toLowerCase()
  );
  if (!hasAccess) { res.status(403).json({ success: false, error: "You do not have access to this report" }); return; }

  // ── Validate parameters ───────────────────────────────────────────────────
  const { from_date, to_date, branch } = req.body;

  if (!from_date || !to_date || !branch) {
    res.status(400).json({ success: false, error: "from_date, to_date, and branch are required" });
    return;
  }

  const fromDate = new Date(from_date);
  const toDate = new Date(to_date);

  if (isNaN(fromDate.getTime())) { res.status(400).json({ success: false, error: "from_date is not a valid date" }); return; }
  if (isNaN(toDate.getTime())) { res.status(400).json({ success: false, error: "to_date is not a valid date" }); return; }
  if (toDate < fromDate) { res.status(400).json({ success: false, error: "to_date must not be before from_date" }); return; }

  // Validate branch: accept "ALL" or any branch that exists on an active user
  if (branch !== "ALL") {
    const branchExists = await prisma.user.findFirst({
      where: {
        branch: { equals: branch, mode: "insensitive" },
        status: { equals: "active", mode: "insensitive" },
      },
      select: { id: true },
    });
    if (!branchExists) { res.status(400).json({ success: false, error: `Branch "${branch}" does not exist` }); return; }
  }

  // ── Execute report script via parameterised raw query ────────────────────
  // Named params (:from_date, :to_date, :branch) are replaced with positional
  // $N placeholders. We use a function callback in .replace() so that $1/$2/$3
  // are treated as literal strings, NOT as JS capture-group back-references.
  // The endpoint always returns HTTP 200 — errors are carried in { success: false }
  // so the frontend never throws and can display them inline.
  try {
    const parameterisedScript = report.script
      .replace(/:from_date/g, () => "$1")
      .replace(/:to_date/g,   () => "$2")
      .replace(/:branch/g,    () => "$3");

    const rows = await prisma.$queryRawUnsafe(
      parameterisedScript,
      fromDate,   // $1 — Date object, correctly typed as timestamp by pg driver
      toDate,     // $2 — Date object, correctly typed as timestamp by pg driver
      branch      // $3 — string
    );

    res.json({ success: true, data: rows });
  } catch (err: any) {
    console.error("Report spool error:", err);
    const isDev = process.env.NODE_ENV !== "production";
    // Always 200 so the client never crashes — error shown as a toast/inline message
    res.status(200).json({
      success: false,
      error: isDev
        ? `Report execution failed: ${err?.message ?? String(err)}`
        : "Report execution failed. Please check your report script.",
    });
  }
});

export default router;
