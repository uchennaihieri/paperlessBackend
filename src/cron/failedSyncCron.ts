import cron from "node-cron";
import prisma from "../lib/prisma";
import { logger } from "../lib/logger";

const MAX_RETRY_DAYS = 3;

export async function resetFailedSyncJobs() {
  logger.info("Running daily 11 PM sync job reset...");
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - MAX_RETRY_DAYS);

    // 1. Permanently fail jobs older than cutoff
    const failedResult = await prisma.sharepointSyncQueue.updateMany({
      where: {
        status: "Pending",
        attempts: { gte: 3 },
        createdAt: { lt: cutoffDate },
      },
      data: {
        status: "Failed",
      },
    });
    if (failedResult.count > 0) {
      logger.info(`Marked ${failedResult.count} sync jobs as permanently Failed (older than ${MAX_RETRY_DAYS} days).`);
    }

    // 2. Reset recent jobs
    const resetResult = await prisma.sharepointSyncQueue.updateMany({
      where: {
        status: "Pending",
        attempts: { gte: 3 },
        createdAt: { gte: cutoffDate },
      },
      data: {
        attempts: 0,
      },
    });
    logger.info(`Reset ${resetResult.count} failed sync jobs to retry.`);
  } catch (err) {
    logger.error("Error resetting failed sync jobs: " + (err as Error).message);
  }
}

export function startFailedSyncCron() {
  logger.info("Scheduling failed sync job reset for 11 PM daily...");
  // Runs at 23:00 every day
  cron.schedule("0 23 * * *", resetFailedSyncJobs);
}
