import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import prisma from "../lib/prisma";
import { notifyActiveSignatories, notifySuccessfulCompletion } from "./workflow";
import { isSharePointEnabled, uploadToSharePoint } from "../lib/sharepoint";

// Files are always buffered in memory; they go straight to SharePoint (or disk)
// on submission — never stored in a temp location.
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB per file
});

// Sanitise a string for use as a SharePoint / filesystem folder segment.
function sanitiseFolder(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase();
}

const router = Router();

async function buildPublicSignatories(template: any, publicSubmitterName: string, publicSubmitterEmail: string, submitterSignature: string | undefined) {
  let initialStatus = "Submitted";
  const signatoriesData: any[] = [{
    position: 1,
    userName: publicSubmitterName,
    email: publicSubmitterEmail,
    status: "Signed",
    signatureData: submitterSignature || null,
    signedAt: new Date()
  }];

  if (template.automatedSignatories) {
    const autoSigs = typeof template.automatedSignatories === "string" 
      ? JSON.parse(template.automatedSignatories) 
      : template.automatedSignatories;
    
    if (Array.isArray(autoSigs) && autoSigs.length > 0) {
      let currentPosition = 2;
      for (const sig of autoSigs) {
        let targetBranch = sig.branch;
        if (targetBranch === "USER BRANCH") {
           targetBranch = "HQ"; // Fallback
        }
        const user = await prisma.user.findFirst({
          where: {
            status: { equals: "active", mode: "insensitive" },
            branch: { equals: targetBranch, mode: "insensitive" },
            OR: [
              { user_role: { equals: sig.role, mode: "insensitive" } },
              { specialAccess: { contains: sig.role, mode: "insensitive" } }
            ]
          }
        });
        if (user) {
          signatoriesData.push({
            position: currentPosition++,
            userName: user.user_name || "Unknown",
            email: user.finca_email || "unknown@internal",
            status: "Pending"
          });
        }
      }
      initialStatus = signatoriesData.length > 1 ? "In-review" : "Submitted";
    } else {
      const hasTreater = !!(template?.formTreater && template.formTreater.toLowerCase() !== "none");
      initialStatus = hasTreater ? "Processing" : "Completed";
    }
  } else {
    const hasTreater = !!(template?.formTreater && template.formTreater.toLowerCase() !== "none");
    initialStatus = hasTreater ? "Processing" : "Completed";
  }

  return { signatoriesData, initialStatus };
}

// GET /api/v1/public-forms/slug/:slug
// Fetches the template details for an anonymous user
router.get("/slug/:slug", async (req: Request, res: Response) => {
  const { slug } = req.params;
  const template = await prisma.formTemplate.findUnique({
    where: { publicSlug: slug },
  });

  if (!template || !template.isPublic) {
    res.status(404).json({ success: false, error: "Form not found or not public", code: "FORM_NOT_FOUND" });
    return;
  }

  // Hide internal fields, but return enough to render the form builder fields
  const safeTemplate = {
    id: template.id,
    name: template.name,
    description: template.description,
    fields: template.fields,
  };

  res.json({ success: true, data: safeTemplate });
});

