import { Router, Response } from "express";

import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { hashToken, decrypt } from "../lib/crypto";
import { mailer } from "../lib/mailer";
import { generateSubmissionPdf } from "../lib/pdfGenerator";
import { isSharePointEnabled, uploadToSharePoint } from "../lib/sharepoint";
import fs from "fs/promises";
import path from "path";

const router = Router();
router.use(authenticate as any);

// ── Audit trail helper ────────────────────────────────────────────────────────
async function logAudit(opts: {
  submissionId: string;
  formReference?: string | null;
  prevStatus: string;
  newStatus: string;
  action: string;
  actorName?: string | null;
  actorEmail?: string | null;
  note?: string | null;
}) {
  try {
    await prisma.formAuditTrail.create({ data: opts });
  } catch (e) {
    console.error("[audit] failed to write trail:", e);
  }
}

// ── Prerequisite Unblock Helper ──────────────────────────────────────────────
export async function checkAndUnblockPrerequisites(prereqSubmissionId: string) {
  setImmediate(async () => {
    try {
      const prereqLink = await prisma.submissionPrerequisite.findUnique({
        where: { prereqSubmissionId },
        select: { id: true, mainSubmissionId: true },
      });
      if (!prereqLink) return;

      // Mark this prerequisite as Approved
      await prisma.submissionPrerequisite.update({
        where: { id: prereqLink.id },
        data: { status: "Approved" },
      });

      // Check if ALL prerequisites for the main submission are now approved
      const remaining = await prisma.submissionPrerequisite.count({
        where: { mainSubmissionId: prereqLink.mainSubmissionId, status: { not: "Approved" } },
      });

      if (remaining === 0) {
        // Unblock the main submission
        const mainSub = await prisma.formSubmission.findUnique({
          where: { id: prereqLink.mainSubmissionId },
        });
        if (!mainSub || mainSub.status !== "Blocked - Awaiting Prerequisites") return;

        await prisma.formSubmission.update({
          where: { id: prereqLink.mainSubmissionId },
          data: { status: "Submitted" },
        });

        await logAudit({
          submissionId: prereqLink.mainSubmissionId,
          formReference: mainSub.reference,
          prevStatus: "Blocked - Awaiting Prerequisites",
          newStatus: "Submitted",
          action: "unblocked",
          note: "All prerequisite forms approved. Submission is now active.",
        });

        // Notify active pending signatories
        await notifyActiveSignatories(prereqLink.mainSubmissionId);
      }
    } catch (err) {
      console.error("[prerequisites] Failed to check prerequisite unblocking:", err);
    }
  });
}


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
        documents: true,
        prerequisites: {
          include: {
            targetForm: { select: { name: true } },
            prereqSubmission: { select: { reference: true, status: true } },
          }
        }
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
        documents: true,
        prerequisites: {
          include: {
            targetForm: { select: { name: true } },
            prereqSubmission: { select: { reference: true, status: true } },
          }
        }
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
      contractRequests: true,
      documents: true,
    },
  });
  if (!sub) { res.status(404).json({ success: false, error: "Not found" }); return; }
  res.json({ success: true, data: sub });
});

// ── POST /api/v1/workflow/:id/assign-self ─────────────────────────────────────
router.post("/:id/assign-self", async (req: AuthRequest, res: Response) => {
  const userName = req.user?.user_name ?? req.user?.email ?? "Unknown";
  const email = req.user?.email ?? null;
  const firstName = userName.split(" ")[0];
  const newStatus = `Assigned to ${firstName}`;

  const current = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    select: {
      status: true,
      reference: true,
      template: { select: { needsContract: true } },
      contractRequests: { select: { status: true } }
    },
  });

  if (!current) {
    res.status(404).json({ success: false, error: "Submission not found." });
    return;
  }

  if (current.template?.needsContract) {
    const hasSignedContract = current.contractRequests.some((c: any) => c.status === "Signed");
    if (!hasSignedContract) {
      res.status(400).json({ success: false, error: "Awaiting signed contract from submitter." });
      return;
    }
  }

  await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: { status: newStatus, treatedBy: userName, treaterEmail: email },
  });

  await logAudit({
    submissionId: req.params.id,
    formReference: current?.reference,
    prevStatus: current?.status ?? "",
    newStatus,
    action: "assigned",
    actorName: userName,
    actorEmail: email,
  });

  res.json({ success: true, newStatus });
});

