import prisma from "./prisma";
import { generateSubmissionPdf, generateContractPdf } from "./pdfGenerator";
import { isSharePointEnabled } from "./sharepoint";
import { storeDocumentLocally } from "./storage";
import fs from "fs/promises";
import path from "path";

const POLL_INTERVAL_MS = 60_000; // 60 seconds
const MAX_CONCURRENT_JOBS = 3;
const MAX_ATTEMPTS = 3;

/**
 * Process a single PDF job from the queue.
 * Mirrors the logic used in the manual /:id/generate-pdf endpoint.
 */
async function processJob(job: {
  id: string;
  sourceSubmissionId: string;
  jobType: string;
  targetSubmissionId: string | null;
  targetFieldName: string | null;
}): Promise<void> {
  const submission = await prisma.formSubmission.findUnique({
    where: { id: job.sourceSubmissionId },
    include: { template: true }
  });

  if (!submission) {
    await prisma.pdfJobQueue.update({
      where: { id: job.id },
      data: { status: "Failed", errorMsg: "Submission not found" },
    });
    return;
  }

  let pdfResult;
  if (job.jobType === "Contract" && job.targetSubmissionId) {
    pdfResult = await generateContractPdf(job.targetSubmissionId);
  } else if (job.jobType === "DynamicContract" && job.targetFieldName) {
    const templateFields = typeof submission.template?.fields === "string" 
      ? JSON.parse(submission.template.fields) 
      : (submission.template?.fields || []);
    
    const field = templateFields.find((f: any) => f.label === job.targetFieldName);
    const templateId = field?.contractTemplateId;

    if (!templateId) {
      await prisma.pdfJobQueue.update({
        where: { id: job.id },
        data: { status: "Failed", errorMsg: `Could not find contractTemplateId for field ${job.targetFieldName}` },
      });
      return;
    }
    const { generateDynamicContractPdf } = await import("./pdfGenerator");
    pdfResult = await generateDynamicContractPdf(submission.id, templateId, job.targetFieldName);
  } else {
    pdfResult = await generateSubmissionPdf(job.sourceSubmissionId);
  }

  if (!pdfResult) {
    await prisma.pdfJobQueue.update({
      where: { id: job.id },
      data: { status: "Failed", errorMsg: "PDF Generator returned null" },
    });
    return;
  }

  // Build folder paths (same logic as the manual trigger)
  let folderFormName = submission.formName;
  let folderReference = submission.reference || submission.id.slice(-6);

  // If this is an internal form or prerequisite, we want to save it in the PARENT form's folder
  if ((job.jobType === "InternalForm" || job.jobType === "Prerequisite") && job.targetSubmissionId) {
    const parentSubmission = await prisma.formSubmission.findUnique({
      where: { id: job.targetSubmissionId },
      select: { formName: true, reference: true, id: true }
    });
    if (parentSubmission) {
      folderFormName = parentSubmission.formName;
      folderReference = parentSubmission.reference || parentSubmission.id.slice(-6);
    }
  }

  const formFolder = folderFormName.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase();
  const refFolder = folderReference.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase();

  const folderPath = process.env.SHAREPOINT_UPLOAD_FOLDER 
    ? `${process.env.SHAREPOINT_UPLOAD_FOLDER}/${formFolder}/${refFolder}`
    : `${formFolder}/${refFolder}`;
  const finalFolder = job.jobType === "Contract" ? `${folderPath}/Contracts` : folderPath;

  const storedPath = await storeDocumentLocally(
    pdfResult.buffer,
    pdfResult.filename,
    "application/pdf",
    finalFolder,
    true
  );

  if (!storedPath) {
    await prisma.pdfJobQueue.update({
      where: { id: job.id },
      data: { status: "Failed", errorMsg: "Failed to store PDF (storedPath empty)" },
    });
    return;
  }

  // Determine which submission to attach the PDF record and formResponses link to.
  // For "InternalForm" and "Prerequisite" jobs the PDF is attached to the *target* (parent) submission.
  const isTargetJob = (job.jobType === "InternalForm" || job.jobType === "Prerequisite") && job.targetSubmissionId;
  const attachToId = isTargetJob ? job.targetSubmissionId! : job.sourceSubmissionId;

  const fieldName = (isTargetJob && job.targetFieldName)
      ? job.targetFieldName
      : (job.jobType === "DynamicContract" && job.targetFieldName)
        ? job.targetFieldName
        : "CompletedFormPDF";

  // Create the document record
  const created = await prisma.submissionDocument.create({
    data: {
      submissionId: attachToId,
      fieldName,
      originalName: pdfResult.filename,
      filePath: storedPath,
      mimeType: "application/pdf",
      size: pdfResult.buffer.length,
    },
  });

  // IMPORTANT: Fetch the LATEST formResponses from the database to avoid
  // overwriting concurrent updates (solves the race condition).
  const latestSubmission = await prisma.formSubmission.findUnique({
    where: { id: attachToId },
    select: { formResponses: true },
  });

  const resData = (latestSubmission?.formResponses as Record<string, any>) || {};
  
  if (job.jobType === "Prerequisite" || job.jobType === "Contract") {
    // Prerequisite and Contract PDFs are tracked purely as SubmissionDocuments
    // No need to inject them into formResponses
  } else if (job.jobType === "InternalForm" || job.jobType === "DynamicContract") {
    const currentArr = Array.isArray(resData[fieldName]) ? resData[fieldName] : [];
    const pendingIndex = currentArr.findIndex((a: any) => a.url === "__generating_pdf__");
    const newAttachment = { isAttachment: true, name: pdfResult.filename, url: `/api/v1/file?docId=${created.id}` };
    
    if (pendingIndex !== -1) {
      currentArr[pendingIndex] = newAttachment;
    } else {
      currentArr.push(newAttachment);
    }
    resData[fieldName] = currentArr;

    await prisma.formSubmission.update({
      where: { id: attachToId },
      data: { formResponses: resData },
    });
  } else {
    resData[fieldName] = [
      { isAttachment: true, name: pdfResult.filename, url: `/api/v1/file?docId=${created.id}` },
    ];

    await prisma.formSubmission.update({
      where: { id: attachToId },
      data: { formResponses: resData },
    });
  }

  // Mark job as completed
  await prisma.pdfJobQueue.update({
    where: { id: job.id },
    data: { status: "Completed" },
  });

  console.info(`[pdf-worker] ✅ Generated and stored: ${pdfResult.filename} (job ${job.id})`);
}