// POST /api/v1/public-forms/submit/:slug
// Accepts a submission from an anonymous user
router.post("/submit/:slug", memUpload.any(), async (req: Request, res: Response) => {
  const { slug } = req.params;
  
  let payload: any = {};
  try {
    if (req.body?.data) {
      payload = JSON.parse(req.body.data);
    } else {
      payload = req.body;
    }
  } catch {
    res.status(400).json({ success: false, error: "Invalid submission data.", code: "INVALID_SUBMISSION_DATA" });
    return;
  }

  const { formResponses = {}, publicSubmitterEmail, publicSubmitterName, token, submitterSignature } = payload;

  if (!publicSubmitterEmail || !publicSubmitterName) {
    res.status(400).json({ success: false, error: "Name and Email are required.", code: "NAME_AND_EMAIL_REQUIRED" });
    return;
  }

  const template = await prisma.formTemplate.findUnique({
    where: { publicSlug: slug },
  });

  if (!template || !template.isPublic) {
    res.status(404).json({ success: false, error: "Form not found or not public", code: "FORM_NOT_FOUND" });
    return;
  }

  const templateFields: any[] = typeof template.fields === "string" ? JSON.parse(template.fields) : (template.fields ?? []);

  // Generate Reference
  let reference = `PUB-${Date.now()}`;
  try {
    const acronym = template.name.split(" ").map((w: string) => w[0]).join("").toUpperCase();
    const latestSub = await prisma.formSubmission.findFirst({
      where: { templateId: template.id },
      orderBy: { createdAt: 'desc' },
      select: { reference: true }
    });

    let nextNumber = 1;
    if (latestSub && latestSub.reference) {
      const match = latestSub.reference.match(/\d+$/);
      if (match) {
        nextNumber = parseInt(match[0], 10) + 1;
      } else {
        const count = await prisma.formSubmission.count({ where: { templateId: template.id } });
        nextNumber = count + 1;
      }
    }
    reference = `${acronym}${nextNumber}`;
  } catch (err) {
    console.error("Reference generation failed, using fallback", err);
  }

  const updatedResponses: Record<string, any> = { ...formResponses };

  // Resolve event_selector
  try {
    for (const field of templateFields) {
      if ((field as any).type !== "event_selector") continue;
      const responseKey = updatedResponses[field.id] !== undefined ? field.id : field.label;
      const eventId: string = (updatedResponses[responseKey] ?? "").toString().trim();
      if (!eventId) continue;

      const event = await prisma.event.findUnique({ where: { id: eventId } });
      if (event) {
        updatedResponses[responseKey] = `${event.name} (${event.reference})`;
        updatedResponses[`${responseKey}_id`] = event.id;
      }
    }
  } catch (e) {
    console.error("[event_selector] Event resolution failed:", e);
  }

  const uploadedFiles = (req.files as Express.Multer.File[]) ?? [];
  const docCreates: Array<{ fieldName: string; originalName: string; filePath: string; mimeType: string; size: number; }> = [];

  if (uploadedFiles.length > 0) {
    const formFolder = sanitiseFolder(template.name);
    const refFolder = sanitiseFolder(reference);

    const byField: Record<string, Express.Multer.File[]> = {};
    for (const file of uploadedFiles) {
      if (!byField[file.fieldname]) byField[file.fieldname] = [];
      byField[file.fieldname].push(file);
    }

    for (const [fieldName, files] of Object.entries(byField)) {
      const attachments: Array<{ isAttachment: true; name: string; url: string }> = [];

      for (const file of files) {
        const folder = process.env.SHAREPOINT_UPLOAD_FOLDER
          ? `${process.env.SHAREPOINT_UPLOAD_FOLDER}/${formFolder}/${refFolder}`
          : `${formFolder}/${refFolder}`;

        const storedPath = await uploadToSharePoint(
          file.buffer,
          file.originalname,
          file.mimetype || "application/octet-stream",
          folder
        );

        docCreates.push({
          fieldName,
          originalName: file.originalname,
          filePath: storedPath,
          mimeType: file.mimetype || "application/octet-stream",
          size: file.size,
        });

        attachments.push({ isAttachment: true, name: file.originalname, url: "__pending__" });
      }
      updatedResponses[fieldName] = attachments;
    }
  }

  try {
    const { signatoriesData, initialStatus } = await buildPublicSignatories(template, publicSubmitterName, publicSubmitterEmail, submitterSignature);

    const submission = await prisma.formSubmission.create({
      data: {
        formName: template.name,
        reference,
        templateId: template.id,
        formResponses: updatedResponses,
        publicSubmitterEmail,
        publicSubmitterName,
        status: initialStatus,
        signatories: { create: signatoriesData },
      },
    });

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
    }

    if (initialStatus === "In-review") {
      notifyActiveSignatories(submission.id).catch(console.error);
    } else if (initialStatus === "Completed") {
      notifySuccessfulCompletion(submission.id).catch(console.error);
      
      // Auto-generate PDF for public forms that require no signatories
      prisma.pdfJobQueue.create({
        data: {
          sourceSubmissionId: submission.id,
          jobType: "InternalForm",
          targetSubmissionId: submission.id,
        }
      }).catch(console.error);
    }

    // ── Audit: record initial submission event ──
    await prisma.formAuditTrail.create({
      data: {
        submissionId: submission.id,
        formReference: submission.reference,
        prevStatus: "",
        newStatus: initialStatus,
        action: "submitted_public",
        actorName: publicSubmitterName,
        actorEmail: publicSubmitterEmail,
        note: `Public Form Submitted: ${template.name}`,
      },
    }).catch(console.error);

    // If there's a token, it means this was a Targeted Request (Option B)
    if (token) {
      const request = await prisma.formRequest.findUnique({ where: { token } });
      if (request) {
        await prisma.formRequest.update({
          where: { token },
          data: {
            status: "Completed",
            completedAt: new Date(),
            submissionId: submission.id,
          }
        });

        const pendingCount = await prisma.formRequest.count({
          where: { batchId: request.batchId, status: "Pending" }
        });
        if (pendingCount === 0) {
          await prisma.formRequestBatch.update({
            where: { id: request.batchId },
            data: { status: "Completed" }
          });
        } else {
          await prisma.formRequestBatch.update({
            where: { id: request.batchId },
            data: { status: "Partially Completed" }
          });
        }
      }
    }

    res.status(201).json({ success: true, data: { id: submission.id, reference } });
  } catch (err: any) {
    console.error("[public submit error]", err);
    res.status(500).json({ success: false, error: "Failed to submit form.", code: "SUBMIT_FAILED" });
  }
});

