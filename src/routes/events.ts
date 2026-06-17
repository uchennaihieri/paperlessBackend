import { Router, Request, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";

export const eventsRouter = Router();

eventsRouter.use(authenticate as any);

// GET /api/v1/events - List events created by the logged-in user
eventsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ success: false, error: "Unauthorized" });

    const events = await prisma.event.findMany({
      where: { createdById: user.id },
      include: {
        pdfTemplate: true,
        facilitators: true
      },
      orderBy: { createdAt: "desc" }
    });

    res.json({ success: true, events });
  } catch (error: any) {
    console.error("Error fetching events:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// GET /api/v1/events/all - List all events globally for the Event Selector dropdown
eventsRouter.get("/all", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ success: false, error: "Unauthorized" });

    const events = await prisma.event.findMany({
      where: {
        endDate: { gt: new Date() },
        masterSubmissionId: null
      },
      include: {
        facilitators: true
      },
      orderBy: { createdAt: "desc" }
    });

    res.json({ success: true, events });
  } catch (error: any) {
    console.error("Error fetching all events:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// POST /api/v1/events - Create a new event
eventsRouter.post("/", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ success: false, error: "Unauthorized" });

    const { name, startDate, endDate, pdfTemplateId, facilitators } = req.body;

    // Generate unique reference (EVT-0001)
    const latestEvent = await prisma.event.findFirst({
      orderBy: { id: 'desc' },
      select: { reference: true }
    });

    let nextNumber = 1;
    if (latestEvent && latestEvent.reference) {
      const match = latestEvent.reference.match(/\d+$/);
      if (match) {
        nextNumber = parseInt(match[0], 10) + 1;
      }
    }
    const reference = `EVT-${nextNumber.toString().padStart(4, "0")}`;

    const newEvent = await prisma.event.create({
      data: {
        reference,
        name,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        pdfTemplateId: pdfTemplateId || null,
        createdById: user.id,
        facilitators: {
          create: (facilitators || []).map((f: any) => ({
            email: f.email,
            name: f.name
          }))
        }
      },
      include: {
        facilitators: true,
        pdfTemplate: true
      }
    });

    res.json({ success: true, event: newEvent });
  } catch (error: any) {
    console.error("Error creating event:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/v1/events/:id - Update an event
eventsRouter.put("/:id", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ success: false, error: "Unauthorized" });

    const { name, startDate, endDate, pdfTemplateId, facilitators } = req.body;
    const eventId = req.params.id;

    const existingEvent = await prisma.event.findUnique({ where: { id: eventId } });
    if (!existingEvent) return res.status(404).json({ success: false, error: "Event not found" });
    if (existingEvent.createdById !== user.id) return res.status(403).json({ success: false, error: "Forbidden" });
    if (existingEvent.masterSubmissionId) return res.status(400).json({ success: false, error: "Cannot edit an event after signatures have been initiated." });

    // Update event and replace facilitators
    const updatedEvent = await prisma.$transaction(async (tx) => {
      await tx.eventFacilitator.deleteMany({ where: { eventId } });
      return await tx.event.update({
        where: { id: eventId },
        data: {
          name,
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          pdfTemplateId: pdfTemplateId || null,
          facilitators: {
            create: (facilitators || []).map((f: any) => ({
              email: f.email,
              name: f.name
            }))
          }
        },
        include: {
          facilitators: true,
          pdfTemplate: true
        }
      });
    });

    res.json({ success: true, event: updatedEvent });
  } catch (error: any) {
    console.error("Error updating event:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/v1/events/:id - Delete an event
eventsRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) return res.status(401).json({ success: false, error: "Unauthorized" });

    const eventId = req.params.id;
    const existingEvent = await prisma.event.findUnique({ where: { id: eventId } });
    
    if (!existingEvent) return res.status(404).json({ success: false, error: "Event not found" });
    if (existingEvent.createdById !== user.id) return res.status(403).json({ success: false, error: "Forbidden" });
    if (existingEvent.masterSubmissionId) return res.status(400).json({ success: false, error: "Cannot delete an event after signatures have been initiated." });

    await prisma.event.delete({ where: { id: eventId } });
    res.json({ success: true, message: "Event deleted successfully" });
  } catch (error: any) {
    console.error("Error deleting event:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/v1/events/:id - Get specific event by ID
eventsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const event = await prisma.event.findUnique({
      where: { id: req.params.id },
      include: {
        pdfTemplate: true,
        facilitators: true
      }
    });
    if (!event) return res.status(404).json({ success: false, error: "Event not found" });
    res.json({ success: true, event });
  } catch (error: any) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// GET /api/v1/events/:id/attendees - Get attendees for an event
eventsRouter.get("/:id/attendees", async (req: Request, res: Response) => {
  try {
    const eventId = req.params.id;
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ success: false, error: "Event not found" });

    const searchString = `${event.name} (${event.reference})`;

    const submissions = await prisma.$queryRaw`
      SELECT id, "formResponses", "submittedById", "publicSubmitterName", "publicSubmitterEmail", status, "createdAt"
      FROM "FormSubmission"
      WHERE "formResponses"::text LIKE ${'%' + searchString + '%'}
      ORDER BY "createdAt" DESC
    `;
    
    // For users, we might need to fetch their names if submittedById is present
    const attendeeList = await Promise.all((submissions as any[]).map(async (sub) => {
      let submitterName = sub.publicSubmitterName || "Unknown";
      let submitterEmail = sub.publicSubmitterEmail || "";
      if (sub.submittedById) {
        const user = await prisma.user.findUnique({ where: { id: sub.submittedById } });
        if (user) {
          submitterName = user.user_name || "Unknown";
          submitterEmail = user.finca_email || "";
        }
      }
      return {
        id: sub.id,
        name: submitterName,
        email: submitterEmail,
        status: sub.status,
        date: sub.createdAt
      };
    }));

    res.json({ success: true, attendees: attendeeList });
  } catch (error: any) {
    console.error("Error fetching attendees:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// POST /api/v1/events/:id/initiate-signatures - Lock event and initiate master roster signatures
eventsRouter.post("/:id/initiate-signatures", async (req: Request, res: Response) => {
  try {
    const eventId = req.params.id;
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      include: { facilitators: true }
    });

    if (!event) return res.status(404).json({ success: false, error: "Event not found" });
    if (event.masterSubmissionId) return res.status(400).json({ success: false, error: "Signatures already initiated" });
    if (!event.pdfTemplateId) return res.status(400).json({ success: false, error: "No PDF template associated with this event" });

    const searchString = `${event.name} (${event.reference})`;

    // Fetch attendees to compile the master roster data
    const attendeesRes = await prisma.$queryRaw`
      SELECT id, "formResponses"::text as responses, "submittedById", "publicSubmitterName", "publicSubmitterEmail"
      FROM "FormSubmission"
      WHERE "formResponses"::text LIKE ${'%' + searchString + '%'}
    `;
    
    // We compile all names + signatures into an array for the PDF template
    const attendeeRecords = [];
    for (const sub of (attendeesRes as any[])) {
      // Fetch the first signatory's signature from this submission
      const signatories = await prisma.submissionSignatory.findMany({
        where: { submissionId: sub.id },
        orderBy: { position: "asc" },
        take: 1
      });
      const signatureData = signatories[0]?.signatureData || "";
      const dateSigned = signatories[0]?.signedAt 
        ? new Date(signatories[0].signedAt).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) 
        : "";

      if (sub.submittedById) {
        const user = await prisma.user.findUnique({ where: { id: sub.submittedById } });
        if (user) {
          attendeeRecords.push({
            name: user.user_name || "Unknown",
            signature: signatureData,
            dateSigned
          });
        }
      } else if (sub.publicSubmitterName) {
        attendeeRecords.push({
          name: sub.publicSubmitterName,
          signature: signatureData,
          dateSigned
        });
      }
    }

    const fmtDate = (d: Date) => d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

    const formResponses = {
      "Event Name": event.name,
      "Event Reference": event.reference,
      "Start Date": fmtDate(event.startDate),
      "End Date": fmtDate(event.endDate),
      "Total Attendees": attendeeRecords.length.toString(),
      "Participants": attendeeRecords
    };

    let formTemplate = await prisma.formTemplate.findFirst({
      where: { pdfTemplateId: event.pdfTemplateId, isInternal: true, name: `Master Roster Template (${event.pdfTemplateId})` }
    });

    if (!formTemplate) {
      const pdfTemplate = await prisma.pdfTemplate.findUnique({ where: { id: event.pdfTemplateId } });
      formTemplate = await prisma.formTemplate.create({
        data: {
          name: `Master Roster Template (${event.pdfTemplateId})`,
          fields: [],
          pdfTemplateId: event.pdfTemplateId,
          isInternal: true,
          pdfGeneratorType: pdfTemplate?.type === "html" ? "html" : "document",
          formOwner: "System",
          formTreater: "System"
        }
      });
    }

    // Create the master FormSubmission
    const newSubmission = await prisma.formSubmission.create({
      data: {
        formName: `Master Roster: ${event.name}`,
        status: "In-review",
        formResponses,
        signingType: "parallel", // Parallel for all facilitators
        templateId: formTemplate.id,
        signatories: {
          create: event.facilitators.map((fac: any) => ({
            position: 1, // All are position 1 so they sign in parallel
            userName: fac.name,
            email: fac.email,
            status: "Pending"
          }))
        }
      }
    });

    // Link the Event to the Master Submission
    await prisma.event.update({
      where: { id: event.id },
      data: { masterSubmissionId: newSubmission.id }
    });

    res.json({ success: true, submissionId: newSubmission.id });
  } catch (error: any) {
    console.error("Error initiating signatures:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// GET /api/v1/events/:id/preview-pdf - Generates a dynamic PDF preview of the current event attendees
eventsRouter.get("/:id/preview-pdf", async (req: Request, res: Response) => {
  try {
    const eventId = req.params.id;
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      include: { facilitators: true }
    });

    if (!event) return res.status(404).json({ success: false, error: "Event not found" });
    if (!event.pdfTemplateId) return res.status(400).json({ success: false, error: "No PDF template associated with this event" });

    const searchString = `${event.name} (${event.reference})`;

    const attendeesRes = await prisma.$queryRaw`
      SELECT id, "formResponses"::text as responses, "submittedById", "publicSubmitterName", "publicSubmitterEmail"
      FROM "FormSubmission"
      WHERE "formResponses"::text LIKE ${'%' + searchString + '%'}
    `;
    
    const attendeeRecords = [];
    for (const sub of (attendeesRes as any[])) {
      // Fetch the first signatory's signature from this submission
      const signatories = await prisma.submissionSignatory.findMany({
        where: { submissionId: sub.id },
        orderBy: { position: "asc" },
        take: 1
      });
      const signatureData = signatories[0]?.signatureData || "";
      const dateSigned = signatories[0]?.signedAt 
        ? new Date(signatories[0].signedAt).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) 
        : "";

      if (sub.submittedById) {
        const user = await prisma.user.findUnique({ where: { id: sub.submittedById } });
        if (user) {
          attendeeRecords.push({
            name: user.user_name || "Unknown",
            signature: signatureData,
            dateSigned
          });
        }
      } else if (sub.publicSubmitterName) {
        attendeeRecords.push({
          name: sub.publicSubmitterName,
          signature: signatureData,
          dateSigned
        });
      }
    }

    const fmtDate = (d: Date) => d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

    const formResponses = {
      "Event Name": event.name,
      "Event Reference": event.reference,
      "Start Date": fmtDate(event.startDate),
      "End Date": fmtDate(event.endDate),
      "Total Attendees": attendeeRecords.length.toString(),
      "Participants": attendeeRecords
    };

    let formTemplate = await prisma.formTemplate.findFirst({
      where: { pdfTemplateId: event.pdfTemplateId, isInternal: true, name: `Master Roster Template (${event.pdfTemplateId})` }
    });

    if (!formTemplate) {
      const pdfTemplate = await prisma.pdfTemplate.findUnique({ where: { id: event.pdfTemplateId } });
      formTemplate = await prisma.formTemplate.create({
        data: {
          name: `Master Roster Template (${event.pdfTemplateId})`,
          fields: [],
          pdfTemplateId: event.pdfTemplateId,
          isInternal: true,
          pdfGeneratorType: pdfTemplate?.type === "html" ? "html" : "document",
          formOwner: "System",
          formTreater: "System"
        }
      });
    }

    // Create a temporary submission to generate the preview
    const tempSubmission = await prisma.formSubmission.create({
      data: {
        formName: `Preview: ${event.name}`,
        status: "Draft",
        formResponses,
        signingType: "parallel",
        templateId: formTemplate.id,
      }
    });

    let pdfResult;
    try {
      const { generateSubmissionPdf } = await import("../lib/pdfGenerator");
      pdfResult = await generateSubmissionPdf(tempSubmission.id);
    } finally {
      // Delete the temporary submission
      await prisma.formSubmission.delete({ where: { id: tempSubmission.id } });
    }

    if (!pdfResult) {
      return res.status(500).json({ success: false, error: "Could not generate PDF preview" });
    }

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${pdfResult.filename}"`
    });
    res.send(pdfResult.buffer);

  } catch (error: any) {
    console.error("Error generating preview PDF:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});
