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
    res.status(404).json({ success: false, error: "Prerequisite not found." });
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
    res.status(404).json({ success: false, error: "Prerequisite not found." });
    return;
  }

  if (prereq.status !== "Pending") {
    res.status(400).json({ success: false, error: "Can only remind pending prerequisites." });
    return;
  }

  if (!prereq.prereqSubmission) {
    res.status(400).json({ success: false, error: "Prerequisite draft missing." });
    return;
  }

  try {
    const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";
    const fillUrl = `${appUrl}/dashboard/forms/draft/${prereq.prereqSubmission.id}`;
    
    await mailer.sendMail({
      from: `Paperless <${process.env.SMTP_USER ?? "noreply@paperless.ng"}>`,
      to: prereq.targetEmail,
      subject: `Reminder: Please complete the "${prereq.targetForm.name}" form`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #B50938; margin-bottom: 4px;">Paperless by FINCA</h2>
          <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
          <hr style="border-color: #e5e7eb; margin: 20px 0;" />
          <p style="font-size: 15px; color: #111827;">Hello,</p>
          <p style="font-size: 14px; color: #374151;">
            This is a reminder that you have been requested to complete a prerequisite form before a submission can proceed for approval.
          </p>
          <div style="background: #f9fafb; border-left: 4px solid #B50938; border-radius: 4px; padding: 16px; margin: 16px 0;">
            <p style="margin: 0; font-weight: 600; color: #111827;">${prereq.targetForm.name}</p>
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
    res.status(500).json({ success: false, error: "Failed to send reminder email." });
  }
});

export default router;
