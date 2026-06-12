import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { mailer } from "../lib/mailer";

const router = Router();
router.use(authenticate as any);

// ── GET /api/v1/prerequisites/for/:submissionId ───────────────────────────────
// Returns all prerequisite records for a given main submission, including
// a snapshot of the linked prerequisite submission (if created).
router.get("/for/:submissionId", async (req: AuthRequest, res: Response) => {
  const prereqs = await prisma.submissionPrerequisite.findMany({
    where: { mainSubmissionId: req.params.submissionId },
    include: {
      targetForm: { select: { id: true, name: true } },
      prereqSubmission: {
        select: { id: true, reference: true, status: true, formName: true },
      },
    },
    orderBy: { id: "asc" },
  });
  res.json({ success: true, data: prereqs });
});

// ── GET /api/v1/prerequisites/public/:token ───────────────────────────────────
// Public endpoint: lets an external (non-registered) recipient open their
// assigned prerequisite draft using a short-lived token stored on the record.
// The link is sent in the notification email.
router.get("/public/:prereqSubmissionId", async (req, res: Response) => {
  const prereq = await prisma.submissionPrerequisite.findFirst({
    where: { prereqSubmissionId: req.params.prereqSubmissionId },
    include: {
      prereqSubmission: {
        include: { signatories: true, template: true },
      },
      targetForm: { select: { id: true, name: true, fields: true } },
    },
  });

  if (!prereq || !prereq.prereqSubmission) {
    res.status(404).json({ success: false, error: "Prerequisite not found.", code: "PREREQUISITE_NOT_FOUND" });
    return;
  }

  res.json({ success: true, data: prereq });
});

