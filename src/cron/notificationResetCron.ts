import cron from "node-cron";
import prisma from "../lib/prisma";
import { logger } from "../lib/logger";

const MAX_RETRY_DAYS = 3;

export async function resetFailedNotifications() {
  logger.info("Running daily 11 PM notification retry reset...");
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - MAX_RETRY_DAYS);

    // 1. Permanently fail jobs older than cutoff
    const failedResult = await prisma.notificationQueue.updateMany({
      where: {
        status: "PENDING",
        attempts: { gte: 3 },
        createdAt: { lt: cutoffDate },
      },
      data: {
        status: "FAILED",
      },
    });
    if (failedResult.count > 0) {
      logger.info(`Marked ${failedResult.count} notifications as permanently FAILED (older than ${MAX_RETRY_DAYS} days).`);
    }

    // 2. Reset recent jobs
    const resetResult = await prisma.notificationQueue.updateMany({
      where: {
        status: "PENDING",
        attempts: { gte: 3 },
        createdAt: { gte: cutoffDate },
      },
      data: {
        attempts: 0,
      },
    });
    logger.info(`Reset ${resetResult.count} failed notifications to retry.`);
  } catch (err) {
    logger.error("Error resetting failed notifications: " + (err as Error).message);
  }
}

export function startNotificationResetCron() {
  logger.info("Scheduling notification retry reset for 11 PM daily...");
  // Runs at 23:00 every day
  cron.schedule("0 23 * * *", resetFailedNotifications);
}
