import prisma from "./prisma";
import { logger } from "./logger";

export async function runEventCronCheck() {
  logger.info("📅 Running Event Auto-Signature Cron Check...");
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

    // ── Cleanup old PdfTemp rows (> 24 hours) ──────────────────────────────
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const deletedTempPdfs = await prisma.pdfTemp.deleteMany({
      where: { createdAt: { lt: oneDayAgo } }
    });
    if (deletedTempPdfs.count > 0) {
      logger.info(`🧹 Cleaned up ${deletedTempPdfs.count} old temporary PDFs.`);
    }

    // ── Cleanup 14-day old Local Sync Files ──────────────────────────────────
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const oldSyncedFiles = await prisma.sharepointSyncQueue.findMany({
      where: {
        status: "Completed",
        updatedAt: { lt: fourteenDaysAgo }
      }
    });

    if (oldSyncedFiles.length > 0) {
      const fs = require("fs");
      let deletedCount = 0;
      for (const file of oldSyncedFiles) {
        if (fs.existsSync(file.localPath)) {
          fs.unlinkSync(file.localPath);
          deletedCount++;
        }
      }
      await prisma.sharepointSyncQueue.deleteMany({
        where: { id: { in: oldSyncedFiles.map((f: any) => f.id) } }
      });
      logger.info(`🧹 Cleaned up ${deletedCount} 14-day old local SharePoint uploads.`);
    }

  } catch (e) {
    logger.error("Event Cron Error: " + (e as Error).message);
  }
}

export function startEventCron() {
  logger.info("📅 Starting Event Auto-Signature Cron Worker in interval mode...");
  setInterval(runEventCronCheck, 15 * 60 * 1000);
}