// ── PATCH /api/v1/workflow/:id/revert-assignment ──────────────────────────────
// Allows the assigned treater to release their self-assignment, reverting
// the submission back to "Processing" so another treater can pick it up.
router.patch("/:id/revert-assignment", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email ?? null;
  if (!email) {
    res.status(401).json({ success: false, error: "Not authenticated." });
    return;
  }

  const current = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    select: { status: true, reference: true, treaterEmail: true },
  });

  if (!current) {
    res.status(404).json({ success: false, error: "Submission not found." });
    return;
  }

  if (!current.status.startsWith("Assigned")) {
    res.status(400).json({ success: false, error: "This submission is not currently assigned." });
    return;
  }

  // Only the person who assigned themselves can revert
  if (current.treaterEmail?.toLowerCase() !== email.toLowerCase()) {
    res.status(403).json({ success: false, error: "Only the person who self-assigned can revert the assignment." });
    return;
  }

  await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: { status: "Processing", treatedBy: null, treaterEmail: null },
  });

  await logAudit({
    submissionId: req.params.id,
    formReference: current.reference,
    prevStatus: current.status,
    newStatus: "Processing",
    action: "assignment_reverted",
    actorEmail: email,
    note: "Assignee reverted self-assignment — returned to Processing",
  });

  res.json({ success: true, newStatus: "Processing" });
});


// Complete processing: optionally route to a final approver.
// A signatureToken is ALWAYS required from the treater, regardless of routing.
router.post("/:id/complete", async (req: AuthRequest, res: Response) => {
  const { approverEmail, approverName, signatureToken } = req.body;
  const email = req.user?.email ?? null;

  // Always require the treater's token
  if (!email) { res.status(401).json({ success: false, error: "Not authenticated." }); return; }
  if (!signatureToken) {
    res.status(400).json({ success: false, error: "Your signature token is required." });
    return;
  }
  const hashedInput = hashToken(signatureToken);
  const secData = await prisma.securityData.findFirst({ where: { userEmail: { equals: email!, mode: "insensitive" } } });
  if (!secData || secData.hashedToken !== hashedInput) {
    res.status(400).json({ success: false, error: "Invalid signature token. Please check and try again." });
    return;
  }

  const current = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    select: { status: true, reference: true },
  });

  // Block if there are uncommitted journal entries for this form (or its batch) - BYPASSED (Legacy mode)
  /*
  if (current?.reference) {
    const batchSample = await prisma.journalEntry.findFirst({
      where: { sessionRef: current.reference, batchGroupId: { not: null } },
      select: { batchGroupId: true },
    });
    const uncommittedWhere = batchSample?.batchGroupId
      ? { batchGroupId: batchSample.batchGroupId, committed: false }
      : { sessionRef: current.reference, committed: false };

    const uncommitted = await prisma.journalEntry.count({ where: uncommittedWhere });
    if (uncommitted > 0) {
      res.status(400).json({
        success: false,
        error: `There ${uncommitted === 1 ? "is" : "are"} ${uncommitted} uncommitted journal entr${uncommitted === 1 ? "y" : "ies"} for this form${batchSample ? " (batch)" : ""}. Please commit all journal entries before submitting to the final approver.`,
      });
      return;
    }
  }
  */
  const treaterUser = await prisma.user.findFirst({
    where: { finca_email: { equals: email!, mode: "insensitive" } },
    select: { user_name: true },
  });
  const treaterName = treaterUser?.user_name ?? email ?? "Unknown";

  if (!approverEmail) {
    await prisma.formSubmission.update({
      where: { id: req.params.id },
      data: { status: "Completed", approvedBy: "None", approverEmail: null },
    });
    await logAudit({
      submissionId: req.params.id,
      formReference: current?.reference,
      prevStatus: current?.status ?? "",
      newStatus: "Completed",
      action: "completed",
      actorName: treaterName,
      actorEmail: email,
      note: "Completed without further approval",
    });
    // Trigger successful completion email to submitter
    notifySuccessfulCompletion(req.params.id);
  } else {
    // Routing to a final approver
    await prisma.formSubmission.update({
      where: { id: req.params.id },
      data: {
        status: "Awaiting Final Approval",
        approvedBy: approverName ?? approverEmail,
        approverEmail,
      },
    });
    await logAudit({
      submissionId: req.params.id,
      formReference: current?.reference,
      prevStatus: current?.status ?? "",
      newStatus: "Awaiting Final Approval",
      action: "routed_for_approval",
      actorName: treaterName,
      actorEmail: email,
      note: `Routed to ${approverName ?? approverEmail} (${approverEmail})`,
    });
    // Trigger final approval request email
    notifyFinalApprover(req.params.id);
  }
  res.json({ success: true });
});

