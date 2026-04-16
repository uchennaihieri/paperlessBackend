import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { hashToken, decrypt } from "../lib/crypto";
import { mailer } from "../lib/mailer";

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
    const userEmail = req.user?.email;
    if (!userEmail) { res.status(401).json({ success: false, error: "Not logged in" }); return; }
    const hashedInput = hashToken(signatureToken);
    const secData = await prisma.securityData.findUnique({ where: { userEmail } });
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

  const { reason } = req.body; // optional decline reason

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
    data: {
      status: "Declined",
      signedAt: new Date(),
      declineReason: reason?.trim() || null,
    },
  });

  await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: { status: "Rejected" },
  });

  res.json({ success: true });
});

// ── POST /api/v1/workflow/:id/remind/:signatoryId ─────────────────────────────
// Send a reminder email to a pending signatory.
// Any authenticated user can trigger this (typically the submitter).
router.post("/:id/remind/:signatoryId", async (req: AuthRequest, res: Response) => {
  const submission = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    include: {
      submittedBy: { select: { user_name: true, finca_email: true } },
    },
  });

  if (!submission) { res.status(404).json({ success: false, error: "Submission not found" }); return; }

  const signatory = await prisma.submissionSignatory.findUnique({
    where: { id: req.params.signatoryId },
  });

  if (!signatory || signatory.submissionId !== req.params.id) {
    res.status(404).json({ success: false, error: "Signatory not found" });
    return;
  }

  if (signatory.status !== "Pending") {
    res.status(400).json({ success: false, error: `This signatory has already ${signatory.status.toLowerCase()} the form.` });
    return;
  }

  const submitterName = submission.submittedBy?.user_name ?? "A colleague";
  const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";

  await mailer.sendMail({
    from: `Paperless <${process.env.SMTP_USER ?? "noreply@paperless.ng"}>`,
    to: signatory.email,
    subject: `Reminder: Your signature is required on "${submission.formName}"`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
        <h2 style="color: #B50938; margin-bottom: 4px;">Paperless by FINCA</h2>
        <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
        <hr style="border-color: #e5e7eb; margin: 20px 0;" />
        <p style="font-size: 15px; color: #111827;">Hi <strong>${signatory.userName}</strong>,</p>
        <p style="font-size: 14px; color: #374151;">
          This is a reminder that your signature is required on the following form:
        </p>
        <div style="background: #f9fafb; border-left: 4px solid #B50938; border-radius: 4px; padding: 16px; margin: 16px 0;">
          <p style="margin: 0; font-weight: 600; color: #111827;">${submission.formName}</p>
          <p style="margin: 4px 0 0; font-size: 13px; color: #6b7280;">Reference: ${submission.reference ?? "N/A"}</p>
          <p style="margin: 4px 0 0; font-size: 13px; color: #6b7280;">Submitted by: ${submitterName}</p>
        </div>
        <p style="font-size: 14px; color: #374151;">Please log in to the Paperless platform to review and sign.</p>
        <a href="${appUrl}/dashboard/workflow" style="display: inline-block; background: #B50938; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">Go to Workflow Queue</a>
        <p style="font-size: 12px; color: #9ca3af; margin-top: 24px;">If you believe this was sent in error, please contact your administrator.</p>
      </div>
    `,
  });

  res.json({ success: true, message: `Reminder sent to ${signatory.email}` });
});

export default router;
