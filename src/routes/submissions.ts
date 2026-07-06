import { Router, Response } from "express";
import fs from "fs/promises";
import path from "path";
import multer from "multer";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { hashToken, decrypt } from "../lib/crypto";
import { isSharePointEnabled, uploadToSharePoint, downloadFromSharePoint } from "../lib/sharepoint";
import { mailer } from "../lib/mailer";
import { checkAndUnblockPrerequisites, notifyActiveSignatories, notifySuccessfulCompletion, notifySubmitterOfSubmission } from "./workflow";

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
      status: { notIn: ["Internal Attachment", "Not Approved", "Deleted"] }
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
  if (!req.user?.id) { res.status(401).json({ success: false, error: "Unauthenticated", code: "UNAUTHENTICATED" }); return; }
  const submissions = await prisma.formSubmission.findMany({
    where: {
      submittedById: req.user.id,
      status: { notIn: ["Internal Attachment", "Not Approved", "Deleted", "Completed"] }
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

  // ── Lazy revert: if a form has been "Assigned" for over 1 hour without being
  // completed, automatically push it back to "Processing" so it becomes
  // available to any branch officer again.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const stale = await prisma.formSubmission.findMany({
    where: {
      status: { startsWith: "Assigned" },
      updatedAt: { lt: oneHourAgo },
      template: { formTreater: { equals: userBranch, mode: "insensitive" } },
    },
    select: { id: true, status: true, reference: true, treatedBy: true, treaterEmail: true },
  });

  if (stale.length > 0) {
    const staleIds = stale.map((s) => s.id);
    const staleRefs = stale.map((s) => s.reference).filter(Boolean) as string[];

    await prisma.formSubmission.updateMany({
      where: { id: { in: staleIds } },
      data: { status: "Processing", treatedBy: null, treaterEmail: null },
    });

    // Uncommit any journal entries for these forms so they return to pending
    if (staleRefs.length > 0) {
      await prisma.journalEntry.updateMany({
        where: { sessionRef: { in: staleRefs }, committed: true },
        data: { committed: false },
      });
    }

    // Log an audit entry for each reverted submission
    await prisma.formAuditTrail.createMany({
      data: stale.map((s) => ({
        submissionId: s.id,
        formReference: s.reference ?? null,
        prevStatus: s.status,
        newStatus: "Processing",
        action: "auto_unassigned",
        actorName: "System",
        actorEmail: null,
        note: `Assignment by ${s.treatedBy ?? "unknown"} expired after 1 hour — returned to Processing. Journal entries uncommitted.`,
      })),
    });
  }

  // Fetch active delegations for the current user
  const activeDelegations = await prisma.userDelegation.findMany({
    where: { delegateUserId: Number(req.user?.id), status: "Active" },
    include: { originalUser: true }
  });

  const branchRoleConditions: any[] = [];

  // 1. Current user's branch/role
  branchRoleConditions.push({
    AND: [
      { template: { formTreater: { equals: userBranch, mode: "insensitive" as const } } },
      {
        OR: [
          { template: { formTreaterRole: null } },
          { template: { formTreaterRole: "" } },
          { template: { formTreaterRole: { equals: req.user?.user_role, mode: "insensitive" as const } } }
        ]
      }
    ]
  });

  // 2. Delegatees' branch/role
  for (const del of activeDelegations) {
    if (del.originalUser.branch) {
      branchRoleConditions.push({
        AND: [
          { template: { formTreater: { equals: del.originalUser.branch, mode: "insensitive" as const } } },
          {
            OR: [
              { template: { formTreaterRole: null } },
              { template: { formTreaterRole: "" } },
              { template: { formTreaterRole: { equals: del.originalUser.user_role, mode: "insensitive" as const } } }
            ]
          }
        ]
      });
    }
  }

  const items = await prisma.formSubmission.findMany({
    where: {
      AND: [
        {
          OR: [
            { status: { in: ["Processing", "Filed"] } },
            { status: { startsWith: "Assigned" } },
          ],
        },
        {
          OR: branchRoleConditions
        }
      ]
    },
    include: {
      template: { select: { name: true, formOwner: true, formTreater: true, fields: true } },
      signatories: { orderBy: { position: "asc" } },
      submittedBy: { select: { user_name: true, finca_email: true, branch: true } },
      documents: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const refs = items.map((i) => i.reference || i.id);
  const committedEntries = await prisma.journalEntry.findMany({
    where: { sessionRef: { in: refs }, committed: true },
    select: { sessionRef: true },
    distinct: ["sessionRef"],
  });
  const committedRefs = new Set(committedEntries.map((e) => e.sessionRef));

  const itemsWithFlag = items.map((item) => ({
    ...item,
    hasCommittedJournal: committedRefs.has(item.reference || item.id),
  }));

  res.json({ success: true, data: itemsWithFlag });
});

// ── GET /api/v1/submissions/filings ───────────────────────────────────────────
// Returns completed submissions where template.formOwner matches the user's branch
router.get("/filings", async (req: AuthRequest, res: Response) => {
  const userBranch = req.user?.branch ?? null;
  if (!userBranch) {
    res.json({ success: true, data: [] });
    return;
  }

  try {
    const submissions = await prisma.formSubmission.findMany({
      where: {
        status: "Completed",
        OR: [
          { template: { formOwner: { equals: userBranch, mode: "insensitive" } } },
          {
            AND: [
              {
                OR: [
                  { template: { formOwner: null } },
                  { template: { formOwner: "" } }
                ]
              },
              {
                OR: [
                  { formResponses: { path: ['Branch'], equals: userBranch } },
                  { formResponses: { path: ['branch'], equals: userBranch } }
                ]
              }
            ]
          }
        ]
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        formName: true,
        reference: true,
        alias: true,
        status: true,
        treatedBy: true,
        createdAt: true,
        updatedAt: true,
        formResponses: true,
        template: { select: { name: true, formOwner: true } },
        publicSubmitterName: true,
        publicSubmitterEmail: true,
        submittedBy: { select: { user_name: true, finca_email: true, branch: true } },
      }
    });

    // Only include formResponses for forms categorized as "general" or if they contain a branch field
    // to save payload size
    const filteredSubmissions = submissions.map((sub: any) => {
      const isGeneral = sub.formName?.toLowerCase().includes("general");
      const hasBranchField = sub.formResponses && Object.keys(sub.formResponses).some(k => k.toLowerCase() === 'branch');
      if (!isGeneral && !hasBranchField) {
        delete sub.formResponses;
      }
      return sub;
    });

    res.json({ success: true, data: filteredSubmissions });
  } catch (err: any) {
    console.error("Error fetching filings:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to fetch filings", code: "INTERNALSERVERERROR" });
  }
});

// ── PUT /api/v1/submissions/:id/alias ──────────────────────────────────────────
// Update the alias for a completed submission
router.put("/:id/alias", async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { alias } = req.body;

  try {
    const submission = await prisma.formSubmission.findUnique({
      where: { id },
      include: { template: true },
    });

    if (!submission) {
      res.status(404).json({ success: false, error: "Submission not found", code: "SUBMISSION_NOT_FOUND" });
      return;
    }

    // Verify authorization: only users belonging to the branch that owns the form can edit its alias
    const userBranch = req.user?.branch ?? null;
    const formOwner = submission.template?.formOwner;

    // Check if the user is authorized to manage this filing
    if (!userBranch || !formOwner || userBranch.toLowerCase() !== formOwner.toLowerCase()) {
      res.status(403).json({ success: false, error: "Unauthorized to modify this filing's alias", code: "UNAUTHORIZED_TO_MODIFY_THIS_FI" });
      return;
    }

    const updated = await prisma.formSubmission.update({
      where: { id },
      data: { alias: alias ? alias.trim() : null },
    });

    res.json({ success: true, data: updated });
  } catch (err: any) {
    console.error("Error updating filing alias:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to update alias", code: "INTERNALSERVERERROR" });
  }
});

