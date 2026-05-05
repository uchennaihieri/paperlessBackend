import { Router, Response } from "express";
import { Decimal } from "@prisma/client/runtime/library";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";

const router = Router();
router.use(authenticate as any);

// ── Helper: generate next entryId (jv1, jv2...) ──────────────────────────────
async function nextEntryId(): Promise<string> {
  const last = await prisma.journalEntry.findFirst({
    orderBy: { date: "desc" },
    select: { entryId: true },
  });
  if (!last) return "jv1";
  const num = parseInt(last.entryId.replace("jv", ""), 10);
  return `jv${isNaN(num) ? 1 : num + 1}`;
}

// ── Helper: generate next journalId (JE1, JE2...) ──────────────────────────────
async function nextJournalId(): Promise<string> {
  const last = await prisma.journalEntry.findFirst({
    where: { journalId: { not: null } },
    orderBy: { date: "desc" },
    select: { journalId: true },
  });
  if (!last || !last.journalId) return "JE1";
  const num = parseInt(last.journalId.replace("JE", ""), 10);
  return `JE${isNaN(num) ? 1 : num + 1}`;
}

// ── POST /api/v1/journal ──────────────────────────────────────────────────────
// Add a single journal line. Only the assigned treater for the form can post.
router.post("/", async (req: AuthRequest, res: Response) => {
  const { sessionRef, formName, type, accountCode, accountName, batchNumber, branch, description, amount, journalId } = req.body;

  if (!sessionRef || !formName || !type || !accountCode || !accountName || !description || !amount) {
    res.status(400).json({ success: false, error: "Missing required fields." });
    return;
  }
  if (type !== "debit" && type !== "credit") {
    res.status(400).json({ success: false, error: "type must be 'debit' or 'credit'." });
    return;
  }

  // Verify that the calling user is the assigned treater for this form session
  const submission = await prisma.formSubmission.findFirst({
    where: { reference: sessionRef },
    select: { treaterEmail: true, status: true },
  });

  if (!submission) {
    res.status(404).json({ success: false, error: "Form with this reference not found." });
    return;
  }

  // Enforce that only the assigned treater or final approver can perform journal operations
  const isAssignedTreater = submission.status.startsWith("Assigned") && submission.treaterEmail?.toLowerCase() === req.user?.email?.toLowerCase();
  const isFinalApprover = submission.status === "Awaiting Final Approval";
  if (!isAssignedTreater && !isFinalApprover) {
    res.status(403).json({ success: false, error: "Only the assigned treater or final approver can perform journal operations." });
    return;
  }

  const isAccountant = (req.user?.specialAccess ?? "").toLowerCase().includes("accountant");

  if (!isAccountant) {
    res.status(403).json({ success: false, error: "Only accountants can add journal entries." });
    return;
  }

  const entryId = await nextEntryId();
  const finalJournalId = journalId || await nextJournalId();

  const entry = await prisma.journalEntry.create({
    data: {
      entryId,
      journalId: finalJournalId,
      sessionRef,
      formName,
      type,
      accountCode,
      accountName,
      batchNumber: batchNumber ?? null,
      branch: branch ?? null,
      description,
      amount: new Decimal(amount),
      createdBy: req.user?.email ?? "Unknown",
      committed: false,
    },
  });

  res.status(201).json({ success: true, data: entry });
});

// ── POST /api/v1/journal/batch ────────────────────────────────────────────────
// Add multiple journal lines at once. They will all share a single newly generated journalId.
router.post("/batch", async (req: AuthRequest, res: Response) => {
  const { drafts } = req.body;
  if (!Array.isArray(drafts) || drafts.length === 0) {
    res.status(400).json({ success: false, error: "No drafts provided." });
    return;
  }

  const isAccountant = (req.user?.specialAccess ?? "").toLowerCase().includes("accountant");
  if (!isAccountant) {
    res.status(403).json({ success: false, error: "Only accountants can add journal entries." });
    return;
  }

  const journalId = await nextJournalId();
  const results = [];

  for (const draft of drafts) {
    const entryId = await nextEntryId();
    const entry = await prisma.journalEntry.create({
      data: {
        entryId,
        journalId,
        sessionRef: draft.sessionRef,
        formName: draft.formName,
        type: draft.type,
        accountCode: draft.accountCode,
        accountName: draft.accountName,
        batchNumber: draft.batchNumber ?? null,
        branch: draft.branch ?? null,
        description: draft.description,
        amount: new Decimal(draft.amount),
        createdBy: req.user?.email ?? "Unknown",
        committed: false,
      },
    });
    results.push(entry);
  }

  res.status(201).json({ success: true, data: results });
});

