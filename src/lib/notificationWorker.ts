import prisma from "./prisma";
import { mailer } from "./mailer";
import { notifier } from "./notifier";
import { logger } from "./logger";

const POLL_INTERVAL_MS = 60_000; // 60 seconds
const MAX_CONCURRENT_JOBS = 10;
const MAX_ATTEMPTS = 3;

async function processJob(job: any): Promise<void> {
  const payload = job.payload as any;

  if (job.channel === "EMAIL") {
    if (payload.attachments) {
      for (const att of payload.attachments) {
        if (att.content && att.content.type === "Buffer" && Array.isArray(att.content.data)) {
          att.content = Buffer.from(att.content.data);
        }
      }
    }
    await mailer.sendMail({
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      ...(payload.attachments ? { attachments: payload.attachments } : {}),
    });
  } else if (job.channel === "TEAMS") {
    await notifier.send({
      to: payload.to,
      subject: payload.subject,
      message: payload.message,
      link: payload.link,
    });
  } else {
    throw new Error(`Unknown notification channel: ${job.channel}`);
  }
}

async function pollQueue(): Promise<void> {
  try {
    const pendingJobs = await prisma.notificationQueue.findMany({
      where: {
        status: "PENDING",
        attempts: { lt: MAX_ATTEMPTS },
      },
      orderBy: { createdAt: "asc" },
      take: MAX_CONCURRENT_JOBS,
    });

    if (pendingJobs.length === 0) return;

    // Mark as PROCESSING to prevent double-pick
    await prisma.notificationQueue.updateMany({
      where: { id: { in: pendingJobs.map((j: any) => j.id) } },
      data: { status: "PROCESSING" },
    });

    for (const job of pendingJobs) {
      try {
        await processJob(job);

        // Success — mark as SENT
        await prisma.notificationQueue.update({
          where: { id: job.id },
          data: { status: "SENT" },
        });

        logger.info(`[notification-worker] ✅ ${job.channel} sent to ${(job.payload as any).to}`);
      } catch (err: any) {
        const newAttempts = job.attempts + 1;
        logger.error(`[notification-worker] ❌ Job ${job.id} failed (attempt ${newAttempts}): ${err.message ?? err}`);

        await prisma.notificationQueue.update({
          where: { id: job.id },
          data: {
            status: "PENDING",
            attempts: newAttempts,
            errorLog: String(err.message ?? err).slice(0, 500),
          },
        });
      }
    }
  } catch (err) {
    logger.error("[notification-worker] Poll cycle error: " + (err as Error).message);
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startNotificationWorker(): void {
  if (intervalId) return;
  logger.info(`[notification-worker] 🚀 Started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  pollQueue();
  intervalId = setInterval(pollQueue, POLL_INTERVAL_MS);
}

export function stopNotificationWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info("[notification-worker] Stopped");
  }
}