// GET /api/v1/public-forms/token/:token
// Fetches the template details for a targeted request token
router.get("/token/:token", async (req: Request, res: Response) => {
  const { token } = req.params;
  const request = await prisma.formRequest.findUnique({
    where: { token },
    include: { batch: { include: { template: true } } }
  });

  if (!request) {
    res.status(404).json({ success: false, error: "Request not found", code: "REQUEST_NOT_FOUND" });
    return;
  }

  if (request.batch.status === "Deleted") {
    res.status(410).json({ success: false, error: "This request has been cancelled by the sender", code: "REQUEST_CANCELLED" });
    return;
  }

  if (request.status === "Completed") {
    res.status(400).json({ success: false, error: "This request has already been completed.", code: "REQUEST_ALREADY_COMPLETED" });
    return;
  }

  const template = request.batch.template;

  const safeTemplate = {
    id: template.id,
    name: template.name,
    description: template.description,
    fields: template.fields,
  };

  res.json({ 
    success: true, 
    data: {
      template: safeTemplate,
      targetEmail: request.targetEmail,
      prefilledData: request.batch.prefilledData
    } 
  });
});

// POST /api/v1/public-forms/submit-token/:token
router.post("/submit-token/:token", memUpload.any(), async (req: Request, res: Response) => {
  const { token } = req.params;
  
  let payload: any = {};
  try {
    if (req.body?.data) {
      payload = JSON.parse(req.body.data);
    } else {
      payload = req.body;
    }
  } catch {
    res.status(400).json({ success: false, error: "Invalid submission data.", code: "INVALID_SUBMISSION_DATA" });
    return;
  }

  const { formResponses = {}, publicSubmitterName, submitterSignature } = payload;

  if (!publicSubmitterName) {
    res.status(400).json({ success: false, error: "Name is required.", code: "NAME_REQUIRED" });
    return;
  }

  const request = await prisma.formRequest.findUnique({
    where: { token },
    include: { batch: { include: { template: true } } }
  });

  if (!request) {
    res.status(404).json({ success: false, error: "Request not found", code: "REQUEST_NOT_FOUND" });
    return;
  }

  if (request.status === "Completed") {
    res.status(400).json({ success: false, error: "Request already completed.", code: "REQUEST_ALREADY_COMPLETED" });
    return;
  }

  const template = request.batch.template;
  const templateFields: any[] = typeof template.fields === "string" ? JSON.parse(template.fields) : (template.fields ?? []);

  // Generate Reference
  let reference = `REQ-${Date.now()}`;
  try {
    const acronym = template.name.split(" ").map((w: string) => w[0]).join("").toUpperCase();
    const latestSub = await prisma.formSubmission.findFirst({
      where: { templateId: template.id },
      orderBy: { createdAt: 'desc' },
      select: { reference: true }
    });

    let nextNumber = 1;
    if (latestSub && latestSub.reference) {
      const match = latestSub.reference.match(/\d+$/);
      if (match) {
        nextNumber = parseInt(match[0], 10) + 1;
      } else {
        const count = await prisma.formSubmission.count({ where: { templateId: template.id } });
        nextNumber = count + 1;
      }
    }
    reference = `${acronym}${nextNumber}`;
  } catch (err) {
    console.error("Reference generation failed, using fallback", err);
  }

  const updatedResponses: Record<string, any> = { ...formResponses };

  // Resolve event_selector
  try {
    for (const field of templateFields) {
      if ((field as any).type !== "event_selector") continue;
      const responseKey = updatedResponses[field.id] !== undefined ? field.id : field.label;
      const eventId: string = (updatedResponses[responseKey] ?? "").toString().trim();
      if (!eventId) continue;

      const event = await prisma.event.findUnique({ where: { id: eventId } });
      if (event) {
        updatedResponses[responseKey] = `${event.name} (${event.reference})`;
        updatedResponses[`${responseKey}_id`] = event.id;
      }
    }
  } catch (e) {
    console.error("[event_selector] Event resolution failed:", e);
  }

  const uploadedFiles = (req.files as Express.Multer.File[]) ?? [];
  const docCreates: Array<{ fieldName: string; originalName: string; filePath: string; mimeType: string; size: number; }> = [];

  if (uploadedFiles.length > 0) {
    const formFolder = sanitiseFolder(template.name);
    const refFolder = sanitiseFolder(reference);

    const byField: Record<string, Express.Multer.File[]> = {};
    for (const file of uploadedFiles) {
      if (!byField[file.fieldname]) byField[file.fieldname] = [];
      byField[file.fieldname].push(file);
    }

    for (const [fieldName, files] of Object.entries(byField)) {
      const attachments: Array<{ isAttachment: true; name: string; url: string }> = [];

      for (const file of files) {
        const folder = process.env.SHAREPOINT_UPLOAD_FOLDER
          ? `${process.env.SHAREPOINT_UPLOAD_FOLDER}/${formFolder}/${refFolder}`
          : `${formFolder}/${refFolder}`;

        const storedPath = await uploadToSharePoint(
          file.buffer,
          file.originalname,
          file.mimetype || "application/octet-stream",
          folder
        );

        docCreates.push({
          fieldName,
          originalName: file.originalname,
          filePath: storedPath,
          mimeType: file.mimetype || "application/octet-stream",
          size: file.size,
        });

        attachments.push({ isAttachment: true, name: file.originalname, url: "__pending__" });
      }
      updatedResponses[fieldName] = attachments;
    }
  }

  try {
    const { signatoriesData, initialStatus } = await buildPublicSignatories(template, publicSubmitterName, request.targetEmail, submitterSignature);

    const submission = await prisma.formSubmission.create({
      data: {
        formName: template.name,
        reference,
        templateId: template.id,
        formResponses: updatedResponses,
        publicSubmitterEmail: request.targetEmail,
        publicSubmitterName,
        status: initialStatus,
        requestBatchId: request.batchId,
        signatories: { create: signatoriesData },
      },
    });

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
    }

    if (initialStatus === "In-review") {
      notifyActiveSignatories(submission.id).catch(console.error);
    } else if (initialStatus === "Completed") {
      notifySuccessfulCompletion(submission.id).catch(console.error);
    }

    await prisma.formAuditTrail.create({
      data: {
        submissionId: submission.id,
        formReference: submission.reference,
        prevStatus: "",
        newStatus: initialStatus,
        action: "submitted_request",
        actorName: publicSubmitterName,
        actorEmail: request.targetEmail,
        note: `Targeted Request Submitted: ${template.name}`,
      },
    }).catch(console.error);

    // Update Request
    await prisma.formRequest.update({
      where: { token },
      data: {
        status: "Completed",
        completedAt: new Date(),
        submissionId: submission.id,
      }
    });

    // Check Batch
    const pendingCount = await prisma.formRequest.count({
      where: { batchId: request.batchId, status: "Pending" }
    });
    if (pendingCount === 0) {
      await prisma.formRequestBatch.update({
        where: { id: request.batchId },
        data: { status: "Completed" }
      });
    } else {
      await prisma.formRequestBatch.update({
        where: { id: request.batchId },
        data: { status: "Partially Completed" }
      });
    }

    res.status(201).json({ success: true, data: { id: submission.id, reference } });
  } catch (err: any) {
    console.error("[public submit error]", err);
    res.status(500).json({ success: false, error: "Failed to submit form.", code: "SUBMIT_FAILED" });
  }
});