// ── POST /api/v1/prerequisites/:id/remind ─────────────────────────────────────
// Sends a reminder email to the target email of a pending prerequisite.
router.post("/:id/remind", async (req: AuthRequest, res: Response) => {
  const prereqId = req.params.id;

  const prereq = await prisma.submissionPrerequisite.findUnique({
    where: { id: prereqId },
    include: {
      targetForm: { select: { name: true } },
      prereqSubmission: { select: { id: true, reference: true } },
    },
  });

  if (!prereq) {
    res.status(404).json({ success: false, error: "Prerequisite not found.", code: "PREREQUISITE_NOT_FOUND" });
    return;
  }

  if (prereq.status !== "Pending" && prereq.status !== "Active") {
    res.status(400).json({ success: false, error: "Can only remind pending or active prerequisites.", code: "CAN_ONLY_REMIND_PENDING_OR_ACT" });
    return;
  }

  if (!prereq.prereqSubmission) {
    res.status(400).json({ success: false, error: "Prerequisite draft missing.", code: "PREREQUISITE_DRAFT_MISSING" });
    return;
  }

  try {
    const targetEmail = prereq.targetEmail;
    const targetFormName = prereq.targetForm?.name ?? "Form";
    if (!targetEmail) {
      res.status(400).json({ success: false, error: "No target email specified.", code: "NO_TARGET_EMAIL_SPECIFIED" });
      return;
    }

    const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";
    const fillUrl = `${appUrl}/dashboard/forms/draft/${prereq.prereqSubmission.id}`;

    await mailer.sendMail({
      from: `FINCALite <${process.env.SMTP_FROM ?? "noreply@paperless.ng"}>`,
      to: targetEmail,
      subject: `Reminder: Please complete the "${targetFormName}" form`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
          <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
          <hr style="border-color: #e5e7eb; margin: 20px 0;" />
          <p style="font-size: 15px; color: #111827;">Hello,</p>
          <p style="font-size: 14px; color: #374151;">
            This is a reminder that you have been requested to complete a prerequisite form before a submission can proceed for approval.
          </p>
          <div style="background: #f9fafb; border-left: 4px solid #B50938; border-radius: 4px; padding: 16px; margin: 16px 0;">
            <p style="margin: 0; font-weight: 600; color: #111827;">${targetFormName}</p>
            <p style="margin: 4px 0 0; font-size: 13px; color: #6b7280;">Reference: ${prereq.prereqSubmission.reference}</p>
          </div>
          <p style="font-size: 14px; color: #374151;">Please click the button below to open and complete your form. You may be asked to log in if you are a registered user.</p>
          <a href="${fillUrl}" style="display: inline-block; background: #B50938; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">Open & Complete Form</a>
          <p style="font-size: 12px; color: #9ca3af; margin-top: 24px;">If you believe this was sent in error, please contact your administrator.</p>
        </div>
      `,
    });
    res.json({ success: true, message: "Reminder sent successfully." });
  } catch (error: any) {
    console.error("[prereq remind]", error);
    res.status(500).json({ success: false, error: "Failed to send reminder email.", code: "FAILED_TO_SEND_REMINDER_EMAIL" });
  }
});

// ── POST /api/v1/prerequisites/:id/decline ────────────────────────────────────
router.post("/:id/decline", async (req: AuthRequest, res: Response) => {
  const prereqId = req.params.id;
  const { reason } = req.body;
  const email = req.user?.email ?? null;

  if (!reason || typeof reason !== "string") {
    res.status(400).json({ success: false, error: "Decline reason is required.", code: "DECLINE_REASON_IS_REQUIRED" });
    return;
  }

  const prereq = await prisma.submissionPrerequisite.findUnique({
    where: { id: prereqId },
    include: {
      targetForm: { select: { name: true } },
      mainSubmission: { 
        select: { id: true, reference: true, submittedById: true, formName: true }
      }
    },
  });

  if (!prereq) {
    res.status(404).json({ success: false, error: "Prerequisite not found.", code: "PREREQUISITE_NOT_FOUND" });
    return;
  }

  if (prereq.status === "Approved" || prereq.status === "Declined") {
    res.status(400).json({ success: false, error: "Prerequisite already processed.", code: "PREREQUISITE_ALREADY_PROCESSED" });
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Mark Prerequisite as Declined
      await tx.submissionPrerequisite.update({
        where: { id: prereqId },
        data: { status: "Declined", declineReason: reason },
      });

      // 2. Reject the Main Submission
      await tx.formSubmission.update({
        where: { id: prereq.mainSubmissionId },
        data: { status: "Rejected" },
      });
    });

    // 3. Notify Submitter if they have "Rejection" notifications enabled
    if (prereq.mainSubmission.submittedById) {
      const submitter = await prisma.user.findUnique({
        where: { id: prereq.mainSubmission.submittedById },
        select: { finca_email: true, notificationPreferences: true }
      });
      
      if (submitter && submitter.finca_email) {
        let shouldNotify = true;
        if (submitter.notificationPreferences) {
          try {
            const prefs = typeof submitter.notificationPreferences === 'string' 
              ? JSON.parse(submitter.notificationPreferences) 
              : submitter.notificationPreferences;
            if (prefs.rejections === false) shouldNotify = false;
          } catch(e) {}
        }
        
        if (shouldNotify) {
          const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";
          const subUrl = `${appUrl}/dashboard/forms/submission/${prereq.mainSubmission.id}`;
          
          await mailer.sendMail({
            from: `FINCALite <${process.env.SMTP_FROM ?? "noreply@paperless.ng"}>`,
            to: submitter.finca_email,
            subject: `Submission Rejected: ${prereq.mainSubmission.formName}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
                <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
                <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
                <hr style="border-color: #e5e7eb; margin: 20px 0;" />
                <p style="font-size: 15px; color: #111827;">Hello,</p>
                <p style="font-size: 14px; color: #374151;">
                  Your submission <strong>${prereq.mainSubmission.reference || prereq.mainSubmission.formName}</strong> was rejected because a required prerequisite form was declined.
                </p>
                <div style="background: #fef2f2; border-left: 4px solid #ef4444; border-radius: 4px; padding: 16px; margin: 16px 0;">
                  <p style="margin: 0; font-weight: 600; color: #991b1b;">Prerequisite Declined: ${prereq.targetForm?.name ?? (prereq.type === "CONTRACT" ? "Contract" : "Prerequisite")}</p>
                  <p style="margin: 4px 0 0; font-size: 13px; color: #b91c1c;">Declined by: ${email || prereq.targetEmail || "Unknown"}</p>
                  <p style="margin: 8px 0 0; font-size: 14px; color: #7f1d1d;"><strong>Reason:</strong> ${reason}</p>
                </div>
                <a href="${subUrl}" style="display: inline-block; background: #111827; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">View Submission</a>
              </div>
            `,
          }).catch((e: any) => console.error("[decline notify]", e));
        }
      }
    }

    res.json({ success: true, message: "Prerequisite declined." });
  } catch (error: any) {
    console.error("[prereq decline]", error);
    res.status(500).json({ success: false, error: "Failed to decline prerequisite.", code: "FAILED_TO_DECLINE_PREREQUISITE" });
  }
});

export default router;
