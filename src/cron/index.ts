import { startEventCron } from "./eventCron";
import { startFailedSyncCron } from "./failedSyncCron";
import { logger } from "../lib/logger";

export function startAllCrons() {
  logger.info("Starting all cron jobs...");
  startEventCron();
  startFailedSyncCron();
}
