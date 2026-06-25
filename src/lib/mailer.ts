import { Resend } from "resend";
import nodemailer from "nodemailer";

const provider = process.env.MAILER_PROVIDER || "resend"; // "resend" or "nodemailer"
const resend = new Resend(process.env.RESEND_API_KEY);

const nodemailerTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? "smtp.zoho.com",
  port: Number(process.env.SMTP_PORT ?? 465),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
  },
});

export const mailer = {
  sendMail: async (options: {
    from?: string;
    to: string | string[];
    subject: string;
    html: string;
    attachments?: Array<{ filename?: string; content?: string | Buffer; path?: string }>;
  }) => {
    // Sanitize 'from' field to prevent "FINCALite <undefined>"
    let from = options.from;
    const defaultEmail = process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@example.com";
    
    if (!from || from.includes("undefined")) {
      from = `FINCALite <${defaultEmail}>`;
    }

    if (provider === "resend") {
      const { data, error } = await resend.emails.send({
        from,
        // Resend handles an array of strings natively for multiple recipients
        to: Array.isArray(options.to) ? options.to : [options.to],
        subject: options.subject,
        html: options.html,
        attachments: options.attachments,
      });

      if (error) {
        throw new Error(error.message);
      }

      return data;
    } else {
      const info = await nodemailerTransport.sendMail({
        from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        attachments: options.attachments,
      });
      return info;
    }
  },
};

