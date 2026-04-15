import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { hashToken, decrypt } from "../lib/crypto";

const router = Router();
router.use(authenticate as any);

// ── GET /api/v1/workflow/queue ────────────────────────────────────────────────
// Returns submission items in the authenticated user's signing queue
router.get("/queue", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email ?? null;
  if (!email) { res.json({ success: true, data: [] }); return; }

  const [normalItems, finalApprovalItems] = await Promise.all([
    prisma.formSubmission.findMany({
      where: {
        signatories: {
          some: { email: { equals: email, mode: "insensitive" }, status: "Pending" },
        },
        status: { not: "Awaiting Final Approval" },
      },
      include: {
        signatories: { orderBy: { position: "asc" } },
        submittedBy: { select: { user_name: true, finca_email: true, branch: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.formSubmission.findMany({
      where: {
        status: "Awaiting Final Approval",
        approverEmail: { equals: email, mode: "insensitive" },
      },
      include: {
        signatories: { orderBy: { position: "asc" } },
        submittedBy: { select: { user_name: true, finca_email: true, branch: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Filter sequential-signing eligibility
  const eligible = normalItems.filter((sub: any) => {
    const myRow = sub.signatories.find(
      (s: any) => s.email.toLowerCase() === email.toLowerCase()
    );
    if (!myRow || myRow.status !== "Pending") return false;
    if (sub.signingType === "parallel") return true;
    return !sub.signatories.some(
      (s: any) => s.position < myRow.position && s.status === "Pending"
    );
  });

  res.json({ success: true, data: [...eligible, ...finalApprovalItems] });
});

// ── GET /api/v1/workflow/search-users ─────────────────────────────────────────
router.get("/search-users", async (req, res: Response) => {
  const query = (req.query.q ?? "") as string;
  if (!query || query.length < 2) { res.json({ success: true, data: [] }); return; }
  const users = await prisma.user.findMany({
    where: {
      status: { equals: "active", mode: "insensitive" },
      OR: [
        { user_name: { contains: query, mode: "insensitive" } },
        { finca_email: { contains: query, mode: "insensitive" } },
      ],
    },
    select: { user_name: true, finca_email: true },
    take: 10,
    distinct: ["finca_email"],
  });
  res.json({ success: true, data: users });
});

// ── GET /api/v1/workflow/submissions/:id ──────────────────────────────────────
router.get("/submissions/:id", async (req, res: Response) => {
  const sub = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    include: {
      signatories: { orderBy: { position: "asc" } },
      template: true,
      submittedBy: { select: { user_name: true, finca_email: true, branch: true } },
    },
  });
  if (!sub) { res.status(404).json({ success: false, error: "Not found" }); return; }
  res.json({ success: true, data: sub });
});

// ── POST /api/v1/workflow/:id/assign-self ─────────────────────────────────────
router.post("/:id/assign-self", async (req: AuthRequest, res: Response) => {
  const userName =
    req.user?.user_name ?? req.user?.email ?? "Unknown";
  const firstName = userName.split(" ")[0];
  const newStatus = `Assigned to ${firstName}`;

  await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: { status: newStatus, treatedBy: userName },
  });
  res.json({ success: true, newStatus });
});

// ── POST /api/v1/workflow/:id/complete ────────────────────────────────────────
// Complete processing: optionally route to a final approver
router.post("/:id/complete", async (req, res: Response) => {
  const { approverEmail, approverName } = req.body;

  if (!approverEmail) {
    await prisma.formSubmission.update({
      where: { id: req.params.id },
      data: { status: "Completed", approvedBy: "None", approverEmail: null },
    });
  } else {
    await prisma.formSubmission.update({
      where: { id: req.params.id },
      data: {
        status: "Awaiting Final Approval",
        approvedBy: approverName ?? approverEmail,
        approverEmail,
      },
    });
  }
  res.json({ success: true });
});

// ── POST /api/v1/workflow/:id/approve ─────────────────────────────────────────
// Final approver marks a submission as Completed
router.post("/:id/approve", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email ?? null;
  if (!email) { res.status(401).json({ success: false, error: "Not authenticated." }); return; }

  const sub = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    select: { status: true, approverEmail: true },
  });

  if (!sub || sub.status !== "Awaiting Final Approval") {
    res.status(400).json({ success: false, error: "Submission is not awaiting final approval." });
    return;
  }
  if (sub.approverEmail?.toLowerCase() !== email.toLowerCase()) {
    res.status(403).json({ success: false, error: "You are not the designated approver." });
    return;
  }

  await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: { status: "Completed" },
  });
  res.json({ success: true });
});

// ── POST /api/v1/workflow/:id/sign ────────────────────────────────────────────
router.post("/:id/sign", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email ?? null;
  if (!email) { res.status(401).json({ success: false, error: "Not authenticated." }); return; }

  const { signatureData, signatureToken } = req.body;
  let finalSignatureData: string | null = signatureData ?? null;

  if (signatureToken) {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, error: "Not logged in" }); return; }
    const hashedInput = hashToken(signatureToken);
    const secData = await prisma.securityData.findUnique({ where: { userId } });
    if (!secData || secData.hashedToken !== hashedInput) {
      res.status(400).json({ success: false, error: "Invalid signature token." });
      return;
    }
    finalSignatureData = decrypt(secData.encryptedSignature);
  }

  if (!finalSignatureData) {
    res.status(400).json({ success: false, error: "No signature provided." });
    return;
  }

  const sigRow = await prisma.submissionSignatory.findFirst({
    where: {
      submissionId: req.params.id,
      email: { equals: email, mode: "insensitive" },
      status: "Pending",
    },
  });

  if (!sigRow) {
    res.status(404).json({ success: false, error: "Signatory record not found or already signed." });
    return;
  }

  await prisma.submissionSignatory.update({
    where: { id: sigRow.id },
    data: { status: "Signed", signedAt: new Date(), signatureData: finalSignatureData },
  });

  const unsigned = await prisma.submissionSignatory.count({
    where: { submissionId: req.params.id, status: { not: "Signed" } },
  });

  await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: { status: unsigned === 0 ? "Processing" : "In-review" },
  });

  res.json({ success: true });
});

// ── POST /api/v1/workflow/:id/decline ────────────────────────────────────────
router.post("/:id/decline", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email ?? null;
  if (!email) { res.status(401).json({ success: false, error: "Not authenticated." }); return; }

  const sigRow = await prisma.submissionSignatory.findFirst({
    where: {
      submissionId: req.params.id,
      email: { equals: email, mode: "insensitive" },
      status: "Pending",
    },
  });

  if (!sigRow) {
    res.status(404).json({ success: false, error: "Signatory record not found." });
    return;
  }

  await prisma.submissionSignatory.update({
    where: { id: sigRow.id },
    data: { status: "Declined", signedAt: new Date() },
  });

  await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: { status: "Rejected" },
  });

  res.json({ success: true });
});

export default router;