// ── GET /api/v1/journal ───────────────────────────────────────────────────────
// Global ledger — committed entries only. Supports filtering.
router.get("/", async (req: AuthRequest, res: Response) => {
  const { from, to, account, description, form, page = "1", limit = "50" } = req.query as Record<string, string>;

  const where: any = {};

  if (from || to) {
    where.date = {};
    if (from) where.date.gte = new Date(from);
    if (to)   where.date.lte = new Date(to);
  }
  if (account) {
    where.OR = [
      { accountCode: { contains: account, mode: "insensitive" } },
      { accountName: { contains: account, mode: "insensitive" } },
    ];
  }
  if (description) where.description = { contains: description, mode: "insensitive" };
  if (form) {
    where.OR = [
      { sessionRef: { contains: form, mode: "insensitive" } },
      { formName:   { contains: form, mode: "insensitive" } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [total, entries] = await Promise.all([
    prisma.journalEntry.count({ where }),
    prisma.journalEntry.findMany({ where, orderBy: { date: "asc" }, skip, take: parseInt(limit) }),
  ]);

  res.json({
    success: true,
    meta: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      pages: Math.ceil(total / parseInt(limit)),
    },
    data: entries,
  });
});

// ── GET /api/v1/journal/unbalanced ───────────────────────────────────────────
// Returns all form sessions that have journal entries and are unbalanced.
// Excludes: the querying session itself and any session already in the same batch.
// Used to populate the "Link Form" dropdown.
router.get("/unbalanced", async (req: AuthRequest, res: Response) => {
  const exclude = (req.query.exclude as string) ?? "";
  const excludeBatch = (req.query.excludeBatch as string) ?? "";

  // Get per-session, per-type sums in one query
  const grouped = await prisma.journalEntry.groupBy({
    by: ["sessionRef", "type", "formName"],
    _sum: { amount: true },
  });

  // Aggregate into a map: sessionRef → { debits, credits, formName }
  const map = new Map<string, { formName: string; debits: Decimal; credits: Decimal }>();
  for (const row of grouped) {
    if (!map.has(row.sessionRef)) {
      map.set(row.sessionRef, { formName: row.formName, debits: new Decimal(0), credits: new Decimal(0) });
    }
    const entry = map.get(row.sessionRef)!;
    if (row.type === "debit") entry.debits = entry.debits.plus(row._sum.amount ?? 0);
    else entry.credits = entry.credits.plus(row._sum.amount ?? 0);
  }

  // Collect all sessionRefs that are already in the excluded batch
  let batchedRefs = new Set<string>();
  if (excludeBatch) {
    const inBatch = await prisma.journalEntry.findMany({
      where: { batchGroupId: excludeBatch },
      select: { sessionRef: true },
      distinct: ["sessionRef"],
    });
    batchedRefs = new Set(inBatch.map((e) => e.sessionRef));
  }

  const result: { sessionRef: string; formName: string; direction: "Dr Overage" | "Cr Overage"; amount: string }[] = [];

  for (const [ref, { formName, debits, credits }] of map.entries()) {
    if (ref === exclude) continue;
    if (batchedRefs.has(ref)) continue;
    if (debits.equals(credits)) continue;
    if (debits.isZero() && credits.isZero()) continue;

    const diff = debits.minus(credits).abs();
    result.push({
      sessionRef: ref,
      formName,
      direction: debits.greaterThan(credits) ? "Dr Overage" : "Cr Overage",
      amount: diff.toFixed(2),
    });
  }

  // Sort: overages first, then by amount desc
  result.sort((a, b) => {
    if (a.direction !== b.direction) return a.direction === "Dr Overage" ? -1 : 1;
    return parseFloat(b.amount) - parseFloat(a.amount);
  });

  res.json({ success: true, data: result });
});

// ── Shared helper: resolve the set of sessionRefs to balance/query ─────────────
async function resolveScope(ref: string): Promise<{ where: any; linkedRefs: string[]; batchGroupId: string | null; journalId: string | null }> {
  // Try finding by journalId first
  const sample = await prisma.journalEntry.findFirst({
    where: { sessionRef: ref, journalId: { not: null } },
    select: { journalId: true },
  });

  if (sample?.journalId) {
    const journalId = sample.journalId;
    const allInBatch = await prisma.journalEntry.findMany({
      where: { journalId },
      select: { sessionRef: true },
      distinct: ["sessionRef"],
    });
    const linkedRefs = allInBatch.map((e) => e.sessionRef).filter((r) => r !== ref);
    return { where: { journalId }, linkedRefs, batchGroupId: null, journalId };
  }

  // Fallback to legacy batchGroupId if no journalId is found
  const legacySample = await prisma.journalEntry.findFirst({
    where: { sessionRef: ref, batchGroupId: { not: null } },
    select: { batchGroupId: true },
  });

  if (!legacySample?.batchGroupId) {
    return { where: { sessionRef: ref }, linkedRefs: [], batchGroupId: null, journalId: null };
  }

  const batchGroupId = legacySample.batchGroupId;
  const allInLegacy = await prisma.journalEntry.findMany({
    where: { batchGroupId },
    select: { sessionRef: true },
    distinct: ["sessionRef"],
  });
  const legacyLinkedRefs = allInLegacy.map((e) => e.sessionRef).filter((r) => r !== ref);

  return { where: { batchGroupId }, linkedRefs: legacyLinkedRefs, batchGroupId, journalId: null };
}

// ── GET /api/v1/journal/balance/:reference ────────────────────────────────────
// Returns debit/credit totals and balanced status. If the session is part of a
// batch, totals cover ALL entries across the entire batch.
router.get("/balance/:reference", async (req: AuthRequest, res: Response) => {
  const ref = req.params.reference;
  const { where, linkedRefs, batchGroupId } = await resolveScope(ref);

  const entries = await prisma.journalEntry.findMany({ where, select: { type: true, amount: true } });

  let debits = new Decimal(0);
  let credits = new Decimal(0);
  for (const e of entries) {
    if (e.type === "debit") debits  = debits.plus(e.amount);
    else                    credits = credits.plus(e.amount);
  }

  res.json({
    success: true,
    data: {
      debits:      debits.toFixed(2),
      credits:     credits.toFixed(2),
      balanced:    debits.equals(credits) && !debits.isZero(),
      linkedRefs,
      batchGroupId,
    },
  });
});

// ── GET /api/v1/journal/session/:reference ────────────────────────────────────
// All entries for one form session. If part of a batch, returns all batch entries.
router.get("/session/:reference", async (req: AuthRequest, res: Response) => {
  const { where, linkedRefs, batchGroupId, journalId } = await resolveScope(req.params.reference);
  const entries = await prisma.journalEntry.findMany({ where, orderBy: { date: "asc" } });
  res.json({ success: true, data: entries, linkedRefs, batchGroupId, journalId });
});

// ── POST /api/v1/journal/commit/:reference ────────────────────────────────────
// Commits all pending entries for a session (or its whole batch) to the global ledger.
// Only the assigned treater (or admin) of the calling form can commit.
router.post("/commit/:reference", async (req: AuthRequest, res: Response) => {
  const ref = req.params.reference;

  // Verify the calling user is the assigned treater
  const submission = await prisma.formSubmission.findFirst({
    where: { reference: ref },
    select: { treaterEmail: true, status: true },
  });

  if (!submission) {
    res.status(404).json({ success: false, error: "Form with this reference not found." });
    return;
  }

  const isAccountant = (req.user?.specialAccess ?? "").toLowerCase().includes("accountant");

  if (!isAccountant) {
    res.status(403).json({ success: false, error: "Only accountants can commit journal entries." });
    return;
  }

  // Resolve scope (batch or single session)
  const { where, linkedRefs } = await resolveScope(ref);
  const entries = await prisma.journalEntry.findMany({ where, select: { type: true, amount: true } });

  let debits = new Decimal(0);
  let credits = new Decimal(0);
  for (const e of entries) {
    if (e.type === "debit") debits = debits.plus(e.amount);
    else credits = credits.plus(e.amount);
  }

  if (!debits.equals(credits) || debits.isZero()) {
    const scope = linkedRefs.length > 0 ? `batch (${[ref, ...linkedRefs].join(" + ")})` : "session";
    res.status(400).json({ success: false, error: `Journal ${scope} is not balanced. Cannot commit.` });
    return;
  }

  // Commit all pending entries in scope
  const result = await prisma.journalEntry.updateMany({
    where: { ...where, committed: false },
    data: { committed: true },
  });

  res.json({ success: true, committed: result.count, linkedRefs });
});

// ── POST /api/v1/journal/link ─────────────────────────────────────────────────
// Link two session refs into a shared batch group.
// Only the treater of the PRIMARY (calling) session can initiate.
router.post("/link", async (req: AuthRequest, res: Response) => {
  const { primaryRef, linkedRef } = req.body as { primaryRef: string; linkedRef: string };

  if (!primaryRef || !linkedRef) {
    res.status(400).json({ success: false, error: "primaryRef and linkedRef are required." });
    return;
  }
  if (primaryRef === linkedRef) {
    res.status(400).json({ success: false, error: "Cannot link a form to itself." });
    return;
  }

  const isAccountant = (req.user?.specialAccess ?? "").toLowerCase().includes("accountant");

  const primarySub = await prisma.formSubmission.findFirst({
    where: { reference: primaryRef },
    select: { treaterEmail: true },
  });
  if (!primarySub) {
    res.status(404).json({ success: false, error: `Form ${primaryRef} not found.` });
    return;
  }
  if (!isAccountant) {
    res.status(403).json({ success: false, error: "Only accountants can initiate a journal link." });
    return;
  }

  // Verify linked form exists
  const linkedSub = await prisma.formSubmission.findFirst({
    where: { reference: linkedRef },
    select: { treaterEmail: true },
  });
  if (!linkedSub) {
    res.status(404).json({ success: false, error: `Form ${linkedRef} not found.` });
    return;
  }

  // Determine batchGroupId: reuse existing one from either session, or create new
  const existing = await prisma.journalEntry.findFirst({
    where: { sessionRef: { in: [primaryRef, linkedRef] }, batchGroupId: { not: null } },
    select: { batchGroupId: true },
  });
  const batchGroupId = existing?.batchGroupId ?? require("crypto").randomUUID();

  // Stamp both sessions
  await prisma.journalEntry.updateMany({
    where: { sessionRef: { in: [primaryRef, linkedRef] } },
    data: { batchGroupId },
  });

  res.json({ success: true, batchGroupId, primaryRef, linkedRef });
});

// ── DELETE /api/v1/journal/link/:reference ────────────────────────────────────
// Unlink a session from its batch group (removes batchGroupId from its entries).
// Only the treater of the given session (or admin) can unlink.
router.delete("/link/:reference", async (req: AuthRequest, res: Response) => {
  const ref = req.params.reference;

  const isAccountant = (req.user?.specialAccess ?? "").toLowerCase().includes("accountant");

  const sub = await prisma.formSubmission.findFirst({
    where: { reference: ref },
    select: { treaterEmail: true },
  });
  if (!sub) { res.status(404).json({ success: false, error: "Form not found." }); return; }
  if (!isAccountant) {
    res.status(403).json({ success: false, error: "Only accountants can unlink this session." });
    return;
  }

  // Check no committed entries exist for this ref (can't unlink committed entries)
  const committedCount = await prisma.journalEntry.count({
    where: { sessionRef: ref, committed: true },
  });
  if (committedCount > 0) {
    res.status(400).json({ success: false, error: "Cannot unlink a session with committed entries." });
    return;
  }

  await prisma.journalEntry.updateMany({
    where: { sessionRef: ref },
    data: { batchGroupId: null },
  });

  res.json({ success: true });
});

// ── PATCH /api/v1/journal/:id ─────────────────────────────────────────────────
// Edit a single uncommitted journal entry. Only treater/admin allowed.
router.patch("/:id", async (req: AuthRequest, res: Response) => {
  const entry = await prisma.journalEntry.findUnique({ where: { id: req.params.id } });

  if (!entry) { res.status(404).json({ success: false, error: "Entry not found." }); return; }
  if (entry.committed) { res.status(400).json({ success: false, error: "Cannot edit a committed entry." }); return; }

  // Verify caller is the assigned treater for this session
  const submission = await prisma.formSubmission.findFirst({
    where: { reference: entry.sessionRef },
    select: { treaterEmail: true },
  });

  const isAccountant = (req.user?.specialAccess ?? "").toLowerCase().includes("accountant");

  if (!isAccountant) {
    res.status(403).json({ success: false, error: "Only accountants can edit this entry." });
    return;
  }

  const { type, accountCode, accountName, batchNumber, branch, description, amount } = req.body;
  const { Decimal } = await import("@prisma/client/runtime/library");

  const updated = await prisma.journalEntry.update({
    where: { id: req.params.id },
    data: {
      ...(type        && { type }),
      ...(accountCode && { accountCode }),
      ...(accountName && { accountName }),
      ...(batchNumber !== undefined && { batchNumber: batchNumber || null }),
      ...(branch      !== undefined && { branch: branch || null }),
      ...(description && { description }),
      ...(amount      !== undefined && { amount: new Decimal(amount) }),
    },
  });

  res.json({ success: true, data: updated });
});

// ── DELETE /api/v1/journal/:id ────────────────────────────────────────────────
// Delete a single uncommitted journal entry. Only treater/admin allowed.
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  const entry = await prisma.journalEntry.findUnique({ where: { id: req.params.id } });

  if (!entry) { res.status(404).json({ success: false, error: "Entry not found." }); return; }
  if (entry.committed) { res.status(400).json({ success: false, error: "Cannot delete a committed entry." }); return; }

  const submission = await prisma.formSubmission.findFirst({
    where: { reference: entry.sessionRef },
    select: { treaterEmail: true },
  });

  const isAccountant = (req.user?.specialAccess ?? "").toLowerCase().includes("accountant");

  if (!isAccountant) {
    res.status(403).json({ success: false, error: "Only accountants can delete this entry." });
    return;
  }

  await prisma.journalEntry.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

export default router;