// ── POST /api/v1/workflow/:id/approve ─────────────────────────────────────────
// Final approver signs off with their token and marks the submission as Completed
router.post("/:id/approve", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email ?? null;
  if (!email) { res.status(401).json({ success: false, error: "Not authenticated." }); return; }

  const { signatureToken } = req.body;
  if (!signatureToken) {
    res.status(400).json({ success: false, error: "Your signature token is required to approve." });
    return;
  }

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

  // Validate token
  const hashedInput = hashToken(signatureToken);
  const secData = await prisma.securityData.findFirst({ where: { userEmail: { equals: email!, mode: "insensitive" } } });
  if (!secData || secData.hashedToken !== hashedInput) {
    res.status(400).json({ success: false, error: "Invalid signature token. Please check and try again." });
    return;
  }

  // Resolve the approver's real display name
  const approverUser = await prisma.user.findFirst({
    where: { finca_email: { equals: email, mode: "insensitive" } },
    select: { user_name: true },
  });
  const approverName = approverUser?.user_name ?? email;

  const currentForApprove = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    select: { status: true, reference: true },
  });

  await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: {
      status: "Completed",
      approvedBy: approverName,
      approverEmail: email,
    },
  });

  await logAudit({
    submissionId: req.params.id,
    formReference: currentForApprove?.reference,
    prevStatus: currentForApprove?.status ?? "",
    newStatus: "Completed",
    action: "approved",
    actorName: approverName,
    actorEmail: email,
  });

  // Trigger successful completion email to submitter
  notifySuccessfulCompletion(req.params.id);

  // Commit all pending journal entries for this submission's reference
  if (currentForApprove?.reference) {
    await prisma.journalEntry.updateMany({
      where: { sessionRef: currentForApprove.reference, committed: false },
      data: { committed: true },
    });
  }

  checkAndUnblockPrerequisites(req.params.id);

  res.json({ success: true });
});

// ── POST /api/v1/workflow/:id/decline-final ────────────────────────────────────
// Final approver declines → submission reverts to Processing (no signatory row needed)
router.post("/:id/decline-final", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email ?? null;
  if (!email) { res.status(401).json({ success: false, error: "Not authenticated." }); return; }

  const sub = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    select: { status: true, approverEmail: true, reference: true },
  });

  if (!sub || sub.status !== "Awaiting Final Approval") {
    res.status(400).json({ success: false, error: "Submission is not awaiting final approval." });
    return;
  }
  if (sub.approverEmail?.toLowerCase() !== email.toLowerCase()) {
    res.status(403).json({ success: false, error: "You are not the designated approver." });
    return;
  }

  const declinedFinalUser = await prisma.user.findFirst({
    where: { finca_email: { equals: email!, mode: "insensitive" } },
    select: { user_name: true },
  });
  const declinedFinalName = declinedFinalUser?.user_name ?? email;

  await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: { status: "Processing", approvedBy: null, approverEmail: null },
  });

  await logAudit({
    submissionId: req.params.id,
    formReference: sub.reference ?? null,
    prevStatus: "Awaiting Final Approval",
    newStatus: "Processing",
    action: "final_declined",
    actorName: declinedFinalName,
    actorEmail: email,
    note: "Final approver returned — returned to Processing",
  });

  // Uncommit journal entries — approver returned the form, entries revert to pending
  if (sub.reference) {
    await prisma.journalEntry.updateMany({
      where: { sessionRef: sub.reference },
      data: { committed: false },
    });
  }

  res.json({ success: true });
});

