import { Router, Request, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { hashToken, decrypt } from "../lib/crypto";

const router = Router();
router.use(authenticate as any);

// ── POST /api/v1/mobile_submit ────────────────────────────────────────────────
// Mobile-friendly unified submission endpoint.
// Auto-creates or finds the FormTemplate by formName so the mobile app does
// not need to pass a templateId.
// Accepts:
//   { formName, formResponses, signatories, signingType?, initiatorToken }
router.post("/", async (req: AuthRequest, res: Response) => {
  const {
    formName,
    formResponses = {},
    signatories = [],
    signingType = "sequential",
    initiatorToken,
  } = req.body;

  if (!formName) {
    res.status(400).json({ success: false, error: "formName is required." });
    return;
  }
  if (!signatories || signatories.length === 0) {
    res.status(400).json({ success: false, error: "At least one signatory is required." });
    return;
  }
  if (!initiatorToken) {
    res.status(400).json({ success: false, error: "initiatorToken is required." });
    return;
  }

  // ── Verify the initiator's security token ─────────────────────────────────
  const userEmail = req.user?.email;
  if (!userEmail) {
    res.status(401).json({ success: false, error: "Not authenticated." });
    return;
  }

  const hashedInput = hashToken(initiatorToken);
  const secData = await prisma.securityData.findFirst({
    where: { userEmail: { equals: userEmail, mode: "insensitive" } },
  });

  if (!secData) {
    res.status(404).json({
      success: false,
      error: "No security token registered for your account. Please set one up via the web portal.",
    });
    return;
  }
  if (secData.hashedToken !== hashedInput) {
    res.status(400).json({ success: false, error: "Invalid signature token." });
    return;
  }

  const initiatorSignatureData = decrypt(secData.encryptedSignature);

  // ── Auto-create or find the FormTemplate ──────────────────────────────────
  let template = await prisma.formTemplate.findFirst({ where: { name: formName } });
  if (!template) {
    // Generate fields from the keys of formResponses
    const generatedFields = Object.keys(formResponses).map((key) => {
      const val = formResponses[key];
      let type = "text";
      if (typeof val === "number") type = "number";
      // To create a human readable label, capitalize and add spaces before camel case
      const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');
      
      return {
        id: key,
        label: label,
        type: type,
        required: false,
      };
    });

    template = await prisma.formTemplate.create({
      data: {
        name: formName,
        fields: generatedFields,
        description: `Auto-generated template for mobile submission: ${formName}`,
        formOwner: "Mobile",
        formTreater: "Operations",
      },
    });
  }

  // ── Generate reference number ─────────────────────────────────────────────
  let reference: string;
  try {
    const acronym = formName.split(" ").map((w: string) => w[0]).join("").toUpperCase();
    const count = await prisma.formSubmission.count({ where: { templateId: template.id } });
    reference = `${acronym}${String(count + 1).padStart(4, "0")}`;
  } catch {
    reference = `REF-${Date.now()}`;
  }

  // ── Build signatory rows ───────────────────────────────────────────────────
  // Position-1 signatory is the initiator → stamp their signature immediately.
  const sigsInput: Array<{ position: number; userName: string; email: string }> = signatories;

  const submission = await prisma.formSubmission.create({
    data: {
      formName,
      reference,
      formResponses,
      signingType,
      status: "Submitted",
      submittedById: req.user?.id ?? null,
      templateId: template.id,
      signatories: {
        create: sigsInput.map((s) => ({
          position: s.position,
          userName: s.userName,
          email: s.email,
          status: s.position === 1 ? "Signed" : "Pending",
          signatureData: s.position === 1 ? initiatorSignatureData : null,
          signedAt: s.position === 1 ? new Date() : null,
        })),
      },
    },
    include: { signatories: true },
  });

  // ── Audit log ─────────────────────────────────────────────────────────────
  prisma.formAuditTrail.create({
    data: {
      submissionId: submission.id,
      formReference: submission.reference,
      prevStatus: "",
      newStatus: "Submitted",
      action: "submitted",
      actorName: req.user?.user_name ?? req.user?.email ?? null,
      actorEmail: req.user?.email ?? null,
      note: `Mobile submission: ${formName}`,
    },
  }).catch((e: any) => console.error("[audit] mobile_submit:", e));

  res.status(201).json({ success: true, submission });
});

export default router;
