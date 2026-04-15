import { Router, Request, Response } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma";
import { mailer } from "../lib/mailer";

const router = Router();

// ── POST /api/v1/auth/send-otp ───────────────────────────────────────────────
router.post("/send-otp", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ success: false, error: "Email is required" });
    return;
  }

  // Verify the user exists and is active
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

  // Generate OTP
  const otp = crypto.randomInt(100000, 999999).toString();
  const expires = new Date();
  expires.setMinutes(expires.getMinutes() + 10);

  // Clean up old OTPs then store the new one
  await prisma.verificationToken.deleteMany({ where: { email } });
  await prisma.verificationToken.create({ data: { email, token: otp, expires } });

  // Send email

  try {
    await mailer.sendMail({
      from: `Paperless <${process.env.SMTP_USER}>`,
      to: email,
      subject: "Paperless – Your Login OTP",
      html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
        <h2 style="color: #B50938; margin-bottom: 4px;">Paperless by FINCA</h2>
        <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
        <hr style="border-color: #e5e7eb; margin: 20px 0;" />
        <p style="font-size: 15px; color: #111827;">Your one-time login code is:</p>
        <div style="background: #f3f4f6; border-radius: 8px; padding: 20px; text-align: center; margin: 16px 0;">
          <span style="font-size: 36px; font-weight: bold; letter-spacing: 12px; color: #B50938;">${otp}</span>
        </div>
        <p style="font-size: 13px; color: #6b7280;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
      </div>
    `,
    });
    // await mailer.sendMail({
    //   from: `Paperless <${process.env.SMTP_USER}>`,
    //   to: email,
    //   subject: "Paperless – Your Login OTP",
    //   html: `...`,
    // });
  } catch (err: any) {
    console.error("MAIL ERROR FULL:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Mail failed",
    });
  }



  res.json({ success: true, message: "OTP sent successfully" });
});

// ── POST /api/v1/auth/verify-otp ─────────────────────────────────────────────
router.post("/verify-otp", async (req: Request, res: Response) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    res.status(400).json({ success: false, error: "Email and OTP are required" });
    return;
  }

  // Master OTP bypass (dev / support only)
  if (otp !== "888888") {
    const record = await prisma.verificationToken.findFirst({
      where: { email, token: otp, expires: { gt: new Date() } },
    });
    if (!record) {
      res.status(400).json({ success: false, error: "Invalid or expired OTP" });
      return;
    }
    await prisma.verificationToken.delete({ where: { id: record.id } });
  }

  const userRoles = await prisma.user.findMany({
    where: {
      finca_email: { equals: email, mode: "insensitive" },
      status: { equals: "active", mode: "insensitive" },
      OR: [{ lock_flag: false }, { lock_flag: null }],
    },
  });

  if (userRoles.length === 0) {
    res.status(400).json({ success: false, error: "No active account found" });
    return;
  }

  const isSystemAdmin = userRoles.some((r: any) => r.user_role?.toLowerCase() === "administrator");
  if (userRoles.length > 1 && !isSystemAdmin) {
    res.status(400).json({
      success: false,
      error: "Account locked: Multiple active roles detected. Please contact administrator.",
    });
    return;
  }

  const defaultRole = userRoles[0];
  const minimalRoles = userRoles.map((r: any) => ({
    id: r.id.toString(),
    user_role: r.user_role,
    branch: r.branch,
    user_name: r.user_name,
    finca_email: r.finca_email,
    employee_id: r.employee_id,
  }));

  // Issue a JWT
  const secret = process.env.JWT_SECRET ?? "supersecretjwtkey";
  const token = jwt.sign(
    {
      id: defaultRole.id,
      email: defaultRole.finca_email,
      user_name: defaultRole.user_name,
      user_role: defaultRole.user_role,
      branch: defaultRole.branch,
      employee_id: defaultRole.employee_id,
      roles: minimalRoles,
      activeRoleId: defaultRole.id.toString(),
    },
    secret,
    { expiresIn: "7d" }
  );

  res.json({
    success: true,
    token,
    user: {
      id: defaultRole.id,
      name: defaultRole.user_name,
      email: defaultRole.finca_email,
      user_role: defaultRole.user_role,
      branch: defaultRole.branch,
      roles: minimalRoles,
    },
  });
});

export default router;
