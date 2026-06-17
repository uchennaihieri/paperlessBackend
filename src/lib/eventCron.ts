import prisma from "./prisma";
import { logger } from "./logger";

export function startEventCron() {
  logger.info("📅 Starting Event Auto-Signature Cron Worker...");
  
  // Run every 15 minutes
  setInterval(async () => {
    try {
      const now = new Date();
      const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
      
      const eventsToClose = await prisma.event.findMany({
        where: {
          masterSubmissionId: null,
          pdfTemplateId: { not: null },
          endDate: { lte: oneHourFromNow }
        },
        include: { facilitators: true }
      });

      for (const event of eventsToClose) {
        logger.info(`Auto-initiating signatures for Event: ${event.reference}`);
        
        const searchString = `${event.name} (${event.reference})`;

        // Compile attendees
        const attendeesRes = await prisma.$queryRaw`
          SELECT "formResponses"::text as responses, "submittedById", "publicSubmitterName"
          FROM "FormSubmission"
          WHERE "formResponses"::text LIKE ${'%' + searchString + '%'}
        `;
        
        const attendeeRecords = [];
        for (const sub of (attendeesRes as any[])) {
          if (sub.submittedById) {
            const user = await prisma.user.findUnique({ where: { id: sub.submittedById } });
            if (user) {
              attendeeRecords.push({
                name: user.user_name || "Unknown",
                email: user.finca_email || "",
                department: user.branch || "N/A"
              });
            }
          } else if (sub.publicSubmitterName) {
            attendeeRecords.push({
              name: sub.publicSubmitterName,
              email: sub.publicSubmitterEmail || "",
              department: "External"
            });
          }
        }

        const formResponses = {
          "Event Name": event.name,
          "Event Reference": event.reference,
          "Start Date": event.startDate.toISOString(),
          "End Date": event.endDate.toISOString(),
          "Total Attendees": attendeeRecords.length.toString(),
          "Participants": attendeeRecords
        };

        const newSubmission = await prisma.formSubmission.create({
          data: {
            formName: `Master Roster: ${event.name}`,
            status: "In-review",
            formResponses,
            signingType: "parallel",
            templateId: event.pdfTemplateId as string,
            signatories: {
              create: event.facilitators.map((fac) => ({
                position: 1, // Parallel signing
                userName: fac.name,
                email: fac.email,
                status: "Pending"
              }))
            }
          }
        });

        await prisma.event.update({
          where: { id: event.id },
          data: { masterSubmissionId: newSubmission.id }
        });
      }
    } catch (e) {
      logger.error("Event Cron Error: " + (e as Error).message);
    }
  }, 15 * 60 * 1000);
}