// ── GET /api/v1/submissions/prefill-candidates/:templateId ────────────────────
// Returns lightweight submission records for a given template, suitable for the
// "Prefill from previous" dropdown on the form filler page.
router.get("/prefill-candidates/:templateId", async (req, res: Response) => {
  try {
    const submissions = await prisma.formSubmission.findMany({
      where: {
        templateId: req.params.templateId,
        status: { notIn: ["Draft", "Internal Attachment", "Deleted", "Not Approved"] },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        reference: true,
        formName: true,
        createdAt: true,
        submittedBy: { select: { user_name: true } },
      },
    });
    res.json({ success: true, data: submissions });
  } catch (err: any) {
    console.error("Error fetching prefill candidates:", err);
    res.status(500).json({ success: false, error: err.message || "Failed to fetch prefill candidates", code: "INTERNALSERVERERROR" });
  }
});

// ── GET /api/v1/submissions/by-reference/:ref ─────────────────────────────────
// Resolve a form reference code (e.g. "PCL001") to a full submission record.
// Used by the frontend to turn a "formreference" field value into a clickable link.
router.get("/by-reference/:ref", async (req, res: Response) => {
  const submission = await prisma.formSubmission.findUnique({
    where: { reference: req.params.ref },
    include: {
      signatories: { orderBy: { position: "asc" } },
      template: true,
      submittedBy: { select: { user_name: true, finca_email: true, branch: true } },
      documents: true,
    },
  });
  if (!submission) {
    res.status(404).json({ success: false, error: `No submission found with reference "${req.params.ref}"`, code: "NO_SUBMISSION_FOUND_WITH_REFER" });
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
      documents: true,
      contractRequests: true,
    },
  });
  if (!submission) { res.status(404).json({ success: false, error: "Submission not found", code: "SUBMISSION_NOT_FOUND" }); return; }
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
    res.status(400).json({ success: false, error: "Invalid submission data.", code: "INVALID_SUBMISSION_DATA" });
    return;
  }

  let {
    templateId,
    formName,
    formResponses = {},
    signatories,
    signingType = "sequential",
    initiatorToken,
    initiatorSignature,
    tempPdfId,
    initiatorAnnotations,
    draftId,
    requestToken,
  } = payload;

  if (!templateId || !formName) {
    res.status(400).json({ success: false, error: "templateId and formName are required.", code: "TEMPLATEID_AND_FORMNAME_ARE_RE" });
    return;
  }

  // ── Fetch Template and Check for Signable Document ─────────────────────────
  const template = await prisma.formTemplate.findUnique({ where: { id: templateId } });
  const templateFields: any[] = typeof template?.fields === "string"
    ? JSON.parse(template.fields) : (template?.fields ?? []);

  // Force hidden fields to their default values (security layer)
  for (const field of templateFields) {
    if (field.isHidden && field.defaultValue !== undefined) {
      formResponses[field.label] = field.defaultValue;
    }
  }

  // ── Cross-form Data Referencing for Prerequisites ──────────────────────────
  if (draftId) {
    let mainSubmissionId: string | null = null;
    let fetchedMainSubmission: any = null;
    let fetchedPrereqs: any[] | null = null;

    for (const field of templateFields) {
      if (field.description) {
        const match = field.description.match(/View Referenced "(MainForm|Prerequisite\.\d+)\.(.+?)"/i);
        if (match) {
          const targetType = match[1]; // e.g. "MainForm" or "Prerequisite.1"
          const targetLabel = match[2];

          // Lazy load the prerequisite root context
          if (mainSubmissionId === null) {
            const selfPrereq = await prisma.submissionPrerequisite.findUnique({
              where: { prereqSubmissionId: draftId }
            });
            if (selfPrereq) {
              mainSubmissionId = selfPrereq.mainSubmissionId;
            } else {
              mainSubmissionId = "NONE"; // Mark to avoid re-querying
            }
          }

          if (mainSubmissionId && mainSubmissionId !== "NONE") {
            let targetFormResponses: any = null;

            if (targetType.toLowerCase() === "mainform") {
              if (!fetchedMainSubmission) {
                fetchedMainSubmission = await prisma.formSubmission.findUnique({
                  where: { id: mainSubmissionId }
                });
              }
              if (fetchedMainSubmission) {
                targetFormResponses = typeof fetchedMainSubmission.formResponses === "string" 
                  ? JSON.parse(fetchedMainSubmission.formResponses) 
                  : fetchedMainSubmission.formResponses;
              }
            } else {
              const orderMatch = targetType.match(/Prerequisite\.(\d+)/i);
              if (orderMatch) {
                const targetOrder = parseInt(orderMatch[1], 10);
                if (!fetchedPrereqs) {
                  fetchedPrereqs = await prisma.submissionPrerequisite.findMany({
                    where: { mainSubmissionId },
                    include: { prereqSubmission: true }
                  });
                }
                const targetPrereq = fetchedPrereqs.find(p => p.order === targetOrder);
                if (targetPrereq && targetPrereq.prereqSubmission) {
                  targetFormResponses = typeof targetPrereq.prereqSubmission.formResponses === "string"
                    ? JSON.parse(targetPrereq.prereqSubmission.formResponses)
                    : targetPrereq.prereqSubmission.formResponses;
                }
              }
            }

            // If we successfully found the value, inject it
            if (targetFormResponses && targetFormResponses[targetLabel] !== undefined) {
              formResponses[field.label] = targetFormResponses[targetLabel];
            }
          }
        }
      }
    }
  }
  
  let hasSignableDocument = false;
  let signableDocumentFieldLabel = "";
  let initiatorNeedsToSign = false;
  const generatedContractFields: any[] = [];
  
  for (const field of templateFields) {
    if (field.type === "signable_document" || field.type === "generated_contract") {
      hasSignableDocument = true;
      if (field.type === "signable_document") {
        signableDocumentFieldLabel = field.label;
      }
      if (field.type === "generated_contract") {
        generatedContractFields.push(field);
      }
      if (field.initiatorNeedsToSign) {
        initiatorNeedsToSign = true;
      }
      signingType = "sequential"; // Force sequential signing for free-form PDF signing
    }
  }

  // ── Initiator signature token (optional) ───────────────────────────────────
  let finalSignatureData: string | null = null;
  let finalSignatureStatus = "Pending";
  let finalSignedAt: Date | null = null;

  if (initiatorSignature) {
    // If the frontend already verified the token or used draw/upload and provides a direct base64 string
    const userEmail = req.user?.email;
    if (!userEmail) { res.status(401).json({ success: false, error: "Not logged in", code: "NOT_LOGGED_IN" }); return; }
    finalSignatureData = initiatorSignature;
    finalSignatureStatus = "Signed";
    finalSignedAt = new Date();
  } else if (initiatorToken) {
    const userEmail = req.user?.email;
    if (!userEmail) { res.status(401).json({ success: false, error: "Not logged in", code: "NOT_LOGGED_IN" }); return; }
    const hashedInput = hashToken(initiatorToken);
    const secData = await prisma.securityData.findFirst({
      where: { userEmail: { equals: userEmail, mode: "insensitive" } },
    });
    if (!secData || secData.hashedToken !== hashedInput) {
      res.status(400).json({ success: false, error: "Invalid signature token.", code: "INVALID_SIGNATURE_TOKEN" });
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
      res.status(404).json({ success: false, error: "Draft not found.", code: "DRAFT_NOT_FOUND" });
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

  const internalAttachments: Record<string, Array<{ isAttachment: true; name: string; url: string }>> = {};

  const formFolder = sanitiseFolder(formName);
  const refFolder = sanitiseFolder(reference);

  // ── Resolve Extended Service Reference fields ──────────────────────────────
  try {
    for (const field of templateFields) {
      if ((field as any).type !== "extended_service") continue;
      const service: string = (field as any).extendedService ?? "";
      const ref: string = (updatedResponses[field.label] ?? "").toString().trim();
      if (!ref) continue;

      let originalFilename = "";
      let pdfPath: string | null = null;

      if (service === "firstcentral" || service === "creditregistry") {
        const log = await prisma.creditBureauLog.findFirst({
          where: { reference: ref, bureau: service },
          select: { pdfPath: true },
        });
        if (log?.pdfPath) {
          pdfPath = log.pdfPath;
          originalFilename = `${ref}-${service.toUpperCase()}-Report.pdf`;
        }
      } else if (service === "nin" || service === "bvn") {
        const log = await prisma.identityVerificationLog.findFirst({
          where: { reference: ref, idType: service as any },
          select: { pdfPath: true },
        });
        if (log?.pdfPath) {
          pdfPath = log.pdfPath;
          originalFilename = `${ref}-${service.toUpperCase()}-Report.pdf`;
        }
      }

      if (pdfPath) {
        let buf: Buffer;
        const { buffer } = await downloadFromSharePoint(pdfPath);
        buf = buffer;

        const folder = process.env.SHAREPOINT_UPLOAD_FOLDER
          ? `${process.env.SHAREPOINT_UPLOAD_FOLDER}/${formFolder}/${refFolder}`
          : `${formFolder}/${refFolder}`;

        const storedPath = await uploadToSharePoint(
          buf, originalFilename, "application/pdf", folder
        );

        docCreates.push({
          fieldName: field.label,
          originalName: originalFilename,
          filePath: storedPath,
          mimeType: "application/pdf",
          size: buf.length,
        });

        if (!internalAttachments[field.label]) internalAttachments[field.label] = [];
        internalAttachments[field.label].push({ isAttachment: true, name: originalFilename, url: "__pending__" });
      }
    }
  } catch (e) {
    console.error("[extended_service] Reference resolution failed:", e);
  }

  // ── Resolve Event Selectors ────────────────────────────────────────────────
  try {
    for (const field of templateFields) {
      if ((field as any).type !== "event_selector") continue;
      // Depending on how formData is keyed (id or label)
      const responseKey = updatedResponses[field.id] !== undefined ? field.id : field.label;
      const eventId: string = (updatedResponses[responseKey] ?? "").toString().trim();
      if (!eventId) continue;

      const event = await prisma.event.findUnique({
        where: { id: eventId },
        include: { facilitators: true }
      });
      if (event) {
        // Replace the raw ID with a human-readable name for display/PDF
        updatedResponses[responseKey] = `${event.name} (${event.reference})`;
        // Also keep the raw ID so it can be queried robustly
        updatedResponses[`${responseKey}_id`] = event.id;
      }
    }
  } catch (e) {
    console.error("[event_selector] Event resolution failed:", e);
  }

  // ── Handle Internal Forms (Custom Forms as Attachments) ─────────────────────
  const internalFormTasks: Array<{ fieldName: string, templateId: string, templateName: string, data: any }> = [];

  for (const [key, value] of Object.entries(updatedResponses)) {
    if (value && typeof value === "object") {
      if (!Array.isArray(value) && (value as any).type === "internal_form") {
        internalFormTasks.push({
          fieldName: key,
          templateId: (value as any).templateId,
          templateName: (value as any).templateName || "Internal Form",
          data: (value as any).data
        });
        delete updatedResponses[key];
      } else if (Array.isArray(value)) {
        const internalForms = value.filter(v => v && typeof v === "object" && v.type === "internal_form");
        for (const form of internalForms) {
          internalFormTasks.push({
            fieldName: key,
            templateId: form.templateId,
            templateName: form.templateName || "Internal Form",
            data: form.data
          });
        }
        if (internalForms.length > 0) {
          delete updatedResponses[key];
        }
      }
    }
  }

  // ── Handle tempPdfId / initiatorAnnotations ───────────────────────────────────
  if (tempPdfId) {
    try {
      const pdfTemp = await prisma.pdfTemp.findUnique({
        where: { id: tempPdfId }
      });
      
      if (pdfTemp) {
        let finalBuffer = pdfTemp.pdfBuffer;

        // Apply annotations using pdf-lib if provided
        if (Array.isArray(initiatorAnnotations) && initiatorAnnotations.length > 0) {
          const { PDFDocument } = require('pdf-lib');
          const pdfDoc = await PDFDocument.load(finalBuffer);
          const pages = pdfDoc.getPages();

          for (const ann of initiatorAnnotations) {
            const pIndex = (ann.page ?? 1) - 1;
            if (pIndex < 0 || pIndex >= pages.length) continue;
            const pdfPage = pages[pIndex];
            const { height } = pdfPage.getSize();

            if (ann.type === "signature" || ann.type === "image") {
              const b64Data = ann.value.split(',')[1] || ann.value;
              const imgBytes = Buffer.from(b64Data, "base64");
              let pdfImage;
              if (ann.value.includes("image/jpeg") || ann.value.includes("image/jpg")) {
                pdfImage = await pdfDoc.embedJpg(imgBytes);
              } else {
                pdfImage = await pdfDoc.embedPng(imgBytes);
              }
              pdfPage.drawImage(pdfImage, {
                x: ann.x,
                y: height - ann.y - (ann.height ?? 50),
                width: ann.width ?? 150,
                height: ann.height ?? 50,
              });
            }
          }
          
          const modifiedBytes = await pdfDoc.save();
          finalBuffer = Buffer.from(modifiedBytes);
        }
        
        const folder = process.env.SHAREPOINT_UPLOAD_FOLDER
            ? `${process.env.SHAREPOINT_UPLOAD_FOLDER}/${formFolder}/${refFolder}`
            : `${formFolder}/${refFolder}`;
            
        // Which field is it?
        const contractFieldLabel = signableDocumentFieldLabel || (generatedContractFields[0]?.label ?? "Contract");
        const originalFilename = `Signed_${contractFieldLabel.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`;

        const storedPath = await uploadToSharePoint(
            finalBuffer, originalFilename, "application/pdf", folder
        );

        docCreates.push({
            fieldName: contractFieldLabel,
            originalName: originalFilename,
            filePath: storedPath,
            mimeType: "application/pdf",
            size: finalBuffer.length,
        });

        if (!internalAttachments[contractFieldLabel]) internalAttachments[contractFieldLabel] = [];
        internalAttachments[contractFieldLabel].push({ isAttachment: true, name: originalFilename, url: "__pending__" });

        await prisma.pdfTemp.delete({ where: { id: tempPdfId } });
      }
    } catch (e) {
      console.error("[tempPdfId] Error processing drafted PDF:", e);
    }
  }

  const createdGhostForms: Array<{ ghostId: string, fieldName: string }> = [];

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

    createdGhostForms.push({ ghostId: ghostSub.id, fieldName: task.fieldName });

    if (!internalAttachments[task.fieldName]) {
      internalAttachments[task.fieldName] = [];
    }
    internalAttachments[task.fieldName].push({ isAttachment: true, name: task.templateName + " PDF", url: "__generating_pdf__" });
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
    const refFolder = sanitiseFolder(reference);  // e.g. "PCL1"

    // Group by fieldname so we can build the attachment array per field
    const byField: Record<string, Express.Multer.File[]> = {};
    for (const file of uploadedFiles) {
      if (!byField[file.fieldname]) byField[file.fieldname] = [];
      byField[file.fieldname].push(file);
    }

    for (const [fieldName, files] of Object.entries(byField)) {
      const attachments: Array<{ isAttachment: true; name: string; url: string }> = [];

      for (const file of files) {
        // SharePoint folder: {SHAREPOINT_UPLOAD_FOLDER}/PETTY CASH LIVE/PCL1 (or root if not set)
        const folder = process.env.SHAREPOINT_UPLOAD_FOLDER
          ? `${process.env.SHAREPOINT_UPLOAD_FOLDER}/${formFolder}/${refFolder}`
          : `${formFolder}/${refFolder}`;

        const storedPath = await uploadToSharePoint(
          file.buffer,
          file.originalname,
          file.mimetype || "application/octet-stream",
          folder
        );

        // Queue the SubmissionDocument record (created after the submission row exists)
        docCreates.push({
          fieldName,
          originalName: file.originalname,
          filePath: storedPath,
          mimeType: file.mimetype || "application/octet-stream",
          size: file.size,
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

  // ── Determine initial status ───────────────────────────────────────────────────────
  const isFullySigned = sigsInput.length === 1 && finalSignatureStatus === "Signed";

  const hasTreater = !!(template?.formTreater && template.formTreater.toLowerCase() !== "none");
  const submissionPdfType = hasSignableDocument ? "none" : (template?.pdfGeneratorType ?? "none");

  const initialStatus = isFullySigned ? (hasTreater ? "Processing" : "Completed") : "Submitted";

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
  }

  // ── Queue Dynamic Contract PDFs to Background Worker ──────────────────────
  if (generatedContractFields.length > 0) {
    for (const field of generatedContractFields) {
      if (!field.contractTemplateId) continue;
      
      try {
        await prisma.pdfJobQueue.create({
          data: {
            sourceSubmissionId: submission.id,
            jobType: "DynamicContract",
            targetFieldName: field.label,
          }
        });
        
        if (!updatedResponses[field.label]) updatedResponses[field.label] = [];
        (updatedResponses[field.label] as any[]).push({
          isAttachment: true,
          name: "Contract Document",
          url: "__generating_pdf__"
        });
        console.info(`[pdf] Queued Dynamic Contract PDF generation for field ${field.label}`);
      } catch (err) {
        console.error(`[pdf] Failed to queue dynamic contract PDF for field ${field.label}:`, err);
      }
    }
  }

  if (requestToken) {
    try {
      const existingReq = await prisma.formRequest.findUnique({
        where: { token: requestToken },
        include: { batch: true }
      });
      if (existingReq && existingReq.batch.status !== "Deleted") {
        await prisma.formRequest.update({
          where: { token: requestToken },
          data: { status: "Completed", submissionId: submission.id, completedAt: new Date() }
        });
        
        // Also update batch status if all requests are completed
        const pendingCount = await prisma.formRequest.count({
          where: { batchId: existingReq.batchId, status: "Pending" }
        });
        if (pendingCount === 0) {
          await prisma.formRequestBatch.update({
            where: { id: existingReq.batchId },
            data: { status: "Completed" }
          });
        } else {
          await prisma.formRequestBatch.update({
            where: { id: existingReq.batchId },
            data: { status: "Partially Completed" }
          });
        }
      }
    } catch (err) {
      console.error("[submissions] Failed to mark request as completed:", err);
    }
  }

  // ── Audit: record initial submission event ──
  prisma.formAuditTrail.create({
    data: {
      submissionId: submission.id,
      formReference: submission.reference,
      prevStatus: "",
      newStatus: initialStatus,
      action: "submitted",
      actorName: req.user?.user_name ?? req.user?.email ?? null,
      actorEmail: req.user?.email ?? null,
      note: `Form: ${formName}`,
    },
  }).catch((e: any) => console.error("[audit] submit:", e));

  // ── Enqueue PDF generation jobs for any internal ghost forms ──
  for (const ghost of createdGhostForms) {
    await prisma.pdfJobQueue.create({
      data: {
        sourceSubmissionId: ghost.ghostId,
        jobType: "InternalForm",
        targetSubmissionId: submission.id,
        targetFieldName: ghost.fieldName,
      }
    });
    console.info(`[pdf] Queued Internal PDF generation for ghost ${ghost.ghostId}`);
  }

  // ── Background: generate + store the PDF if fully signed at submission ──
  // Only if the form template has a PDF generator type configured (not "none")
  if (isFullySigned && submissionPdfType !== "none") {
    checkAndUnblockPrerequisites(submission.id);
    
    // Check if this submission is a prerequisite for another form
    const prereqCheck = await prisma.submissionPrerequisite.findUnique({
      where: { prereqSubmissionId: submission.id },
      include: { targetForm: { select: { name: true } } }
    });
    
    const isPrereq = !!prereqCheck;

    // Queue PDF generation for the background worker
    await prisma.pdfJobQueue.create({
      data: {
        sourceSubmissionId: submission.id,
        jobType: isPrereq ? "Prerequisite" : "MainForm",
        targetSubmissionId: isPrereq ? prereqCheck!.mainSubmissionId : null,
        targetFieldName: isPrereq ? `PrerequisitePDF:${prereqCheck!.targetForm?.name ?? "Prerequisite"}` : null,
      },
    });
    console.info(`[pdf] Queued PDF generation for submission ${submission.id}`);
  } else if (isFullySigned) {
    // No PDF configured — still unblock prerequisites
    checkAndUnblockPrerequisites(submission.id);
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
        select: { fields: true, needsContract: true, contractTemplateId: true },
      });
      if (!templateWithFields) return;

      const fields = templateWithFields.fields as any[];
      const prereqFields = fields.filter(
        (f: any) => f.isPrerequisite === true && f.targetFormTemplateId
      );
      
      const requiresContract = templateWithFields.needsContract && templateWithFields.contractTemplateId;

      if (prereqFields.length === 0 && !requiresContract) {
        // Always send submission confirmation to submitter
        notifySubmitterOfSubmission(submission.id);

        if (initialStatus === "Submitted") {
          notifyActiveSignatories(submission.id);
        } else if (initialStatus === "Completed") {
          notifySuccessfulCompletion(submission.id);
        }
        return;
      }

      // For each prerequisite field, create a SubmissionPrerequisite record
      let prereqCount = 0;
      const isMainFormFullySignedAtStart = initialStatus === "Processing" || initialStatus === "Completed";
      
      // Determine max prerequisite order to ensure Contract is the last one
      let maxPrereqOrder = 0;
      for (const field of prereqFields) {
        const order = field.prerequisiteOrder ? parseInt(field.prerequisiteOrder) : 1;
        if (order > maxPrereqOrder) maxPrereqOrder = order;
      }
      const contractOrder = maxPrereqOrder + 1;

      if (requiresContract) {
        const contract = await prisma.contractRequest.create({
          data: {
            submissionId: submission.id,
            templateId: templateWithFields.contractTemplateId as string,
            submitterEmail: req.user?.email || "Unknown",
          }
        });
        
        await prisma.submissionPrerequisite.create({
          data: {
            mainSubmissionId: submission.id,
            type: "CONTRACT",
            contractRequestId: contract.id,
            targetEmail: req.user?.email || "Unknown",
            order: contractOrder, // Contract is always the last prerequisite
            status: isMainFormFullySignedAtStart && contractOrder === 1 ? "Active" : "Pending",
          }
        });
        prereqCount++;
      }

      for (const field of prereqFields) {
        const targetEmail = (formResponses[field.id] ?? formResponses[field.label] ?? "").trim();
        if (!targetEmail) continue;

        const targetTemplate = await prisma.formTemplate.findUnique({
          where: { id: field.targetFormTemplateId },
          select: { id: true, name: true, fields: true },
        });
        if (!targetTemplate) continue;

        const order = field.prerequisiteOrder ? parseInt(field.prerequisiteOrder) : 1;
        const isActiveNow = isMainFormFullySignedAtStart && order === 1;

        if (isActiveNow) {
          // ACTIVE: Generate draft and send email immediately
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
              status: "Active",
              order,
            },
          });
          prereqCount++;

          // Notify the target email
          const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";
          const fillUrl = `${appUrl}/dashboard/forms/draft/${prereqSub.id}`;
          mailer.sendMail({
            from: `FINCALite <${process.env.SMTP_FROM ?? "noreply@paperless.ng"}>`,
            to: targetEmail,
            subject: `Action Required: Please complete the "${targetTemplate.name}" form`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
                <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
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

        } else {
          // PENDING: Queue for later, do not create draft or send email yet
          await prisma.submissionPrerequisite.create({
            data: {
              mainSubmissionId: submission.id,
              targetFormId: targetTemplate.id,
              targetEmail,
              status: "Pending",
              order,
            },
          });
          prereqCount++;
        }
      }

      // Block the main submission ONLY if it was about to go to Processing/Completed (fully signed)
      notifySubmitterOfSubmission(submission.id);

      if (prereqCount > 0 && isMainFormFullySignedAtStart) {
        await prisma.formSubmission.update({
          where: { id: submission.id },
          data: { status: "Blocked - Awaiting Prerequisites" },
        });
      } else {
        if (initialStatus === "Submitted") {
          notifyActiveSignatories(submission.id);
        } else if (initialStatus === "Completed") {
          notifySuccessfulCompletion(submission.id);
        }
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

  // Fetch latest submission data
  const finalSubmission = await prisma.formSubmission.findUnique({
    where: { id: submission.id },
    include: { signatories: true, documents: true },
  });
  res.status(201).json({ success: true, data: finalSubmission ?? submission });
});

// ── POST /api/v1/submissions/:id/file-attachments ────────────────────────────
// Mark a submission as Filed and save a local copy of the data
router.post("/:id/file-attachments", async (req, res: Response) => {
  const submission = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    include: { template: true },
  });
  if (!submission) { res.status(404).json({ success: false, error: "Submission not found", code: "SUBMISSION_NOT_FOUND" }); return; }

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
  if (!userId) { res.status(401).json({ success: false, error: "Unauthenticated", code: "UNAUTHENTICATED" }); return; }

  const existing = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
    include: { signatories: true },
  });

  if (!existing) { res.status(404).json({ success: false, error: "Submission not found", code: "SUBMISSION_NOT_FOUND" }); return; }

  // Ownership check — only the original submitter may edit
  if (existing.submittedById !== userId) {
    res.status(403).json({ success: false, error: "You do not have permission to edit this submission", code: "YOU_DO_NOT_HAVE_PERMISSION_TO" });
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
    res.status(400).json({ success: false, error: "formResponses is required", code: "FORMRESPONSES_IS_REQUIRED" });
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
  if (!userId) { res.status(401).json({ success: false, error: "Unauthenticated", code: "UNAUTHENTICATED" }); return; }

  const existing = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
  });

  if (!existing) { res.status(404).json({ success: false, error: "Submission not found", code: "SUBMISSION_NOT_FOUND" }); return; }

  // Ownership check
  if (existing.submittedById !== userId) {
    res.status(403).json({ success: false, error: "You do not have permission to delete this submission", code: "YOU_DO_NOT_HAVE_PERMISSION_TO" });
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

// ── PATCH /api/v1/submissions/:id/soft-delete ─────────────────────────────────
// Administrator can soft-delete any submission, specifying a reason.
router.patch("/:id/soft-delete", async (req: AuthRequest, res: Response) => {
  const isSystemAdmin = req.user?.user_role?.toLowerCase() === "administrator" || req.user?.specialAccess?.toLowerCase().includes("administrator");

  if (!isSystemAdmin) {
    res.status(403).json({ success: false, error: "Forbidden: Administrators only", code: "FORBIDDEN_ADMINISTRATORS_ONLY" });
    return;
  }

  const { reason } = req.body;
  if (!reason) {
    res.status(400).json({ success: false, error: "A reason is required for soft deletion.", code: "A_REASON_IS_REQUIRED_FOR_SOFT" });
    return;
  }

  const existing = await prisma.formSubmission.findUnique({
    where: { id: req.params.id },
  });

  if (!existing) {
    res.status(404).json({ success: false, error: "Submission not found", code: "SUBMISSION_NOT_FOUND" });
    return;
  }

  const updated = await prisma.formSubmission.update({
    where: { id: req.params.id },
    data: { status: "Deleted" },
  });

  // Audit trail
  await prisma.formAuditTrail.create({
    data: {
      submissionId: existing.id,
      formReference: existing.reference,
      prevStatus: existing.status,
      newStatus: "Deleted",
      action: "soft_deleted",
      actorName: req.user?.user_name ?? req.user?.email ?? "Administrator",
      actorEmail: req.user?.email ?? null,
      note: reason,
    },
  }).catch((e: any) => console.error("[audit] soft-delete error:", e));

  res.json({ success: true, data: updated });
});

export default router;
