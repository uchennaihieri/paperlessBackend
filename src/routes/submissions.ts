import { Router, Response } from "express";
import fs from "fs/promises";
import path from "path";
import multer from "multer";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { hashToken, decrypt } from "../lib/crypto";
import { isSharePointEnabled, uploadToSharePoint } from "../lib/sharepoint";
import { mailer } from "../lib/mailer";
import { generateSubmissionPdf } from "../lib/pdfGenerator";
import { checkAndUnblockPrerequisites } from "./workflow";

// Files are always buffered in memory; they go straight to SharePoint (or disk)
// on submission — never stored in a temp location.
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB per file
});

// Sanitise a string for use as a SharePoint / filesystem folder segment.
// Removes characters that are invalid in folder names.
function sanitiseFolder(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase();
}


const router = Router();
router.use(authenticate as any);

// ── GET /api/v1/submissions ───────────────────────────────────────────────────
// Returns all submissions (admin / action-center view)
router.get("/", async (_req, res: Response) => {
  const submissions = await prisma.formSubmission.findMany({
    where: {
      status: { not: "Internal Attachment" }
    },
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
    where: { 
      submittedById: req.user.id,
      status: { not: "Internal Attachment" }
    },
    orderBy: { createdAt: "desc" },
    include: { 
      signatories: { orderBy: { position: "asc" } },
      template: { select: { mobileEnabled: true } }
    },
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

// ── GET /api/v1/submissions/by-reference/:ref ─────────────────────────────────
// Resolve a form reference code (e.g. "PCL001") to a full submission record.
// Used by the frontend to turn a "formreference" field value into a clickable link.
router.get("/by-reference/:ref", async (req, res: Response) => {
  const submission = await prisma.formSubmission.findUnique({
    where: { reference: req.params.ref },
    include: {
      signatories: { orderBy: { position: "asc" } },
      template:    true,
      submittedBy: { select: { user_name: true, finca_email: true, branch: true } },
    },
  });
  if (!submission) {
    res.status(404).json({ success: false, error: `No submission found with reference "${req.params.ref}"` });
    return;
  }
  res.json({ success: true, data: submission });
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
// Accepts multipart/form-data.
// Non-file fields go in the JSON string field called "data".
// File attachments use the form-field label as the multipart field name.
// Files are uploaded directly to SharePoint (or local disk) under:
//   uploads/{FORM NAME}/{REFERENCE}/{originalFilename}
// No files are stored unless the form is actually submitted.
router.post("/", memUpload.any(), async (req: AuthRequest, res: Response) => {
  // ── Parse the JSON payload sent in the "data" field ────────────────────────
  let payload: any = {};
  try {
    if (req.body?.data) {
      payload = JSON.parse(req.body.data);
    } else {
      // Fallback: plain JSON body (backward compat with JSON-only clients)
      payload = req.body;
    }
  } catch {
    res.status(400).json({ success: false, error: "Invalid submission data." });
    return;
  }

  const {
    templateId,
    formName,
    formResponses = {},
    signatories,
    signingType = "sequential",
    initiatorToken,
    draftId,
  } = payload;

  if (!templateId || !formName) {
    res.status(400).json({ success: false, error: "templateId and formName are required." });
    return;
  }

  // ── Initiator signature token (optional) ───────────────────────────────────
  let finalSignatureData: string | null = null;
  let finalSignatureStatus = "Pending";
  let finalSignedAt: Date | null = null;

  if (initiatorToken) {
    const userEmail = req.user?.email;
    if (!userEmail) { res.status(401).json({ success: false, error: "Not logged in" }); return; }
    const hashedInput = hashToken(initiatorToken);
    const secData = await prisma.securityData.findFirst({
      where: { userEmail: { equals: userEmail, mode: "insensitive" } },
    });
    if (!secData || secData.hashedToken !== hashedInput) {
      res.status(400).json({ success: false, error: "Invalid signature token." });
      return;
    }
    finalSignatureData = decrypt(secData.encryptedSignature);
    finalSignatureStatus = "Signed";
    finalSignedAt = new Date();
  }

  // ── Generate reference number (if not a draft) ──────────────────────────────
  let reference: string = "";
  if (!draftId) {
    try {
      const acronym = formName.split(" ").map((w: string) => w[0]).join("").toUpperCase();
      const latestSub = await prisma.formSubmission.findFirst({
        where: { templateId },
        orderBy: { createdAt: 'desc' },
        select: { reference: true }
      });
      
      let nextNumber = 1;
      if (latestSub && latestSub.reference) {
        const match = latestSub.reference.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0], 10) + 1;
        } else {
          const count = await prisma.formSubmission.count({ where: { templateId } });
          nextNumber = count + 1;
        }
      }
      reference = `${acronym}${nextNumber}`;
    } catch {
      reference = `REF-${Date.now()}`;
    }
  } else {
    // For a draft, fetch the existing reference so we can use it for folder paths
    const draft = await prisma.formSubmission.findUnique({ where: { id: draftId } });
    if (!draft) {
      res.status(404).json({ success: false, error: "Draft not found." });
      return;
    }
    reference = draft.reference ?? `REF-${Date.now()}`;
  }

  // ── Handle file attachments ────────────────────────────────────────────────
  // Files are uploaded NOW (at submission time) under a structured path:
  //   uploads/{FORM NAME}/{REFERENCE}/{originalFilename}
  const uploadedFiles = (req.files as Express.Multer.File[]) ?? [];
  const updatedResponses: Record<string, any> = { ...formResponses };
  
  const docCreates: Array<{
    fieldName: string;
    originalName: string;
    filePath: string;
    mimeType: string;
    size: number;
  }> = [];

  // ── Handle Internal Forms (Custom Forms as Attachments) ─────────────────────
  const formFolder = sanitiseFolder(formName);
  const refFolder  = sanitiseFolder(reference);
  const internalFormTasks: Array<{ fieldName: string, templateId: string, templateName: string, data: any }> = [];
  
  for (const [key, value] of Object.entries(updatedResponses)) {
    if (value && typeof value === "object" && value.type === "internal_form") {
      internalFormTasks.push({
        fieldName: key,
        templateId: value.templateId,
        templateName: value.templateName || "Internal Form",
        data: value.data
      });
      // Clear out the raw payload so we can replace it with the generated PDF attachment metadata later
      delete updatedResponses[key];
    }
  }

  const internalAttachments: Record<string, Array<{ isAttachment: true; name: string; url: string }>> = {};

  for (const task of internalFormTasks) {
    // 1. Create a Ghost Submission (auto-signed by the logged in user)
    const ghostSub = await prisma.formSubmission.create({
      data: {
        formName: task.templateName,
        status: "Internal Attachment",
        formResponses: task.data,
        signingType: "sequential",
        templateId: task.templateId,
        submittedById: req.user?.id ?? null,
        signatories: {
          create: [{
            position: 1,
            userName: req.user?.user_name || req.user?.email || "System User",
            email: req.user?.email || "system@internal",
            status: "Signed",
            signedAt: new Date(),
            signatureData: finalSignatureData,
          }]
        }
      }
    });

    // 2. Generate PDF
    const pdfResult = await generateSubmissionPdf(ghostSub.id);
    if (!pdfResult) continue;

    const originalFilename = pdfResult.filename;
    let storedPath: string;

    if (isSharePointEnabled()) {
      storedPath = await uploadToSharePoint(
        pdfResult.buffer,
        originalFilename,
        "application/pdf",
        `uploads/${formFolder}/${refFolder}`
      );
    } else {
      const uploadDir = process.env.UPLOAD_DIR ?? "C:\\Users\\USER\\uploads";
      const targetDir = path.join(uploadDir, formFolder, refFolder);
      await fs.mkdir(targetDir, { recursive: true });
      storedPath = path.join(targetDir, originalFilename);
      await fs.writeFile(storedPath, pdfResult.buffer);
    }

    docCreates.push({
      fieldName: task.fieldName,
      originalName: originalFilename,
      filePath: storedPath,
      mimeType: "application/pdf",
      size: pdfResult.buffer.length,
    });

    if (!internalAttachments[task.fieldName]) {
      internalAttachments[task.fieldName] = [];
    }
    internalAttachments[task.fieldName].push({ isAttachment: true, name: originalFilename, url: "__pending__" });
  }

  // Merge internal attachments back into updatedResponses
  for (const [fieldName, attachments] of Object.entries(internalAttachments)) {
    // Append to existing array if file upload and custom form were both used on the same field
    if (Array.isArray(updatedResponses[fieldName])) {
      updatedResponses[fieldName] = updatedResponses[fieldName].concat(attachments);
    } else {
      updatedResponses[fieldName] = attachments;
    }
  }

  if (uploadedFiles.length > 0) {
    const formFolder = sanitiseFolder(formName);   // e.g. "PETTY CASH LIVE"
    const refFolder  = sanitiseFolder(reference);  // e.g. "PCL1"

    // Group by fieldname so we can build the attachment array per field
    const byField: Record<string, Express.Multer.File[]> = {};
    for (const file of uploadedFiles) {
      if (!byField[file.fieldname]) byField[file.fieldname] = [];
      byField[file.fieldname].push(file);
    }

    for (const [fieldName, files] of Object.entries(byField)) {
      const attachments: Array<{ isAttachment: true; name: string; url: string }> = [];

      for (const file of files) {
        let storedPath: string;

        if (isSharePointEnabled()) {
          // SharePoint folder: uploads/PETTY CASH LIVE/PCL1
          const folder = `uploads/${formFolder}/${refFolder}`;
          storedPath = await uploadToSharePoint(
            file.buffer,
            file.originalname,
            file.mimetype || "application/octet-stream",
            folder
          );
        } else {
          // Local disk: {UPLOAD_DIR}/PETTY CASH LIVE/PCL1/file.pdf
          const uploadDir = process.env.UPLOAD_DIR ?? "C:\\Users\\USER\\uploads";
          const targetDir = path.join(uploadDir, formFolder, refFolder);
          await fs.mkdir(targetDir, { recursive: true });
          const destPath = path.join(targetDir, file.originalname);
          await fs.writeFile(destPath, file.buffer);
          storedPath = destPath;
        }

        // Queue the SubmissionDocument record (created after the submission row exists)
        docCreates.push({
          fieldName,
          originalName: file.originalname,
          filePath:     storedPath,
          mimeType:     file.mimetype || "application/octet-stream",
          size:         file.size,
        });

        // Placeholder URL — will be filled in after we have the document ID below
        attachments.push({ isAttachment: true, name: file.originalname, url: "__pending__" });
      }

      updatedResponses[fieldName] = attachments;
    }
  }

  // ── Create or Update the FormSubmission row ───────────────────────────────
  const sigsInput: Array<{ position: number; userName: string; email: string }> =
    signatories ?? [];

  // ── Determine initial status ──────────────────────────────────────────────
  const isFullySigned = sigsInput.length === 1 && finalSignatureStatus === "Signed";
  const initialStatus = isFullySigned ? "Processing" : "Submitted";

  let submission;

  if (draftId) {
    // Clear old signatories if any existed on the draft (though usually it's empty)
    await prisma.submissionSignatory.deleteMany({ where: { submissionId: draftId } });

    submission = await prisma.formSubmission.update({
      where: { id: draftId },
      data: {
        formResponses: updatedResponses,
        signingType,
        submittedById: req.user?.id ?? null,
        status: initialStatus, // Use dynamic initial status
        signatories: {
          create: sigsInput.map((s) => ({
            position:      s.position,
            userName:      s.userName,
            email:         s.email,
            status:        s.position === 1 && finalSignatureStatus === "Signed" ? "Signed" : "Pending",
            signatureData: s.position === 1 ? finalSignatureData : null,
            signedAt:      s.position === 1 && finalSignatureStatus === "Signed" ? finalSignedAt : null,
          })),
        },
      },
      include: { signatories: true },
    });

    // Also update any related prerequisite record to Submitted
    await prisma.submissionPrerequisite.updateMany({
      where: { prereqSubmissionId: draftId },
      data: { status: "Submitted" }
    });

  } else {
    submission = await prisma.formSubmission.create({
      data: {
        formName,
        reference,
        formResponses: updatedResponses,
        signingType,
        submittedById: req.user?.id ?? null,
        templateId,
        status: initialStatus, // Use dynamic initial status
        signatories: {
          create: sigsInput.map((s) => ({
            position:      s.position,
            userName:      s.userName,
            email:         s.email,
            status:        s.position === 1 && finalSignatureStatus === "Signed" ? "Signed" : "Pending",
            signatureData: s.position === 1 ? finalSignatureData : null,
            signedAt:      s.position === 1 && finalSignatureStatus === "Signed" ? finalSignedAt : null,
          })),
        },
      },
      include: { signatories: true },
    });
  }

  // ── Audit: record initial submission event ──
  prisma.formAuditTrail.create({
    data: {
      submissionId:  submission.id,
      formReference: submission.reference,
      prevStatus:    "",
      newStatus:     initialStatus,
      action:        "submitted",
      actorName:     req.user?.user_name ?? req.user?.email ?? null,
      actorEmail:    req.user?.email ?? null,
      note:          `Form: ${formName}`,
    },
  }).catch((e: any) => console.error("[audit] submit:", e));

  // ── Background: generate + store the PDF if fully signed at submission ──
  if (isFullySigned) {
    checkAndUnblockPrerequisites(submission.id);
    setImmediate(async () => {
      try {
        const pdfResult = await generateSubmissionPdf(submission.id);
        if (!pdfResult) return;

        const formFolder = submission.formName.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase();
        const refFolder  = submission.reference?.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase() || submission.id.slice(-6).toUpperCase();
        let storedPath = "";

        if (isSharePointEnabled()) {
          storedPath = await uploadToSharePoint(
            pdfResult.buffer, pdfResult.filename, "application/pdf",
            `uploads/${formFolder}/${refFolder}`
          );
        } else {
          const uploadDir = process.env.UPLOAD_DIR ?? "C:\\Users\\USER\\uploads";
          const targetDir = path.join(uploadDir, formFolder, refFolder);
          await fs.mkdir(targetDir, { recursive: true });
          const destPath = path.join(targetDir, pdfResult.filename);
          await fs.writeFile(destPath, pdfResult.buffer);
          storedPath = destPath;
        }

        if (storedPath) {
          const created = await prisma.submissionDocument.create({
            data: {
              submissionId: submission.id,
              fieldName:    "CompletedFormPDF",
              originalName: pdfResult.filename,
              filePath:     storedPath,
              mimeType:     "application/pdf",
              size:         pdfResult.buffer.length,
            },
          });

          const resData = (submission.formResponses as Record<string, any>) || {};
          resData["CompletedFormPDF"] = [
            { isAttachment: true, name: pdfResult.filename, url: `/api/v1/file?docId=${created.id}` },
          ];
          await prisma.formSubmission.update({
            where: { id: submission.id },
            data:  { formResponses: resData },
          });
          console.info(`[pdf] Generated and stored: ${pdfResult.filename}`);
        }
      } catch (err) {
        console.error("[pdf] Background generation failed:", err);
      }
    });
  }

  // ── Check for prerequisite fields ────────────────────────────────────────────
  // A field is a prerequisite if its JSON config has { isPrerequisite: true }.
  // The submitter fills in the email of the person who needs to complete the
  // prerequisite form. We auto-create a draft submission for that email and
  // block the main submission until all prerequisites are approved.
  setImmediate(async () => {
    try {
      const templateWithFields = await prisma.formTemplate.findUnique({
        where: { id: templateId },
        select: { fields: true },
      });
      if (!templateWithFields) return;

      const fields = templateWithFields.fields as any[];
      const prereqFields = fields.filter(
        (f: any) => f.isPrerequisite === true && f.targetFormTemplateId
      );
      if (prereqFields.length === 0) return;

      // For each prerequisite field, create a draft submission + SubmissionPrerequisite record
      let prereqCount = 0;
      for (const field of prereqFields) {
        const targetEmail = (formResponses[field.id] ?? formResponses[field.label] ?? "").trim();
        if (!targetEmail) continue;

        const targetTemplate = await prisma.formTemplate.findUnique({
          where: { id: field.targetFormTemplateId },
          select: { id: true, name: true, fields: true },
        });
        if (!targetTemplate) continue;

        // Generate a reference for the draft prerequisite submission (removed -PRE)
        const acronym = targetTemplate.name.split(" ").map((w: string) => w[0]).join("").toUpperCase();
        const latestPrereq = await prisma.formSubmission.findFirst({
          where: { templateId: targetTemplate.id },
          orderBy: { createdAt: 'desc' },
          select: { reference: true }
        });

        let nextNumber = 1;
        if (latestPrereq && latestPrereq.reference) {
          const match = latestPrereq.reference.match(/\d+$/);
          if (match) {
            nextNumber = parseInt(match[0], 10) + 1;
          } else {
            const count = await prisma.formSubmission.count({ where: { templateId: targetTemplate.id } });
            nextNumber = count + 1;
          }
        }
        const prereqRef = `${acronym}${nextNumber}`;

        // Auto-populate form reference if a field exists
        const targetFields: any[] = typeof targetTemplate.fields === "string" 
          ? JSON.parse(targetTemplate.fields) 
          : (targetTemplate.fields || []);
          
        const prefilledResponses: Record<string, any> = {};
        const refField = targetFields.find((f: any) => 
          f.type !== "section_header" && f.type !== "instructions" && f.label.toLowerCase().includes("form reference")
        );
        if (refField) {
          prefilledResponses[refField.id] = submission.reference;
        }

        const prereqSub = await prisma.formSubmission.create({
          data: {
            formName: targetTemplate.name,
            reference: prereqRef,
            formResponses: prefilledResponses,
            signingType: "sequential",
            status: "Draft",
            templateId: targetTemplate.id,
            submittedById: null,
          },
        });

        await prisma.submissionPrerequisite.create({
          data: {
            mainSubmissionId: submission.id,
            prereqSubmissionId: prereqSub.id,
            targetFormId: targetTemplate.id,
            targetEmail,
            status: "Pending",
          },
        });
        prereqCount++;

        // Notify the target email
        const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";
        const fillUrl = `${appUrl}/dashboard/forms/draft/${prereqSub.id}`;
        mailer.sendMail({
          from: `Paperless <${process.env.SMTP_USER ?? "noreply@paperless.ng"}>`,
          to: targetEmail,
          subject: `Action Required: Please complete the "${targetTemplate.name}" form`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
              <h2 style="color: #B50938; margin-bottom: 4px;">Paperless by FINCA</h2>
              <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
              <hr style="border-color: #e5e7eb; margin: 20px 0;" />
              <p style="font-size: 15px; color: #111827;">Hello,</p>
              <p style="font-size: 14px; color: #374151;">
                You have been requested to complete a prerequisite form before a submission can proceed for approval.
              </p>
              <div style="background: #f9fafb; border-left: 4px solid #B50938; border-radius: 4px; padding: 16px; margin: 16px 0;">
                <p style="margin: 0; font-weight: 600; color: #111827;">${targetTemplate.name}</p>
                <p style="margin: 4px 0 0; font-size: 13px; color: #6b7280;">Reference: ${prereqRef}</p>
              </div>
              <p style="font-size: 14px; color: #374151;">Please click the button below to open and complete your form. You may be asked to log in if you are a registered user.</p>
              <a href="${fillUrl}" style="display: inline-block; background: #B50938; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">Open & Complete Form</a>
              <p style="font-size: 12px; color: #9ca3af; margin-top: 24px;">If you believe this was sent in error, please contact your administrator.</p>
            </div>
          `,
        }).catch((e: any) => console.error("[prereq email]", e));
      }

      // Block the main submission if any prerequisites were created
      if (prereqCount > 0) {
        await prisma.formSubmission.update({
          where: { id: submission.id },
          data: { status: "Blocked - Awaiting Prerequisites" },
        });
      }
    } catch (err) {
      console.error("[prerequisites] Failed to set up prerequisite checks:", err);
    }
  });


  // ── Create SubmissionDocument records and patch formResponses URLs ─────────
  if (docCreates.length > 0) {
    const finalResponses = { ...updatedResponses };
    const fieldDocUrls: Record<string, string[]> = {};

    for (const doc of docCreates) {
      const created = await prisma.submissionDocument.create({
        data: { submissionId: submission.id, ...doc },
      });

      if (!fieldDocUrls[doc.fieldName]) fieldDocUrls[doc.fieldName] = [];
      fieldDocUrls[doc.fieldName].push(`/api/v1/file?docId=${created.id}`);
    }

    // Replace the __pending__ placeholder URLs with real docId-based URLs
    for (const [fieldName, urls] of Object.entries(fieldDocUrls)) {
      const existing = finalResponses[fieldName] as any[];
      finalResponses[fieldName] = existing.map((att: any, i: number) => ({
        ...att,
        url: urls[i] ?? att.url,
      }));
    }

    await prisma.formSubmission.update({
      where: { id: submission.id },
      data: { formResponses: finalResponses },
    });

    const full = await prisma.formSubmission.findUnique({
      where: { id: submission.id },
      include: { signatories: true, documents: true },
    });
    res.status(201).json({ success: true, data: full });
    return;
  }

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

// ── PUT /api/v1/submissions/:id ───────────────────────────────────────────────
// Owner can edit and resubmit their own form if status is Submitted or Rejected.
// Replaces formResponses and signatories entirely, resets status to "Submitted".
const EDITABLE_STATUSES = ["Submitted", "Rejected"];

router.put("/:id", async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ success: false, error: "Unauthenticated" }); return; }

  const existing = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    include: { signatories: true },
  });

  if (!existing) { res.status(404).json({ success: false, error: "Submission not found" }); return; }

  // Ownership check — only the original submitter may edit
  if (existing.submittedById !== userId) {
    res.status(403).json({ success: false, error: "You do not have permission to edit this submission" });
    return;
  }

  // Status guard — only editable when Submitted or Rejected
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    res.status(400).json({
      success: false,
      error: `This submission cannot be edited because its status is "${existing.status}". Only Submitted or Rejected forms can be edited.`,
    });
    return;
  }

  const { formResponses, signatories, signingType } = req.body;

  if (!formResponses) {
    res.status(400).json({ success: false, error: "formResponses is required" });
    return;
  }

  const sigsInput: Array<{ position: number; userName: string; email: string }> =
    signatories ?? existing.signatories.map((s) => ({
      position: s.position,
      userName: s.userName,
      email: s.email,
    }));

  // Atomically: delete old signatories → update submission → create new signatories
  await prisma.$transaction([
    prisma.submissionSignatory.deleteMany({ where: { submissionId: req.params.id } }),
    prisma.formSubmission.update({
      where: { id: req.params.id },
      data: {
        formResponses,
        signingType: signingType ?? existing.signingType,
        status: "Submitted",
        treatedBy: null,
        approvedBy: null,
        approverEmail: null,
      },
    }),
  ]);

  // Re-create signatories after the update
  if (sigsInput.length > 0) {
    await prisma.submissionSignatory.createMany({
      data: sigsInput.map((s) => ({
        submissionId: req.params.id,
        position: s.position,
        userName: s.userName,
        email: s.email,
        status: "Pending",
      })),
    });
  }

  const updated = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    include: { signatories: { orderBy: { position: "asc" } } },
  });

  res.json({ success: true, data: updated });
});

// ── DELETE /api/v1/submissions/:id ────────────────────────────────────────────
// Owner can delete their own form if status is Submitted or Rejected.
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ success: false, error: "Unauthenticated" }); return; }

  const existing = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
  });

  if (!existing) { res.status(404).json({ success: false, error: "Submission not found" }); return; }

  // Ownership check
  if (existing.submittedById !== userId) {
    res.status(403).json({ success: false, error: "You do not have permission to delete this submission" });
    return;
  }

  // Status guard
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    res.status(400).json({
      success: false,
      error: `This submission cannot be deleted because its status is "${existing.status}". Only Submitted or Rejected forms can be deleted.`,
    });
    return;
  }

  await prisma.formSubmission.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

export default router;