// GET /api/v1/public-forms/slug/:slug/options
// Fetches dynamic options for select, searchable_select, and event_selector
router.get("/slug/:slug/options", async (req: Request, res: Response) => {
  const { slug } = req.params;
  const template = await prisma.formTemplate.findUnique({
    where: { publicSlug: slug },
  });

  if (!template || !template.isPublic) {
    res.status(404).json({ success: false, error: "Form not found or not public", code: "FORM_NOT_FOUND" });
    return;
  }

  const fields: any[] = typeof template.fields === "string" ? JSON.parse(template.fields) : (template.fields ?? []);
  const optionsMap: Record<string, { label: string, value: string }[]> = {};

  try {
    for (const field of fields) {
      if ((field.type === "select" || field.type === "searchable_select")) {
        if (field.optionsSource === "database" && field.optionsTable) {
          try {
            const query = `SELECT DISTINCT "Options" as option FROM "${field.optionsTable}" WHERE "Options" IS NOT NULL`;
            const rows = await prisma.$queryRawUnsafe<any[]>(query);
            optionsMap[field.id] = rows.map((r) => ({ value: r.option, label: r.option }));
          } catch (e) {
             optionsMap[field.id] = [];
          }
        } else if (field.optionsSource === "reusable_list" && field.reusableListId) {
          try {
            const list = await prisma.reusableList.findUnique({ where: { id: field.reusableListId } });
            if (list && Array.isArray(list.items)) {
               optionsMap[field.id] = (list.items as string[]).map(s => ({ label: s, value: s }));
            } else {
               optionsMap[field.id] = [];
            }
          } catch (e) {
             optionsMap[field.id] = [];
          }
        }
      } else if (field.type === "event_selector") {
        try {
          const events = await prisma.event.findMany({
            where: { endDate: { gte: new Date() } },
            orderBy: { startDate: "asc" }
          });
          optionsMap[field.id] = events.map(e => ({
            value: e.id,
            label: `${e.name} (${e.reference}) - ${e.startDate.toLocaleDateString()}`
          }));
        } catch (e) {
          optionsMap[field.id] = [];
        }
      }
    }
    res.json({ success: true, data: optionsMap });
  } catch (err) {
    console.error("Error fetching options for public form:", err);
    res.status(500).json({ success: false, error: "Failed to fetch options", code: "OPTIONS_FETCH_FAILED" });
  }
});

