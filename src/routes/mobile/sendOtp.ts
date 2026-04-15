import { Router, Request, Response } from "express";
import prisma from "../../lib/prisma";
import { mailer } from "../../lib/mailer";
import crypto from "crypto";

const router = Router();

// POST /api/v1/mobile/auth/send-otp
router.post("/", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ success: false, error: "Email required" });
    return;
  }

  const users = await prisma.user.findMany({
    where: {
      finca_email: { equals: email, mode: "insensitive" },
      status: { equals: "active", mode: "insensitive" },
    },
  });

  if (users.length === 0) {
    res.status(400).json({ success: false, error: "No active user found with this email." });
    return;
  }

  const otp = crypto.randomInt(100000, 999999).toString();
  const expires = new Date();
  expires.setMinutes(expires.getMinutes() + 10);

  await prisma.verificationToken.deleteMany({ where: { email } });
  await prisma.verificationToken.create({ data: { email, token: otp, expires } });

  await mailer.sendMail({
    from: `Paperless <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Paperless – Your Login OTP",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px;">
        <h2 style="color:#B50938;margin-bottom:4px;">Paperless by FINCA</h2>
        <p style="color:#6b7280;font-size:14px;margin-top:0;">Operations Platform</p>
        <hr style="border-color:#e5e7eb;margin:20px 0;" />
        <p style="font-size:15px;color:#111827;">Your one-time login code is:</p>
        <div style="background:#f3f4f6;border-radius:8px;padding:20px;text-align:center;margin:16px 0;">
          <span style="font-size:36px;font-weight:bold;letter-spacing:12px;color:#B50938;">${otp}</span>
        </div>
        <p style="font-size:13px;color:#6b7280;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
      </div>`,
  });

  res.json({ success: true, message: "OTP sent successfully" });
});

export default router;
