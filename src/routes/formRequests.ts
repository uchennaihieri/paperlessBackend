import { Router, Response } from "express";
import prisma from "../lib/prisma";
import crypto from "crypto";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { logger } from "../lib/logger";
import { mailer } from "../lib/mailer";

const router = Router();
router.use(authenticate as any);

// POST /api/v1/form-requests
router.post("/", async (req: AuthRequest, res: Response) => {
  const { templateId, emails, message, prefilledData } = req.body;
  if (!templateId || !emails || !Array.isArray(emails) || emails.length === 0) {
    res.status(400).json({ success: false, error: "templateId and a list of emails are required" });
    return;
  }

  const requestedBy = req.user?.email;
  if (!requestedBy) {
    res.status(401).json({ success: false, error: "Unauthenticated" });
    return;
  }

  try {
    const batch = await prisma.formRequestBatch.create({
      data: {
        templateId,
        requestedBy,
        message,
        prefilledData,
        requests: {
          create: emails.map((email: string) => ({
            targetEmail: email.trim(),
            token: crypto.randomBytes(16).toString("hex"),
          }))
        }
      },
      include: { requests: true, template: true }
    });

    // Actually send emails
    for (const r of batch.requests) {
      // Check if user is internal
      const isInternal = await prisma.user.findFirst({ where: { finca_email: r.targetEmail } });
      const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      
      const link = isInternal 
        ? `${baseUrl}/dashboard/forms/${batch.templateId}?requestToken=${r.token}`
        : `${baseUrl}/request/${r.token}`;

      const emailBody = `
        <h3>Form Fill Request: ${batch.template.name}</h3>
        <p>Hello,</p>
        <p>You have been requested to fill out the form <strong>${batch.template.name}</strong>.</p>
        ${message ? `<p><strong>Message:</strong><br/>${message.replace(/\n/g, "<br/>")}</p>` : ""}
        <br/>
        <p><a href="${link}" style="display:inline-block;padding:10px 20px;background-color:#59000a;color:white;text-decoration:none;border-radius:5px;">Click here to fill out the form</a></p>
        <br/>
        <p>Thank you.</p>
      `;

      await mailer.sendMail({
        from: `FINCALite <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
        to: r.targetEmail,
        subject: `Form Request: ${batch.template.name}`,
        html: emailBody
      }).catch(err => {
        logger.error(`Failed to send request email to ${r.targetEmail}:`, err);
      });
      
      logger.info(`[FormRequest] Sent email to ${r.targetEmail} for form ${batch.template.name}`);
    }

    res.status(201).json({ success: true, data: batch });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/form-requests/my
router.get("/my", async (req: AuthRequest, res: Response) => {
  const requestedBy = req.user?.email;
  if (!requestedBy) {
    res.status(401).json({ success: false, error: "Unauthenticated" });
    return;
  }

  try {
    const batches = await prisma.formRequestBatch.findMany({
      where: { requestedBy, status: { not: "Deleted" } },
      include: { template: { select: { name: true } }, requests: true },
      orderBy: { createdAt: "desc" }
    });
    res.json({ success: true, data: batches });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/form-requests/pending-for-me
router.get("/pending-for-me", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email;
  if (!email) {
    res.status(401).json({ success: false, error: "Unauthenticated" });
    return;
  }

  try {
    const requests = await prisma.formRequest.findMany({
      where: { 
        targetEmail: email, 
        status: "Pending",
        batch: { status: { not: "Deleted" } }
      },
      include: { 
        batch: { 
          include: { template: { select: { name: true, id: true } } } 
        } 
      },
      orderBy: { createdAt: "desc" }
    });
    res.json({ success: true, data: requests });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/form-requests/:id
router.get("/:id", async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const requestedBy = req.user?.email;

  if (!requestedBy) {
    res.status(401).json({ success: false, error: "Unauthenticated" });
    return;
  }

  try {
    const batch = await prisma.formRequestBatch.findUnique({
      where: { id },
      include: { template: { select: { name: true } }, requests: true }
    });

    if (!batch) {
      res.status(404).json({ success: false, error: "Batch not found" });
      return;
    }

    if (batch.requestedBy !== requestedBy) {
      res.status(403).json({ success: false, error: "Unauthorized" });
      return;
    }

    res.json({ success: true, data: batch });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/v1/form-requests/:id/remind
router.post("/:id/remind", async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const request = await prisma.formRequest.findUnique({
      where: { id },
      include: { batch: { include: { template: true } } }
    });

    if (!request || request.status === "Completed") {
      res.status(400).json({ success: false, error: "Request not found or already completed" });
      return;
    }

    const isInternal = await prisma.user.findFirst({ where: { finca_email: request.targetEmail } });
    const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    
    const link = isInternal 
      ? `${baseUrl}/dashboard/forms/${request.batch.templateId}?requestToken=${request.token}`
      : `${baseUrl}/request/${request.token}`;
    
    const emailBody = `
      <h3>Reminder: Form Fill Request for ${request.batch.template.name}</h3>
      <p>Hello,</p>
      <p>This is a reminder that you have been requested to fill out the form <strong>${request.batch.template.name}</strong>.</p>
      ${request.batch.message ? `<p><strong>Original Message:</strong><br/>${request.batch.message.replace(/\n/g, "<br/>")}</p>` : ""}
      <br/>
      <p><a href="${link}" style="display:inline-block;padding:10px 20px;background-color:#59000a;color:white;text-decoration:none;border-radius:5px;">Click here to fill out the form</a></p>
      <br/>
      <p>Thank you.</p>
    `;

    await mailer.sendMail({
      from: `FINCALite <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: request.targetEmail,
      subject: `Reminder: Form Request for ${request.batch.template.name}`,
      html: emailBody
    }).catch(err => {
      logger.error(`Failed to send reminder email to ${request.targetEmail}:`, err);
    });

    logger.info(`[FormRequest Reminder] Sent reminder email to ${request.targetEmail}`);

    res.json({ success: true, message: "Reminder sent" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/v1/form-requests/:id
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const requestedBy = req.user?.email;

  if (!requestedBy) {
    res.status(401).json({ success: false, error: "Unauthenticated" });
    return;
  }

  try {
    const batch = await prisma.formRequestBatch.findUnique({
      where: { id }
    });

    if (!batch) {
      res.status(404).json({ success: false, error: "Batch not found" });
      return;
    }

    if (batch.requestedBy !== requestedBy && req.user?.user_role?.toLowerCase() !== "administrator") {
      res.status(403).json({ success: false, error: "Unauthorized" });
      return;
    }

    await prisma.formRequestBatch.update({
      where: { id },
      data: { status: "Deleted" }
    });

    res.json({ success: true, message: "Batch deleted" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