// GET /api/v1/public-forms/token/:token/options
router.get("/token/:token/options", async (req: Request, res: Response) => {
  const { token } = req.params;
  const request = await prisma.formRequest.findUnique({
    where: { token },
    include: { batch: { include: { template: true } } }
  });

  if (!request) {
    res.status(404).json({ success: false, error: "Request not found", code: "REQUEST_NOT_FOUND" });
    return;
  }

  const template = request.batch.template;
  const fields: any[] = typeof template.fields === "string" ? JSON.parse(template.fields) : (template.fields ?? []);
  const optionsMap: Record<string, { label: string, value: string }[]> = {};

  try {
    for (const field of fields) {
      if ((field.type === "select" || field.type === "searchable_select")) {
        if (field.optionsSource === "database" && field.optionsTable) {
          try {
            const query = `SELECT DISTINCT "Options" as option FROM "${field.optionsTable}" WHERE "Options" IS NOT NULL`;
            const rows = await prisma.$queryRawUnsafe<any[]>(query);
            optionsMap[field.id] = rows.map((r) => ({ value: r.option, label: r.option }));
          } catch (e) {
             optionsMap[field.id] = [];
          }
        } else if (field.optionsSource === "reusable_list" && field.reusableListId) {
          try {
            const list = await prisma.reusableList.findUnique({ where: { id: field.reusableListId } });
            if (list && Array.isArray(list.items)) {
               optionsMap[field.id] = (list.items as string[]).map(s => ({ label: s, value: s }));
            } else {
               optionsMap[field.id] = [];
            }
          } catch (e) {
             optionsMap[field.id] = [];
          }
        }
      } else if (field.type === "event_selector") {
        try {
          const events = await prisma.event.findMany({
            where: { endDate: { gte: new Date() } },
            orderBy: { startDate: "asc" }
          });
          optionsMap[field.id] = events.map(e => ({
            value: e.id,
            label: `${e.name} (${e.reference}) - ${e.startDate.toLocaleDateString()}`
          }));
        } catch (e) {
          optionsMap[field.id] = [];
        }
      }
    }
    res.json({ success: true, data: optionsMap });
  } catch (err) {
    console.error("Error fetching options for public form token:", err);
    res.status(500).json({ success: false, error: "Failed to fetch options", code: "OPTIONS_FETCH_FAILED" });
  }
});

export default router;
