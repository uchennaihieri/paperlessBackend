import { Router, Response } from "express";
import fs from "fs/promises";
import path from "path";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { hashToken, decrypt } from "../lib/crypto";

const router = Router();
router.use(authenticate as any);

// ── GET /api/v1/submissions ───────────────────────────────────────────────────
// Returns all submissions (admin / action-center view)
router.get("/", async (_req, res: Response) => {
  const submissions = await prisma.formSubmission.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      signatories: { orderBy: { position: "asc" } },
      submittedBy: { select: { user_name: true, finca_email: true, branch: true } },
    },
  });
  res.json({ success: true, data: submissions });
});

// ── GET /api/v1/submissions/my ────────────────────────────────────────────────
// Submissions made by the authenticated user
router.get("/my", async (req: AuthRequest, res: Response) => {
  if (!req.user?.id) { res.status(401).json({ success: false, error: "Unauthenticated" }); return; }
  const submissions = await prisma.formSubmission.findMany({
    where: { submittedById: req.user.id },
    orderBy: { createdAt: "desc" },
    include: { signatories: { orderBy: { position: "asc" } } },
  });
  res.json({ success: true, data: submissions });
});

// ── GET /api/v1/submissions/action-items ─────────────────────────────────────
// Items in the Action Center for the user's branch (as formTreater)
router.get("/action-items", async (req: AuthRequest, res: Response) => {
  const userBranch = req.user?.branch ?? null;
  if (!userBranch) { res.json({ success: true, data: [] }); return; }

  const items = await prisma.formSubmission.findMany({
    where: {
      OR: [
        { status: { in: ["Processing", "Filed"] } },
        { status: { startsWith: "Assigned" } },
      ],
      template: { formTreater: { equals: userBranch, mode: "insensitive" } },
    },
    include: {
      template: { select: { name: true, formOwner: true, formTreater: true } },
      signatories: { orderBy: { position: "asc" } },
      submittedBy: { select: { user_name: true, finca_email: true, branch: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json({ success: true, data: items });
});

// ── GET /api/v1/submissions/:id ───────────────────────────────────────────────
router.get("/:id", async (req, res: Response) => {
  const submission = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    include: {
      signatories: { orderBy: { position: "asc" } },
      template: true,
      submittedBy: { select: { user_name: true, finca_email: true, branch: true } },
    },
  });
  if (!submission) { res.status(404).json({ success: false, error: "Submission not found" }); return; }
  res.json({ success: true, data: submission });
});

// ── POST /api/v1/submissions ──────────────────────────────────────────────────
router.post("/", async (req: AuthRequest, res: Response) => {
  const {
    templateId,
    formName,
    formResponses,
    signatories,
    signingType = "sequential",
    initiatorToken,
  } = req.body;

  let finalSignatureData: string | null = null;
  let finalSignatureStatus = "Pending";
  let finalSignedAt: Date | null = null;

  // Optionally sign as the initiator using their registered token
  if (initiatorToken) {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, error: "Not logged in" }); return; }

    const hashedInput = hashToken(initiatorToken);
    const secData = await prisma.securityData.findUnique({ where: { userId } });
    if (!secData || secData.hashedToken !== hashedInput) {
      res.status(400).json({ success: false, error: "Invalid signature token." });
      return;
    }
    finalSignatureData = decrypt(secData.encryptedSignature);
    finalSignatureStatus = "Signed";
    finalSignedAt = new Date();
  }

  // Generate reference number
  let reference: string;
  try {
    const acronym = formName.split(" ").map((w: string) => w[0]).join("").toUpperCase();
    const count = await prisma.formSubmission.count({ where: { templateId } });
    reference = `${acronym}${count + 1}`;
  } catch {
    reference = `REF-${Date.now()}`;
  }

  // Move uploaded files into a permanent folder keyed by form/reference
  const extractedNames: string[] = [];
  Object.values(formResponses).forEach((val) => {
    if (typeof val === "string") {
      extractedNames.push(...(val as string).split(", ").map((s) => s.trim()));
    }
  });

  const fileRecords = await prisma.uploadedFile.findMany({
    where: { fileName: { in: extractedNames } },
  });

  let updatedResponses = { ...formResponses };

  if (fileRecords.length > 0) {
    const uploadDir = process.env.UPLOAD_DIR ?? "C:\\Users\\USER\\uploads";
    const targetDir = path.join(uploadDir, formName, reference);
    await fs.mkdir(targetDir, { recursive: true });

    for (const record of fileRecords) {
      const newFilePath = path.join(targetDir, record.fileName);
      try {
        await fs.rename(record.filePath, newFilePath);
        await prisma.uploadedFile.update({ where: { id: record.id }, data: { filePath: newFilePath } });
      } catch (e) {
        console.error("Failed to move file", record.filePath, e);
      }
    }

    for (const [key, val] of Object.entries(updatedResponses)) {
      if (typeof val === "string") {
        const parts = (val as string).split(", ").map((s: string) => s.trim());
        const matching = fileRecords.filter((r: any) => parts.includes(r.fileName));
        if (matching.length > 0) {
          updatedResponses[key] = matching.map((r: any) => ({
            isAttachment: true,
            name: r.originalName,
            url: `/api/v1/file?id=${r.id}`,
          }));
        }
      }
    }
  }

  const sigsInput: Array<{ position: number; userName: string; email: string }> =
    signatories ?? [];

  const submission = await prisma.formSubmission.create({
    data: {
      formName,
      reference,
      formResponses: updatedResponses,
      signingType,
      submittedById: req.user?.id ?? null,
      templateId,
      signatories: {
        create: sigsInput.map((s) => ({
          position: s.position,
          userName: s.userName,
          email: s.email,
          status: s.position === 1 && finalSignatureStatus === "Signed" ? "Signed" : "Pending",
          signatureData: s.position === 1 ? finalSignatureData : null,
          signedAt: s.position === 1 && finalSignatureStatus === "Signed" ? finalSignedAt : null,
        })),
      },
    },
    include: { signatories: true },
  });

  res.status(201).json({ success: true, data: submission });
});

// ── POST /api/v1/submissions/:id/file-attachments ────────────────────────────
// Mark a submission as Filed and save a local copy of the data
router.post("/:id/file-attachments", async (req, res: Response) => {
  const submission = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    include: { template: true },
  });
  if (!submission) { res.status(404).json({ success: false, error: "Submission not found" }); return; }

  const folderPath = path.join(process.cwd(), "filed_attachments", req.params.id);
  await fs.mkdir(folderPath, { recursive: true });

  const content = `Form: ${submission.formName}\nDate: ${submission.createdAt}\n\nResponses:\n${JSON.stringify(submission.formResponses, null, 2)}`;
  await fs.writeFile(path.join(folderPath, "form_data_and_attachments.txt"), content);

  await prisma.formSubmission.update({ where: { id: req.params.id }, data: { status: "Filed" } });
  res.json({ success: true });
});

export default router;