// ── POST /api/v1/workflow/:id/disapprove-final ──────────────────────────────────
// Final approver permanently disapproves the submission → status changes to "Not Approved"
router.post("/:id/disapprove-final", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email ?? null;
  if (!email) { res.status(401).json({ success: false, error: "Not authenticated." }); return; }

  const { reason } = req.body;
  if (!reason || !reason.trim()) {
    res.status(400).json({ success: false, error: "A reason is required to disapprove." });
    return;
  }

  const sub = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    select: { status: true, approverEmail: true, reference: true, formName: true, submittedBy: { select: { finca_email: true, user_name: true } } },
  });

  if (!sub || sub.status !== "Awaiting Final Approval") {
    res.status(400).json({ success: false, error: "Submission is not awaiting final approval." });
    return;
  }
  if (sub.approverEmail?.toLowerCase() !== email.toLowerCase()) {
    res.status(403).json({ success: false, error: "You are not the designated approver." });
    return;
  }

  const disapprovedFinalUser = await prisma.user.findFirst({
    where: { finca_email: { equals: email!, mode: "insensitive" } },
    select: { user_name: true },
  });
  const disapprovedFinalName = disapprovedFinalUser?.user_name ?? email;

  await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: { status: "Not Approved" },
  });

  await logAudit({
    submissionId: req.params.id,
    formReference: sub.reference ?? null,
    prevStatus: "Awaiting Final Approval",
    newStatus: "Not Approved",
    action: "final_disapproved",
    actorName: disapprovedFinalName,
    actorEmail: email,
    note: reason.trim(),
  });

  // Uncommit journal entries
  if (sub.reference) {
    await prisma.journalEntry.updateMany({
      where: { sessionRef: sub.reference },
      data: { committed: false },
    });
  }

  // Send email to submitter
  if (sub.submittedBy?.finca_email) {
    const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";
    mailer.sendMail({
      from: `FINCALite <${process.env.SMTP_FROM ?? "noreply@paperless.ng"}>`,
      to: sub.submittedBy.finca_email,
      subject: `Submission Disapproved: "${sub.formName}"`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
          <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
          <hr style="border-color: #e5e7eb; margin: 20px 0;" />
          <p style="font-size: 15px; color: #111827;">Hi <strong>${sub.submittedBy.user_name ?? "there"}</strong>,</p>
          <p style="font-size: 14px; color: #374151;">
            Your submission has been <strong>Disapproved</strong> by the final approver and will not be processed further.
          </p>
          <div style="background: #fef2f2; border-left: 4px solid #ef4444; border-radius: 4px; padding: 16px; margin: 16px 0;">
            <p style="margin: 0; font-weight: 600; color: #991b1b;">${sub.formName}</p>
            <p style="margin: 4px 0 0; font-size: 13px; color: #b91c1c;">Reference: ${sub.reference ?? "N/A"}</p>
            <p style="margin: 8px 0 0; font-size: 14px; color: #991b1b;"><strong>Reason:</strong> ${reason.trim()}</p>
          </div>
          <a href="${appUrl}/dashboard/forms/submission/${req.params.id}" style="display: inline-block; background: #ef4444; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">View Submission</a>
        </div>
      `,
    }).catch((e: any) => console.error("[disapprove email]", e));
  }

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
    const secData = await prisma.securityData.findFirst({ where: { userEmail: { equals: userEmail!, mode: "insensitive" } } });
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

  const currentForSign = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    select: {
      status: true,
      reference: true,
      signingType: true,
      template: { select: { needsContract: true, contractTemplateId: true, formTreater: true, pdfGeneratorType: true } },
      submittedBy: { select: { finca_email: true } }
    },
  });

  const signerUser = await prisma.user.findFirst({
    where: { finca_email: { equals: email!, mode: "insensitive" } },
    select: { user_name: true },
  });
  const signerName = signerUser?.user_name ?? email;

  // If there's no treater branch configured, skip "Processing" and go straight to "Completed"
  const hasTreater = !!(currentForSign?.template?.formTreater && currentForSign.template.formTreater.toLowerCase() !== "none");
  const newSignStatus = unsigned === 0 ? (hasTreater ? "Processing" : "Completed") : "In-review";

  const updatedSubmission = await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: { status: newSignStatus },
  });

  await logAudit({
    submissionId: req.params.id,
    formReference: currentForSign?.reference,
    prevStatus: currentForSign?.status ?? "",
    newStatus: newSignStatus,
    action: "signed",
    actorName: signerName,
    actorEmail: email,
    note: unsigned === 0 ? "Last signature — all signers complete" : `${unsigned} signature(s) still pending`,
  });

  // Trigger notifications based on new status
  if (newSignStatus === "Completed") {
    notifySuccessfulCompletion(req.params.id);
  } else if (newSignStatus === "In-review" && currentForSign?.signingType === "sequential") {
    notifyActiveSignatories(req.params.id);
  }

  // ── Respond immediately — signer should never wait for PDF/SharePoint ─────
  res.json({ success: true });

  // ── Background: generate + store the PDF once all signers are done ─────────
  // Only if the form template has a PDF generator type configured (not "none")
  const pdfGeneratorType = currentForSign?.template?.pdfGeneratorType ?? "none";
  if (unsigned === 0 && pdfGeneratorType !== "none") {
    if (currentForSign?.template?.needsContract && currentForSign.template.contractTemplateId && currentForSign.submittedBy?.finca_email) {
      await prisma.contractRequest.create({
        data: {
          submissionId: req.params.id,
          templateId: currentForSign.template.contractTemplateId,
          submitterEmail: currentForSign.submittedBy.finca_email,
        }
      });
    }

    checkAndUnblockPrerequisites(req.params.id);
    // Queue PDF generation for the background worker
    await prisma.pdfJobQueue.create({
      data: {
        sourceSubmissionId: req.params.id,
        jobType: "MainForm",
      },
    });
    console.info(`[pdf] Queued PDF generation for submission ${req.params.id}`);
  } else if (unsigned === 0) {
    // No PDF, but still need contract + prerequisite unblocking
    if (currentForSign?.template?.needsContract && currentForSign.template.contractTemplateId && currentForSign.submittedBy?.finca_email) {
      await prisma.contractRequest.create({
        data: {
          submissionId: req.params.id,
          templateId: currentForSign.template.contractTemplateId,
          submitterEmail: currentForSign.submittedBy.finca_email,
        }
      });
    }
    checkAndUnblockPrerequisites(req.params.id);
  }
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

  const currentForDecline = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    select: { status: true, reference: true },
  });

  const declinerUser = await prisma.user.findFirst({
    where: { finca_email: { equals: email!, mode: "insensitive" } },
    select: { user_name: true },
  });
  const declinerName = declinerUser?.user_name ?? email;

  await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: { status: "Rejected" },
  });

  await logAudit({
    submissionId: req.params.id,
    formReference: currentForDecline?.reference,
    prevStatus: currentForDecline?.status ?? "",
    newStatus: "Rejected",
    action: "declined",
    actorName: declinerName,
    actorEmail: email,
    note: reason?.trim() || null,
  });

  // Uncommit all journal entries — submission rejected, removed from global ledger
  // but entries remain so the officer can review/edit and resubmit
  if (currentForDecline?.reference) {
    await prisma.journalEntry.updateMany({
      where: { sessionRef: currentForDecline.reference },
      data: { committed: false },
    });
  }

  res.json({ success: true });
});

// ── POST /api/v1/workflow/:id/disapprove-signatory ───────────────────────────
router.post("/:id/disapprove-signatory", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email ?? null;
  if (!email) { res.status(401).json({ success: false, error: "Not authenticated." }); return; }

  const { reason } = req.body;
  if (!reason || !reason.trim()) {
    res.status(400).json({ success: false, error: "A reason is required to disapprove." });
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
    res.status(404).json({ success: false, error: "Signatory record not found." });
    return;
  }

  await prisma.submissionSignatory.update({
    where: { id: sigRow.id },
    data: {
      status: "Declined",
      signedAt: new Date(),
      declineReason: reason.trim(),
    },
  });

  const currentForDecline = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    select: { status: true, reference: true, formName: true, submittedBy: { select: { finca_email: true, user_name: true } } },
  });

  const declinerUser = await prisma.user.findFirst({
    where: { finca_email: { equals: email!, mode: "insensitive" } },
    select: { user_name: true },
  });
  const declinerName = declinerUser?.user_name ?? email;

  await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: { status: "Not Approved" },
  });

  await logAudit({
    submissionId: req.params.id,
    formReference: currentForDecline?.reference,
    prevStatus: currentForDecline?.status ?? "",
    newStatus: "Not Approved",
    action: "disapproved",
    actorName: declinerName,
    actorEmail: email,
    note: reason.trim(),
  });

  if (currentForDecline?.reference) {
    await prisma.journalEntry.updateMany({
      where: { sessionRef: currentForDecline.reference },
      data: { committed: false },
    });
  }

  if (currentForDecline?.submittedBy?.finca_email) {
    const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";
    mailer.sendMail({
      from: `FINCALite <${process.env.SMTP_FROM ?? "noreply@paperless.ng"}>`,
      to: currentForDecline.submittedBy.finca_email,
      subject: `Submission Disapproved: "${currentForDecline.formName}"`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
          <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
          <hr style="border-color: #e5e7eb; margin: 20px 0;" />
          <p style="font-size: 15px; color: #111827;">Hi <strong>${currentForDecline.submittedBy.user_name ?? "there"}</strong>,</p>
          <p style="font-size: 14px; color: #374151;">
            Your submission has been <strong>Disapproved</strong> by a signatory and will not be processed further.
          </p>
          <div style="background: #fef2f2; border-left: 4px solid #ef4444; border-radius: 4px; padding: 16px; margin: 16px 0;">
            <p style="margin: 0; font-weight: 600; color: #991b1b;">${currentForDecline.formName}</p>
            <p style="margin: 4px 0 0; font-size: 13px; color: #b91c1c;">Reference: ${currentForDecline.reference ?? "N/A"}</p>
            <p style="margin: 8px 0 0; font-size: 14px; color: #991b1b;"><strong>Reason:</strong> ${reason.trim()}</p>
          </div>
          <a href="${appUrl}/dashboard/forms/submission/${req.params.id}" style="display: inline-block; background: #ef4444; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">View Submission</a>
        </div>
      `,
    }).catch((e: any) => console.error("[disapprove email]", e));
  }

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
    from: `FINCALite <${process.env.SMTP_FROM ?? "noreply@paperless.ng"}>`,
    to: signatory.email,
    subject: `Reminder: Your signature is required on "${submission.formName}"`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
        <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
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
        <p style="font-size: 14px; color: #374151;">Please log in to the FINCALite platform to review and sign.</p>
        <a href="${appUrl}/dashboard/workflow" style="display: inline-block; background: #B50938; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">Go to Workflow Queue</a>
        <p style="font-size: 12px; color: #9ca3af; margin-top: 24px;">If you believe this was sent in error, please contact your administrator.</p>
      </div>
    `,
  });

  res.json({ success: true, message: `Reminder sent to ${signatory.email}` });
});

// ── POST /api/v1/workflow/:id/generate-pdf ───────────────────────────────────
// Manually recreate and upload the fully signed PDF if the automatic process failed
router.post("/:id/generate-pdf", async (req: AuthRequest, res: Response) => {
  const submission = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
  });

  if (!submission) {
    res.status(404).json({ success: false, error: "Submission not found" });
    return;
  }

  try {
    const pdfResult = await generateSubmissionPdf(req.params.id);
    if (!pdfResult) {
      res.status(400).json({ success: false, error: "Could not generate PDF backend output" });
      return;
    }

    const formFolder = submission.formName.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase();
    const refFolder = submission.reference?.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase() || submission.id.slice(-6).toUpperCase();
    const folder = process.env.SHAREPOINT_UPLOAD_FOLDER 
      ? `${process.env.SHAREPOINT_UPLOAD_FOLDER}/${formFolder}/${refFolder}`
      : `${formFolder}/${refFolder}`;
    const storedPath: string = await uploadToSharePoint(
      pdfResult.buffer,
      pdfResult.filename,
      "application/pdf",
      folder
    );

    if (storedPath) {
      const created = await prisma.submissionDocument.create({
        data: {
          submissionId: submission.id,
          fieldName: "CompletedFormPDF",
          originalName: pdfResult.filename,
          filePath: storedPath,
          mimeType: "application/pdf",
          size: pdfResult.buffer.length,
        },
      });

      const resData = (submission.formResponses as Record<string, any>) || {};
      resData["CompletedFormPDF"] = [
        { isAttachment: true, name: pdfResult.filename, url: `/api/v1/file?docId=${created.id}` }
      ];

      await prisma.formSubmission.update({
        where: { id: req.params.id },
        data: { formResponses: resData },
      });

      res.json({ success: true, message: "PDF generated and attached successfully." });
    } else {
      res.status(500).json({ success: false, error: "Failed to store PDF." });
    }
  } catch (err: any) {
    console.error("Error manually generating PDF:", err);
    res.status(500).json({ success: false, error: err.message || "Error generating PDF" });
  }
});

// ── Helper notification functions ───────────────────────────────────────────

export async function notifyActiveSignatories(submissionId: string) {
  try {
    const submission = await prisma.formSubmission.findUnique({
      where: { id: submissionId },
      include: {
        signatories: { orderBy: { position: "asc" } },
        submittedBy: { select: { user_name: true, finca_email: true } },
      },
    });
    if (!submission) return;

    // Do not notify signatories if blocked
    if (submission.status === "Blocked - Awaiting Prerequisites") return;

    let activeSignatories: any[] = [];
    if (submission.signingType === "parallel") {
      activeSignatories = submission.signatories.filter((s: any) => s.status === "Pending");
    } else {
      const firstPending = submission.signatories.find((s: any) => s.status === "Pending");
      if (firstPending) {
        activeSignatories = [firstPending];
      }
    }

    const submitterName = submission.submittedBy?.user_name ?? "A colleague";
    const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";

    if (activeSignatories.length > 0) {
      console.info(`[notifyActiveSignatories] Sending signature request email(s) for submission ${submissionId} to: ${activeSignatories.map((s) => s.email).join(", ")}`);
    }

    for (const signatory of activeSignatories) {
      await mailer.sendMail({
        from: `FINCALite <${process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "noreply@paperless.ng"}>`,
        to: signatory.email,
        subject: `Action Required: "${submission.formName}" is ready for your signature`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
            <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
            <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
            <hr style="border-color: #e5e7eb; margin: 20px 0;" />
            <p style="font-size: 15px; color: #111827;">Hi <strong>${signatory.userName}</strong>,</p>
            <p style="font-size: 14px; color: #374151;">
              A form requires your signature. Please review the details below:
            </p>
            <div style="background: #f9fafb; border-left: 4px solid #B50938; border-radius: 4px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0; font-weight: 600; color: #111827;">${submission.formName}</p>
              <p style="margin: 4px 0 0; font-size: 13px; color: #6b7280;">Reference: ${submission.reference ?? "N/A"}</p>
              <p style="margin: 4px 0 0; font-size: 13px; color: #6b7280;">Submitted by: ${submitterName}</p>
            </div>
            <p style="font-size: 14px; color: #374151;">Please log in to the FINCALite platform to review and sign.</p>
            <a href="${appUrl}/dashboard/workflow" style="display: inline-block; background: #B50938; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">Go to Workflow Queue</a>
            <p style="font-size: 12px; color: #9ca3af; margin-top: 24px;">If you believe this was sent in error, please contact your administrator.</p>
          </div>
        `,
      }).then(() => {
        console.info(`[notifyActiveSignatories] Signature request email successfully sent to ${signatory.email}`);
      }).catch((e: any) => console.error("[notify active signatories email error]", e));
    }
  } catch (err) {
    console.error("[notifyActiveSignatories] error:", err);
  }
}

