import { Router, Request, Response } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma";
import { mailer } from "../lib/mailer";
import { authenticate, AuthRequest, requireAdmin } from "../middleware/authenticate";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 – POST /api/v1/auth/login
// Employee ID + password → sends OTP to email.
// Also handles device-ID check: if deviceId is supplied and not approved, blocks login.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/login", async (req: Request, res: Response) => {
  const { employeeId, password, deviceId, deviceName } = req.body;

  if (!employeeId || !password) {
    res.status(400).json({ success: false, error: "Employee ID and password are required." });
    return;
  }

  // Find the user by employee_id
  const user = await prisma.user.findFirst({
    where: {
      employee_id: { equals: employeeId.trim(), mode: "insensitive" },
      status: { equals: "active", mode: "insensitive" },
    },
  });

  if (!user) {
    res.status(401).json({ success: false, error: "Invalid credentials." });
    return;
  }

  // Verify password
  // If no passwordHash exists yet (legacy account), let them through and force a reset.
  // This avoids locking out users created before the password system was introduced.
  let skipPasswordCheck = false;
  if (!user.passwordHash) {
    skipPasswordCheck = true;
  } else {
    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      res.status(401).json({ success: false, error: "Invalid credentials." });
      return;
    }
  }

  // ── Device check ──────────────────────────────────────────────────────────
  if (deviceId) {
    const existing = await prisma.deviceRegistration.findUnique({
      where: { userId_deviceId: { userId: user.id, deviceId } },
    });

    if (!existing) {
      // Register as Pending
      await prisma.deviceRegistration.create({
        data: { userId: user.id, deviceId, deviceName: deviceName ?? null },
      });
      res.status(403).json({
        success: false,
        code: "DEVICE_PENDING",
        error: "This device has been submitted for approval. You will be able to log in once an administrator approves it.",
      });
      return;
    }

    if (existing.status === "Pending") {
      res.status(403).json({
        success: false,
        code: "DEVICE_PENDING",
        error: "Your device is awaiting administrator approval.",
      });
      return;
    }

    if (existing.status === "Rejected") {
      res.status(403).json({
        success: false,
        code: "DEVICE_REJECTED",
        error: "This device has been rejected by an administrator. Contact your administrator.",
      });
      return;
    }
    // status === "Approved" → continue
  }

  // ── Send OTP ──────────────────────────────────────────────────────────────
  const email = user.finca_email!;
  const otp = crypto.randomInt(100000, 999999).toString();
  const expires = new Date();
  expires.setMinutes(expires.getMinutes() + 10);

  await prisma.verificationToken.deleteMany({ where: { email } });
  await prisma.verificationToken.create({ data: { email, token: otp, expires } });

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
  } catch (err: any) {
    console.error("OTP mail error:", err);
    res.status(500).json({ success: false, error: "Failed to send OTP. Please try again." });
    return;
  }

  res.json({
    success: true,
    message: "OTP sent to your registered email.",
    email,
    mustResetPassword: skipPasswordCheck || user.mustResetPassword,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 – POST /api/v1/auth/verify-otp
// Confirm OTP → returns JWT (with mustResetPassword flag in response).
// ─────────────────────────────────────────────────────────────────────────────
router.post("/verify-otp", async (req: Request, res: Response) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    res.status(400).json({ success: false, error: "Email and OTP are required." });
    return;
  }

  // Master bypass for dev/support
  if (otp !== "888888") {
    const record = await prisma.verificationToken.findFirst({
      where: { email, token: otp, expires: { gt: new Date() } },
    });
    if (!record) {
      res.status(400).json({ success: false, error: "Invalid or expired OTP." });
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
    res.status(400).json({ success: false, error: "No active account found." });
    return;
  }

  const isSystemAdmin = userRoles.some((r: any) => r.user_role?.toLowerCase() === "administrator");
  if (userRoles.length > 1 && !isSystemAdmin) {
    res.status(400).json({ success: false, error: "Account locked: multiple active roles detected. Contact administrator." });
    return;
  }

  const defaultRole = isSystemAdmin
    ? userRoles.find((r: any) => r.user_role?.toLowerCase() === "administrator")!
    : userRoles[0];

  const minimalRoles = userRoles.map((r: any) => ({
    id: r.id.toString(),
    user_role: r.user_role,
    branch: r.branch,
    user_name: r.user_name,
    finca_email: r.finca_email,
    employee_id: r.employee_id,
  }));

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
    mustResetPassword: defaultRole.mustResetPassword,
    isLegacyAccount: !defaultRole.passwordHash, // true if account has no password set yet
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

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 – POST /api/v1/auth/reset-password
// Required on first login. Authenticated route.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/reset-password", authenticate as any, async (req: AuthRequest, res: Response) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    res.status(400).json({ success: false, error: "currentPassword and newPassword are required." });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ success: false, error: "New password must be at least 8 characters." });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) {
    res.status(404).json({ success: false, error: "User not found." });
    return;
  }

  // Legacy accounts (no passwordHash yet) arrived here via OTP — skip current-password check.
  // Any account that already has a password must verify it before changing.
  if (user.passwordHash) {
    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) {
      res.status(400).json({ success: false, error: "Current password is incorrect." });
      return;
    }
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: hash, mustResetPassword: false, passwordChangedAt: new Date() },
  });

  res.json({ success: true, message: "Password updated successfully." });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/auth/set-password  (admin only — sets default password for a user)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/set-password", authenticate as any, requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const { userId, password } = req.body;
  if (!userId || !password) {
    res.status(400).json({ success: false, error: "userId and password are required." });
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  await prisma.user.update({
    where: { id: Number(userId) },
    data: { passwordHash: hash, mustResetPassword: true, passwordChangedAt: new Date() },
  });

  res.json({ success: true, message: "Default password set. User must reset on first login." });
});

