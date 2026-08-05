import prisma from "./prisma";
import { logger } from "./logger";

/**
 * Queue an email notification for background delivery.
 * Inserts a row into NotificationQueue and returns immediately.
 */
export async function queueEmail(options: {
  from?: string;
  to: string | string[];
  subject: string;
  html: string;
  attachments?: Array<{ filename?: string; content?: string | Buffer; path?: string }>;
}): Promise<void> {
  try {
    await prisma.notificationQueue.create({
      data: {
        channel: "EMAIL",
        payload: {
          from: options.from ?? `FINCALite <${process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "noreply@paperless.ng"}>`,
          to: options.to,
          subject: options.subject,
          html: options.html,
          ...(options.attachments ? { attachments: options.attachments } : {}),
        },
        status: "PENDING",
        attempts: 0,
      },
    });
  } catch (err) {
    logger.error(`Failed to queue email notification: ${(err as Error).message}`);
  }
}

/**
 * Queue a Teams notification for background delivery.
 * Inserts a row into NotificationQueue and returns immediately.
 */
export async function queueTeams(options: {
  to: string;
  subject: string;
  message: string;
  link?: string;
}): Promise<void> {
  // Only queue Teams notifications to official FINCA emails
  if (!options.to.toLowerCase().endsWith("@fincanigeria.com")) {
    logger.info(`Teams notification queuing skipped for ${options.to} (Not a fincanigeria.com email)`);
    return;
  }

  try {
    await prisma.notificationQueue.create({
      data: {
        channel: "TEAMS",
        payload: {
          to: options.to,
          subject: options.subject,
          message: options.message,
          link: options.link ?? "",
        },
        status: "PENDING",
        attempts: 0,
      },
    });
  } catch (err) {
    logger.error(`Failed to queue Teams notification: ${(err as Error).message}`);
  }
}

/**
 * Convenience: queue both an email and a Teams notification for an internal user.
 * Respects the user's notificationPreferences (Teams defaults to true).
 */
export async function queueNotification(options: {
  to: string;
  subject: string;
  message: string;
  html: string;
  link?: string;
  from?: string;
}): Promise<void> {
  // Always queue the email
  await queueEmail({
    from: options.from,
    to: options.to,
    subject: options.subject,
    html: options.html,
  });

  // Check user Teams preference before queuing Teams notification
  try {
    const user = await prisma.user.findFirst({
      where: { finca_email: { equals: options.to, mode: "insensitive" } },
      select: { notificationPreferences: true },
    });

    if (!user) return;

    const prefs = user.notificationPreferences as any;
    if (prefs?.channels?.teams !== false) {
      await queueTeams({
        to: options.to,
        subject: options.subject,
        message: options.message,
        link: options.link,
      });
    }
  } catch (err) {
    logger.error(`Failed to check Teams preferences for ${options.to}: ${(err as Error).message}`);
  }
}