export async function notifyFinalApprover(submissionId: string) {
  try {
    const submission = await prisma.formSubmission.findUnique({
      where: { id: submissionId },
      include: {
        submittedBy: { select: { user_name: true, finca_email: true } },
      },
    });
    if (!submission || !submission.approverEmail) return;

    const submitterName = submission.submittedBy?.user_name ?? "A colleague";
    const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";

    console.info(`[notifyFinalApprover] Sending final approval request email for submission ${submissionId} to ${submission.approverEmail}`);

    await mailer.sendMail({
      from: `FINCALite <${process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "noreply@paperless.ng"}>`,
      to: submission.approverEmail,
      subject: `Action Required: Final Approval needed for "${submission.formName}"`,
      html: `
          <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
            <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
            <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
            <hr style="border-color: #e5e7eb; margin: 20px 0;" />
            <p style="font-size: 15px; color: #111827;">Hi <strong>${submission.approvedBy ?? "Approver"}</strong>,</p>
            <p style="font-size: 14px; color: #374151;">
              A submission has been processed and is now pending your final approval:
            </p>
            <div style="background: #f9fafb; border-left: 4px solid #B50938; border-radius: 4px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0; font-weight: 600; color: #111827;">${submission.formName}</p>
              <p style="margin: 4px 0 0; font-size: 13px; color: #6b7280;">Reference: ${submission.reference ?? "N/A"}</p>
              <p style="margin: 4px 0 0; font-size: 13px; color: #6b7280;">Submitted by: ${submitterName}</p>
              <p style="margin: 4px 0 0; font-size: 13px; color: #6b7280;">Treated by: ${submission.treatedBy ?? "System"}</p>
            </div>
            <p style="font-size: 14px; color: #374151;">Please log in to the FINCALite platform to review and approve/disapprove.</p>
            <a href="${appUrl}/dashboard/workflow" style="display: inline-block; background: #B50938; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">Go to Workflow Queue</a>
            <p style="font-size: 12px; color: #9ca3af; margin-top: 24px;">If you believe this was sent in error, please contact your administrator.</p>
          </div>
      `,
    }).then(() => {
      console.info(`[notifyFinalApprover] Final approval request email successfully sent to ${submission.approverEmail}`);
    }).catch((e: any) => console.error("[notify final approver email error]", e));
  } catch (err) {
    console.error("[notifyFinalApprover] error:", err);
  }
}

