import prisma from "./prisma";
import { logger } from "./logger";

/** Default notification preferences — must match security.ts GET endpoint */
const DEFAULT_PREFS = {
  channels: { email: true, teams: true },
  patterns: {
    onSubmitForm: false,
    onToSign: true,
    onFinalApprover: false,
    onMyFormSigned: false,
    onMyFormProcessing: false,
    onCompleted: true,
    onBusinessUnitTreat: false,
    onDeclined: true,
  },
};

export type NotificationPattern = keyof typeof DEFAULT_PREFS.patterns;

/**
 * Check whether a notification should be sent to a given email address,
 * based on the user's notificationPreferences.
 *
 * @param email   Recipient email address
 * @param channel "email" | "teams"
 * @param pattern The notification event type (e.g. "onToSign", "onDeclined")
 * @returns true if the notification should be sent
 */
async function shouldNotify(
  email: string,
  channel: "email" | "teams",
  pattern?: NotificationPattern,
): Promise<boolean> {
  // If no pattern specified, always send (backward-compatible for unclassified notifications)
  if (!pattern) return true;

  try {
    const user = await prisma.user.findFirst({
      where: { finca_email: { equals: email, mode: "insensitive" } },
      select: { notificationPreferences: true },
    });

    // No user found → external user, always send
    if (!user) return true;

    const stored = user.notificationPreferences as any;

    // Merge stored preferences with defaults
    const channels = { ...DEFAULT_PREFS.channels, ...(stored?.channels || {}) };
    const patterns = { ...DEFAULT_PREFS.patterns, ...(stored?.patterns || {}) };

    // Check channel-level toggle
    if (channels[channel] === false) return false;

    // Check pattern-level toggle
    if (patterns[pattern] === false) return false;

    return true;
  } catch (err) {
    logger.error(`Failed to check notification preferences for ${email}: ${(err as Error).message}`);
    // On error, default to sending
    return true;
  }
}

/**
 * Queue an email notification for background delivery.
 * Inserts a row into NotificationQueue and returns immediately.
 *
 * If `pattern` is provided, the user's notification preferences are checked
 * before queuing. If the user has disabled this pattern or the email channel,
 * the notification is silently skipped.
 */
export async function queueEmail(options: {
  from?: string;
  to: string | string[];
  subject: string;
  html: string;
  pattern?: NotificationPattern;
  attachments?: Array<{ filename?: string; content?: string | Buffer; path?: string }>;
}): Promise<void> {
  try {
    // Check preferences for single-recipient emails with a pattern
    if (options.pattern && typeof options.to === "string") {
      const allowed = await shouldNotify(options.to, "email", options.pattern);
      if (!allowed) {
        logger.info(`Email skipped for ${options.to} (pattern: ${options.pattern}, preference disabled)`);
        return;
      }
    }

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
 *
 * If `pattern` is provided, the user's notification preferences are checked
 * before queuing.
 */
export async function queueTeams(options: {
  to: string;
  subject: string;
  message: string;
  link?: string;
  pattern?: NotificationPattern;
}): Promise<void> {
  // Only queue Teams notifications to official FINCA emails
  if (!options.to.toLowerCase().endsWith("@fincanigeria.com")) {
    logger.info(`Teams notification queuing skipped for ${options.to} (Not a fincanigeria.com email)`);
    return;
  }

  // Check preferences
  if (options.pattern) {
    const allowed = await shouldNotify(options.to, "teams", options.pattern);
    if (!allowed) {
      logger.info(`Teams skipped for ${options.to} (pattern: ${options.pattern}, preference disabled)`);
      return;
    }
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
 * Respects the user's notificationPreferences for both channels and patterns.
 */
export async function queueNotification(options: {
  to: string;
  subject: string;
  message: string;
  html: string;
  link?: string;
  from?: string;
  pattern?: NotificationPattern;
}): Promise<void> {
  // Queue email (preference check happens inside queueEmail)
  await queueEmail({
    from: options.from,
    to: options.to,
    subject: options.subject,
    html: options.html,
    pattern: options.pattern,
  });

  // Queue Teams (preference check happens inside queueTeams)
  await queueTeams({
    to: options.to,
    subject: options.subject,
    message: options.message,
    link: options.link,
    pattern: options.pattern,
  });
}