// ─────────────────────────────────────────────────────────────────────────────
// Device Management (admin)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/v1/auth/devices  — list all pending/all devices (admin)
router.get("/devices", authenticate as any, requireAdmin as any, async (_req: AuthRequest, res: Response) => {
  const devices = await prisma.deviceRegistration.findMany({
    orderBy: { registeredAt: "desc" },
    include: { user: { select: { user_name: true, finca_email: true, employee_id: true, branch: true } } },
  });
  res.json({ success: true, data: devices });
});

// PATCH /api/v1/auth/devices/:id  — approve or reject a device (admin)
router.patch("/devices/:id", authenticate as any, requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const { status } = req.body; // "Approved" | "Rejected"
  if (!["Approved", "Rejected"].includes(status)) {
    res.status(400).json({ success: false, error: "status must be 'Approved' or 'Rejected'." });
    return;
  }

  const device = await prisma.deviceRegistration.update({
    where: { id: req.params.id },
    data: {
      status,
      approvedBy: req.user?.email ?? "admin",
      approvedAt: new Date(),
    },
    include: { user: { select: { finca_email: true, user_name: true } } },
  });

  // Notify user of decision
  if (device.user.finca_email) {
    mailer.sendMail({
      from: `Paperless <${process.env.SMTP_USER}>`,
      to: device.user.finca_email,
      subject: `Paperless – Device ${status}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #B50938;">Paperless by FINCA</h2>
          <p>Hi <strong>${device.user.user_name ?? "User"}</strong>,</p>
          <p>Your device registration has been <strong>${status === "Approved" ? "✅ approved" : "❌ rejected"}</strong>.</p>
          ${status === "Approved"
            ? "<p>You can now log in to Paperless from this device.</p>"
            : "<p>Contact your administrator if you believe this is a mistake.</p>"
          }
        </div>
      `,
    }).catch((e: any) => console.error("[device email]", e));
  }

  res.json({ success: true, data: device });
});

// Legacy email-based OTP (kept for backward compatibility if needed)
router.post("/send-otp", async (req: Request, res: Response) => {
  res.status(410).json({ success: false, error: "This endpoint is deprecated. Use POST /auth/login instead." });
});

export default router;