export async function notifySuccessfulCompletion(submissionId: string) {
  try {
    const submission = await prisma.formSubmission.findUnique({
      where: { id: submissionId },
      include: {
        submittedBy: { select: { user_name: true, finca_email: true } },
      },
    });

    const submittedBy = submission?.submittedBy;
    if (!submission || !submittedBy?.finca_email) return;

    const emailTo = submittedBy.finca_email;
    const userName = submittedBy.user_name ?? "there";
    const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";

    console.info(`[notifySuccessfulCompletion] Sending successful completion email for submission ${submissionId} to submitter ${emailTo}`);

    await mailer.sendMail({
      from: `FINCALite <${process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "noreply@paperless.ng"}>`,
      to: emailTo,
      subject: `Submission Approved: "${submission.formName}"`,
      html: `
          <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
            <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
            <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
            <hr style="border-color: #e5e7eb; margin: 20px 0;" />
            <p style="font-size: 15px; color: #111827;">Hi <strong>${userName}</strong>,</p>
            <p style="font-size: 14px; color: #374151;">
              We are pleased to inform you that your submission has been successfully approved and completed!
            </p>
            <div style="background: #ecfdf5; border-left: 4px solid #10b981; border-radius: 4px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0; font-weight: 600; color: #065f46;">${submission.formName}</p>
              <p style="margin: 4px 0 0; font-size: 13px; color: #047857;">Reference: ${submission.reference ?? "N/A"}</p>
              <p style="margin: 8px 0 0; font-size: 14px; color: #065f46;"><strong>Status:</strong> Approved & Completed</p>
            </div>
            <a href="${appUrl}/dashboard/forms/submission/${submission.id}" style="display: inline-block; background: #10b981; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">View Submission</a>
            <p style="font-size: 12px; color: #9ca3af; margin-top: 24px;">If you believe this was sent in error, please contact your administrator.</p>
          </div>
      `,
    }).then(() => {
      console.info(`[notifySuccessfulCompletion] Completion email successfully sent to ${emailTo}`);
    }).catch((e: any) => console.error("[notify successful completion email error]", e));
  } catch (err) {
    console.error("[notifySuccessfulCompletion] error:", err);
  }
}

