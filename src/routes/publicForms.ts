import { Router, Request, Response } from "express";
import prisma from "../lib/prisma";
import { notifyActiveSignatories, notifySuccessfulCompletion } from "./workflow";

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
router.post("/submit/:slug", async (req: Request, res: Response) => {
  const { slug } = req.params;
  const { formResponses, publicSubmitterEmail, publicSubmitterName, token, submitterSignature } = req.body;

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

  try {
    const { signatoriesData, initialStatus } = await buildPublicSignatories(template, publicSubmitterName, publicSubmitterEmail, submitterSignature);

    const submission = await prisma.formSubmission.create({
      data: {
        formName: template.name,
        reference,
        templateId: template.id,
        formResponses: formResponses ?? {},
        publicSubmitterEmail,
        publicSubmitterName,
        status: initialStatus,
        signatories: { create: signatoriesData },
      },
    });

    if (initialStatus === "In-review") {
      notifyActiveSignatories(submission.id).catch(console.error);
    } else if (initialStatus === "Completed") {
      notifySuccessfulCompletion(submission.id).catch(console.error);
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

        // Also update batch status if all requests are completed
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
router.post("/submit-token/:token", async (req: Request, res: Response) => {
  const { token } = req.params;
  const { formResponses, publicSubmitterName, submitterSignature } = req.body;

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
  const publicSubmitterEmail = request.targetEmail;

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

  try {
    const { signatoriesData, initialStatus } = await buildPublicSignatories(template, publicSubmitterName, publicSubmitterEmail, submitterSignature);

    const submission = await prisma.formSubmission.create({
      data: {
        formName: template.name,
        reference,
        templateId: template.id,
        formResponses: formResponses ?? {},
        publicSubmitterEmail,
        publicSubmitterName,
        status: initialStatus,
        requestBatchId: request.batchId,
        signatories: { create: signatoriesData },
      },
    });

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
        actorEmail: publicSubmitterEmail,
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

export default router;
