import { Resend } from "resend";

// ── Resend mailer ─────────────────────────────────────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);

export const mailer = {
  sendMail: async (options: {
    from: string;
    to: string;
    subject: string;
    html: string;
  }) => {
    const { data, error } = await resend.emails.send({
      from: 'resend',
      to: options.to,
      subject: options.subject,
      html: options.html,
    });

    if (error) {
      throw new Error(error.message);
    }

    return data;
  },
};

// ── Nodemailer (commented out) ────────────────────────────────────────────────
// import nodemailer from "nodemailer";
//
// export const mailer = nodemailer.createTransport({
//   host: process.env.SMTP_HOST ?? "smtp.zoho.com",
//   port: Number(process.env.SMTP_PORT ?? 465),
//   secure: process.env.SMTP_SECURE === "true",
//   auth: {
//     user: process.env.SMTP_USER ?? "",
//     pass: process.env.SMTP_PASS ?? "",
//   },
// });