export async function notifySubmitterOfSubmission(submissionId: string) {
  try {
    const submission = await prisma.formSubmission.findUnique({
      where: { id: submissionId },
      include: {
        submittedBy: { select: { user_name: true, finca_email: true } },
      },
    });

    const submittedBy = submission?.submittedBy;
    if (!submission || !submittedBy?.finca_email) return;

    const emailTo = submittedBy.finca_email;
    const userName = submittedBy.user_name ?? "there";
    const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";

    console.info(`[notifySubmitterOfSubmission] Sending submission confirmation email for submission ${submissionId} to submitter ${emailTo}`);

    await mailer.sendMail({
      from: `FINCALite <${process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "noreply@paperless.ng"}>`,
      to: emailTo,
      subject: `Submission Confirmation: "${submission.formName}"`,
      html: `
          <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
            <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
            <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
            <hr style="border-color: #e5e7eb; margin: 20px 0;" />
            <p style="font-size: 15px; color: #111827;">Hi <strong>${userName}</strong>,</p>
            <p style="font-size: 14px; color: #374151;">
              We have successfully received your submission.
            </p>
            <div style="background: #f9fafb; border-left: 4px solid #B50938; border-radius: 4px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0; font-weight: 600; color: #111827;">${submission.formName}</p>
              <p style="margin: 4px 0 0; font-size: 13px; color: #6b7280;">Reference: ${submission.reference ?? "N/A"}</p>
            </div>
            <a href="${appUrl}/dashboard/forms/submission/${submission.id}" style="display: inline-block; background: #B50938; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">View Submission</a>
            <p style="font-size: 12px; color: #9ca3af; margin-top: 24px;">If you believe this was sent in error, please contact your administrator.</p>
          </div>
      `,
    }).then(() => {
      console.info(`[notifySubmitterOfSubmission] Submission confirmation email successfully sent to ${emailTo}`);
    }).catch((e: any) => console.error("[notify submitter email error]", e));
  } catch (err) {
    console.error("[notifySubmitterOfSubmission] error:", err);
  }
}

export default router;
