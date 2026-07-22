import fs from "fs/promises";
import path from "path";
import prisma from "./prisma";
import { uploadToSharePoint } from "./sharepoint";

const POLL_INTERVAL_MS = 60_000; // 60 seconds
const MAX_CONCURRENT_JOBS = 5;
const MAX_ATTEMPTS = 3;

async function processJob(job: any): Promise<void> {
  let fileBuffer: Buffer;
  try {
    fileBuffer = await fs.readFile(job.localPath);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(`Local file not found: ${job.localPath}`);
    }
    throw err;
  }

  const storedPath = await uploadToSharePoint(
    fileBuffer,
    job.filename,
    job.mimeType,
    job.targetFolder
  );

  if (!storedPath) {
    throw new Error("uploadToSharePoint returned empty path");
  }

  // Find documents referencing this local path and update their sharepointPath and syncedAt
  const relativePath = path.join(job.targetFolder, job.filename).replace(/\\/g, "/");

  await prisma.submissionDocument.updateMany({
    where: { filePath: relativePath },
    data: { 
      sharepointPath: storedPath,
      syncedAt: new Date()
    }
  });

  await prisma.uploadedFile.updateMany({
    where: { filePath: relativePath },
    data: { 
      sharepointPath: storedPath,
      syncedAt: new Date()
    }
  });

  // Mark job as completed
  await prisma.sharepointSyncQueue.update({
    where: { id: job.id },
    data: { status: "Completed" }
  });

  console.info(`[sharepoint-worker] ✅ Synced to SharePoint: ${job.filename}`);
}

async function pollQueue(): Promise<void> {
  try {
    const pendingJobs = await prisma.sharepointSyncQueue.findMany({
      where: {
        status: "Pending",
        attempts: { lt: MAX_ATTEMPTS }
      },
      orderBy: { createdAt: "asc" },
      take: MAX_CONCURRENT_JOBS
    });

    if (pendingJobs.length === 0) return;

    await prisma.sharepointSyncQueue.updateMany({
      where: { id: { in: pendingJobs.map((j: any) => j.id) } },
      data: { status: "Processing" }
    });

    for (const job of pendingJobs) {
      try {
        await processJob(job);
      } catch (err: any) {
        console.error(`[sharepoint-worker] ❌ Job ${job.id} failed:`, err.message ?? err);
        await prisma.sharepointSyncQueue.update({
          where: { id: job.id },
          data: {
            status: "Pending",
            attempts: { increment: 1 },
            errorMsg: String(err.message ?? err).slice(0, 500)
          }
        });
      }
    }
  } catch (err) {
    console.error("[sharepoint-worker] Poll cycle error:", err);
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startSharepointWorker(): void {
  if (intervalId) return;
  console.info(`[sharepoint-worker] 🚀 Started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  pollQueue();
  intervalId = setInterval(pollQueue, POLL_INTERVAL_MS);
}

export function stopSharepointWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.info("[sharepoint-worker] Stopped");
  }
}
