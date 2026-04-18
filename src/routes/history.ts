/**
 * GET /api/v1/history
 *
 * Returns a combined activity feed for the authenticated user, spanning:
 *   • Forms the user submitted
 *   • Signatories records where the user signed or declined
 *   • Submissions treated by the user from the Action Center
 *   • Submissions where the user was the final approver
 *
 * Query params:
 *   page       – page number (default 1)
 *   limit      – items per page (default 20, max 100)
 *   search     – free-text search against formName, reference, status, treatedBy
 *                AND the raw JSON content of formResponses (what the user filled in)
 *   status     – filter by submission status (comma-separated for multiple)
 *   role       – "submitted" | "signed" | "treated" | "approved" (comma-sep)
 *   dateFrom   – ISO date string (inclusive lower bound on createdAt)
 *   dateTo     – ISO date string (inclusive upper bound on createdAt)
 */

import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { authenticate, AuthRequest } from "../middleware/authenticate";


const router = Router();
router.use(authenticate as any);

router.get("/", async (req: AuthRequest, res: Response) => {
  const email     = req.user?.email ?? null;
  const userId    = req.user?.id   ?? null;
  const userName  = req.user?.user_name ?? null;

  if (!email || !userId) {
    res.status(401).json({ success: false, error: "Not authenticated" });
    return;
  }

  // ── Pagination ──────────────────────────────────────────────────────────────
  const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const skip  = (page - 1) * limit;

  // ── Filters ─────────────────────────────────────────────────────────────────
  const search   = ((req.query.search  as string) ?? "").trim();
  const rawRoles = ((req.query.role    as string) ?? "").trim();
  const rawStatuses = ((req.query.status as string) ?? "").trim();
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo   = req.query.dateTo   as string | undefined;

  const roles    = rawRoles    ? rawRoles.split(",").map(r => r.trim()).filter(Boolean)    : [];
  const statuses = rawStatuses ? rawStatuses.split(",").map(s => s.trim()).filter(Boolean) : [];

  const dateFilter: any = {};
  if (dateFrom) dateFilter.gte = new Date(dateFrom);
  if (dateTo) {
    const d = new Date(dateTo);
    d.setHours(23, 59, 59, 999);          // end of the day
    dateFilter.lte = d;
  }

  // ── Prisma include shape ─────────────────────────────────────────────────────
  const include = {
    signatories: { orderBy: { position: "asc" as const } },
    submittedBy: { select: { user_name: true, finca_email: true, branch: true } },
    template:    { select: { name: true, formTreater: true } },
  };

  // ── JSONB formResponses full-text search via raw SQL ─────────────────────────
  // PostgreSQL lets us cast the JSONB column to text and do a case-insensitive
  // ILIKE match, which searches every value the user typed into any form field.
  let responseMatchIds: string[] = [];
  if (search) {
    const rawRows = await prisma.$queryRaw<{ id: string }[]>(
      Prisma.sql`
        SELECT id FROM "FormSubmission"
        WHERE "formResponses"::text ILIKE ${"%" + search + "%"}
      `
    );
    responseMatchIds = rawRows.map(r => r.id);
  }

  // ── Standard text filters (metadata fields) ─────────────────────────────────
  const textSearch = search
    ? {
        OR: [
          { formName:  { contains: search, mode: "insensitive" as const } },
          { reference: { contains: search, mode: "insensitive" as const } },
          { status:    { contains: search, mode: "insensitive" as const } },
          { treatedBy: { contains: search, mode: "insensitive" as const } },
        ],
      }
    : {};

  const statusFilter = statuses.length > 0 ? { status: { in: statuses } } : {};
  const dateCreatedFilter = Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {};

  // baseFilter does NOT include textSearch — search is applied at the ID-union level below
  const baseFilter = { ...statusFilter, ...dateCreatedFilter };

  // Decide which roles to look up (default: all)
  const includeSubmitted = roles.length === 0 || roles.includes("submitted");
  const includeSigned    = roles.length === 0 || roles.includes("signed");
  const includeTreated   = roles.length === 0 || roles.includes("treated");
  const includeApproved  = roles.length === 0 || roles.includes("approved");

  const [submittedIds, signatoryIds, treatedIds, approvedIds] = await Promise.all([
    // 1. Submissions the user created
    includeSubmitted
      ? prisma.formSubmission.findMany({
          where: { submittedById: userId, ...baseFilter },
          select: { id: true },
        }).then(rows => rows.map(r => r.id))
      : Promise.resolve([]),

    // 2. Submissions where the user is a signatory (signed or declined)
    includeSigned
      ? prisma.submissionSignatory.findMany({
          where: {
            email: { equals: email, mode: "insensitive" },
            status: { in: ["Signed", "Declined"] },
          },
          select: { submissionId: true },
        }).then(rows => rows.map(r => r.submissionId))
      : Promise.resolve([]),

    // 3. Submissions treated by the user (action center)
    includeTreated && userName
      ? prisma.formSubmission.findMany({
          where: { treatedBy: { contains: userName, mode: "insensitive" }, ...baseFilter },
          select: { id: true },
        }).then(rows => rows.map(r => r.id))
      : Promise.resolve([]),

    // 4. Submissions where the user was the final approver and approved
    includeApproved
      ? prisma.formSubmission.findMany({
          where: {
            approverEmail: { equals: email, mode: "insensitive" },
            status: "Completed",
            ...baseFilter
          },
          select: { id: true },
        }).then(rows => rows.map(r => r.id))
      : Promise.resolve([]),
  ]);

  // Merge into unique set of submission IDs
  // — role-based IDs are already filtered by baseFilter (status + date)
  // — responseMatchIds are IDs matching the JSONB search (unfiltered by role)
  // — textSearch (metadata) IDs are found by widening each role query below

  // For metadata text search: find any submission matching the text filter
  const metadataMatchIds: string[] = search
    ? await prisma.formSubmission
        .findMany({ where: { ...baseFilter, ...textSearch }, select: { id: true } })
        .then(rows => rows.map(r => r.id))
    : [];

  const allIds = [...new Set([
    ...submittedIds,
    ...signatoryIds,
    ...treatedIds,
    ...approvedIds,
    // Add IDs from JSONB & metadata search ONLY for submissions the user has access to
    // (intersection with the broader role set is enforced after the union via the
    // final `id: { in: allRoleIds }` + search-match union below)
  ])];

  // All IDs the user has any role on
  const allRoleIds = new Set(allIds);

  // Combine: either the user has a role on it OR it matches the search
  // (but always scoped to the owned set OR among search hits within owned set)
  let finalIds: string[];
  if (search) {
    const searchHitIds = new Set([...responseMatchIds, ...metadataMatchIds]);
    // Keep only submissions that (a) the user has a role on AND (b) match the search
    finalIds = allIds.filter(id => searchHitIds.has(id));
  } else {
    finalIds = allIds;
  }

  if (finalIds.length === 0) {
    res.json({
      success: true,
      data: [],
      meta: { page, limit, total: 0, totalPages: 0 },
    });
    return;
  }

  // ── Fetch the actual submissions with full data ──────────────────────────────
  const [total, rows] = await Promise.all([
    prisma.formSubmission.count({
      where: { id: { in: finalIds }, ...baseFilter },
    }),
    prisma.formSubmission.findMany({
      where: { id: { in: finalIds }, ...baseFilter },
      include,
      orderBy: { updatedAt: "desc" },
      skip,
      take: limit,
    }),
  ]);

  // ── Annotate each item with the user's role(s) ──────────────────────────────
  const signatoryIdSet    = new Set(signatoryIds);
  const submittedIdSet    = new Set(submittedIds);
  const treatedIdSet      = new Set(treatedIds);
  const approvedIdSet     = new Set(approvedIds);

  const data = rows.map((sub: any) => {
    const myRoles: string[] = [];
    if (submittedIdSet.has(sub.id)) myRoles.push("submitted");
    if (signatoryIdSet.has(sub.id)) {
      const sigRow = sub.signatories.find(
        (s: any) => s.email.toLowerCase() === email.toLowerCase()
      );
      myRoles.push(sigRow?.status === "Declined" ? "declined" : "signed");
    }
    if (treatedIdSet.has(sub.id))  myRoles.push("treated");
    if (approvedIdSet.has(sub.id)) myRoles.push("approved");

    const mySignatory = sub.signatories.find(
      (s: any) => s.email.toLowerCase() === email.toLowerCase()
    ) ?? null;

    return {
      id:           sub.id,
      formName:     sub.formName,
      reference:    sub.reference,
      status:       sub.status,
      signingType:  sub.signingType,
      treatedBy:    sub.treatedBy,
      approvedBy:   sub.approvedBy,
      createdAt:    sub.createdAt,
      updatedAt:    sub.updatedAt,
      myRoles,
      mySignatory:  mySignatory
        ? { status: mySignatory.status, signedAt: mySignatory.signedAt }
        : null,
      submittedBy:  sub.submittedBy,
      template:     sub.template,
      signatories:  sub.signatories.map((s: any) => ({
        userName: s.userName,
        email:    s.email,
        status:   s.status,
        signedAt: s.signedAt,
        position: s.position,
      })),
    };
  });

  res.json({
    success: true,
    data,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

export default router;
