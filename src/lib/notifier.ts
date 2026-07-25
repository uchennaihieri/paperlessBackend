import { logger } from "./logger";
import prisma from "./prisma";
export const notifier = {
  send: async (options: {
    to: string;
    subject: string;
    message: string;
    link?: string;
  }) => {
    // Only send notifications to official FINCA emails
    if (!options.to.toLowerCase().endsWith("@fincanigeria.com")) {
      logger.info(`Teams notification skipped for ${options.to} (Not a fincanigeria.com email)`);
      return;
    }

    // In the future, this can be easily switched to "whatsapp" or "slack"
    const provider = process.env.NOTIFIER_PROVIDER || "teams";

    if (provider === "teams") {
      const url = process.env.NOTIFICATION_URL;
      const secret = process.env.NOTIFICATION_SECRET;
      
      if (!url || !secret) {
        logger.warn("Teams notification skipped: NOTIFICATION_URL or NOTIFICATION_SECRET is not set.");
        return;
      }

      try {
        const payload = {
          to: options.to,
          subject: options.subject,
          message: options.message,
          link: options.link || "",
          secret: secret,
        };

        const parsedUrl = new URL(url);
        const postData = JSON.stringify(payload);
        const reqOptions = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 443,
          path: parsedUrl.pathname + parsedUrl.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData)
          }
        };

        await new Promise<void>((resolve, reject) => {
          const https = require("https");
          const req = https.request(reqOptions, (res: any) => {
            let body = "";
            res.on("data", (chunk: any) => body += chunk);
            res.on("end", () => {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                logger.info(`Teams notification sent to ${options.to}`);
                resolve();
              } else {
                logger.error(`Teams notification to ${options.to} failed with status ${res.statusCode}: ${body}`);
                resolve(); // resolve rather than reject so we don't crash the workflow
              }
            });
          });

          req.on("error", (e: any) => {
            reject(e);
          });

          req.write(postData);
          req.end();
        });
      } catch (err) {
        logger.error(`Failed to process Teams notification for ${options.to}: ${err}`);
      }
    } else {
      logger.warn(`Notifier provider '${provider}' is not supported yet.`);
    }
  },

  /**
   * Looks up a user's notification preferences by email.
   * If Teams is enabled (defaulting to true), it sends the instant notification.
   */
  notifyInternalUser: async (options: {
    to: string;
    subject: string;
    message: string;
    link?: string;
  }) => {
    try {
      const user = await prisma.user.findFirst({
        where: { finca_email: { equals: options.to, mode: "insensitive" } },
        select: { notificationPreferences: true }
      });

      if (!user) return;

      const prefs = user.notificationPreferences as any;
      if (prefs?.channels?.teams !== false) {
        await notifier.send(options);
      }
    } catch (err) {
      logger.error(`Failed to look up preferences for internal user ${options.to}: ${err}`);
    }
  }
};