/**
 * Poll the queue for pending jobs and process them.
 */
async function pollQueue(): Promise<void> {
  try {
    // Fetch up to MAX_CONCURRENT_JOBS pending jobs, ordered oldest first.
    // Use a transaction to atomically claim them (set status to "Processing")
    // so no other worker instance picks them up.
    const pendingJobs = await prisma.pdfJobQueue.findMany({
      where: {
        status: "Pending",
        attempts: { lt: MAX_ATTEMPTS },
      },
      orderBy: { createdAt: "asc" },
      take: MAX_CONCURRENT_JOBS,
    });

    if (pendingJobs.length === 0) return;

    // Claim all jobs atomically
    await prisma.pdfJobQueue.updateMany({
      where: { id: { in: pendingJobs.map((j) => j.id) } },
      data: { status: "Processing" },
    });

    // Process each job sequentially to avoid overloading Puppeteer
    for (const job of pendingJobs) {
      try {
        await processJob(job);
      } catch (err: any) {
        console.error(`[pdf-worker] ❌ Job ${job.id} failed:`, err.message ?? err);
        await prisma.pdfJobQueue.update({
          where: { id: job.id },
          data: {
            status: "Pending", // Return to pending for retry
            attempts: { increment: 1 },
            errorMsg: String(err.message ?? err).slice(0, 500),
          },
        });
      }
    }
  } catch (err) {
    console.error("[pdf-worker] Poll cycle error:", err);
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Start the PDF worker polling loop. Call once at server startup.
 */
export function startPdfWorker(): void {
  if (intervalId) return; // Already running

  console.info(`[pdf-worker] 🚀 Started (polling every ${POLL_INTERVAL_MS / 1000}s)`);

  // Run once immediately, then on interval
  pollQueue();
  intervalId = setInterval(pollQueue, POLL_INTERVAL_MS);
}

/**
 * Stop the PDF worker polling loop (useful for graceful shutdown / tests).
 */
export function stopPdfWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.info("[pdf-worker] Stopped");
  }
}
