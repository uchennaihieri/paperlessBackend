import cron from "node-cron";
import prisma from "../lib/prisma";
import { logger } from "../lib/logger";

export async function resetFailedSyncJobs() {
  logger.info("Running daily 11 PM sync job reset...");
  try {
    const result = await prisma.sharepointSyncQueue.updateMany({
      where: {
        status: "Pending",
        attempts: { gte: 3 }
      },
      data: {
        attempts: 0
      }
    });
    logger.info(`Reset ${result.count} failed sync jobs to retry.`);
  } catch (err) {
    logger.error("Error resetting failed sync jobs: " + (err as Error).message);
  }
}

export function startFailedSyncCron() {
  logger.info("Scheduling failed sync job reset for 11 PM daily...");
  // Runs at 23:00 every day
  cron.schedule("0 23 * * *", resetFailedSyncJobs);
}
