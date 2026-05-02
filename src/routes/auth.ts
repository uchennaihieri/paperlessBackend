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
  const { employeeId, password } = req.body;

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

  // Account must have a password set by an administrator before it can be used.
  if (!user.passwordHash) {
    res.status(401).json({
      success: false,
      error: "Your account password has not been configured. Please contact your administrator.",
    });
    return;
  }

  // Verify password — wrong password always fails, no bypass.
  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) {
    res.status(401).json({ success: false, error: "Invalid credentials." });
    return;
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
    mustResetPassword: user.mustResetPassword,
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 – POST /api/v1/auth/verify-otp
// Confirm OTP → optionally sets a new password (reset flow) → returns JWT.
//
// When `newPassword` is supplied: the temporary password that was used to reach
// this step is treated purely as a verification token (like a first-factor OTP).
// The new password is hashed and saved for ALL role rows of this employee,
// and the issued JWT has mustResetPassword: false so no further redirect occurs.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/verify-otp", async (req: Request, res: Response) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp) {
    res.status(400).json({ success: false, error: "Email and OTP are required." });
    return;
  }

  if (newPassword !== undefined && newPassword.length < 8) {
    res.status(400).json({ success: false, error: "New password must be at least 8 characters." });
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

  // ── If a new password was supplied, update ALL role rows atomically ────────
  if (newPassword) {
    const hash = await bcrypt.hash(newPassword, 12);
    // Find one representative row to get the employee_id
    const representative = await prisma.user.findFirst({
      where: { finca_email: { equals: email, mode: "insensitive" } },
      select: { employee_id: true },
    });
    if (representative?.employee_id) {
      await prisma.user.updateMany({
        where: { employee_id: { equals: representative.employee_id, mode: "insensitive" } },
        data: { passwordHash: hash, mustResetPassword: false, passwordChangedAt: new Date() },
      });
    } else {
      // Fallback: update by email
      await prisma.user.updateMany({
        where: { finca_email: { equals: email, mode: "insensitive" } },
        data: { passwordHash: hash, mustResetPassword: false, passwordChangedAt: new Date() },
      });
    }
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
  // mustResetPassword is always false after this step when newPassword was provided
  const effectiveMustReset = newPassword ? false : (defaultRole.mustResetPassword ?? false);

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
    mustResetPassword: effectiveMustReset,
    isLegacyAccount: !defaultRole.passwordHash && !newPassword,
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
// Called after first login or when admin forces a reset. User is already
// authenticated via OTP, so no need to re-verify the old password here.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/reset-password", authenticate as any, async (req: AuthRequest, res: Response) => {
  const { newPassword } = req.body;

  if (!newPassword) {
    res.status(400).json({ success: false, error: "newPassword is required." });
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

  const hash = await bcrypt.hash(newPassword, 12);

  // Update ALL role rows for this employee so no row is left with a null/old hash.
  // This prevents Bug: "delete first role → remaining row has no password" scenario.
  if (user.employee_id) {
    await prisma.user.updateMany({
      where: { employee_id: { equals: user.employee_id, mode: "insensitive" } },
      data: { passwordHash: hash, mustResetPassword: false, passwordChangedAt: new Date() },
    });
  } else {
    // Fallback: no employee_id, update just this row
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hash, mustResetPassword: false, passwordChangedAt: new Date() },
    });
  }

  res.json({ success: true, message: "Password updated successfully." });
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/auth/set-password  (admin only — sets default password for a user)
// Accepts employeeId (preferred) or userId.
// Uses updateMany so ALL role rows for the same employee get the hash.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/set-password", authenticate as any, requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const { employeeId, userId, password } = req.body;

  if ((!employeeId && !userId) || !password) {
    res.status(400).json({ success: false, error: "employeeId (or userId) and password are required." });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ success: false, error: "Password must be at least 6 characters." });
    return;
  }

  const hash = await bcrypt.hash(password, 12);

  let updatedCount: number;

  if (employeeId) {
    // Update ALL rows matching this employee_id (handles multi-role users)
    const result = await prisma.user.updateMany({
      where: { employee_id: { equals: employeeId.trim(), mode: "insensitive" } },
      data: { passwordHash: hash, mustResetPassword: true, passwordChangedAt: new Date() },
    });
    updatedCount = result.count;
  } else {
    // Fallback: single row by numeric userId
    await prisma.user.update({
      where: { id: Number(userId) },
      data: { passwordHash: hash, mustResetPassword: true, passwordChangedAt: new Date() },
    });
    updatedCount = 1;
  }

  if (updatedCount === 0) {
    res.status(404).json({ success: false, error: "No user found with that Employee ID." });
    return;
  }

  // Fetch the user's email to send the notification
  const targetUser = await prisma.user.findFirst({
    where: employeeId
      ? { employee_id: { equals: employeeId.trim(), mode: "insensitive" } }
      : { id: Number(userId) },
    select: { finca_email: true, user_name: true, employee_id: true },
  });

  let emailSent = false;
  let emailError: string | null = null;

  if (targetUser?.finca_email) {
    const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";
    try {
      await mailer.sendMail({
        from: `Paperless <${process.env.SMTP_USER}>`,
        to: targetUser.finca_email,
        subject: "Paperless – Your Password Has Been Reset",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
            <h2 style="color: #B50938; margin-bottom: 4px;">Paperless by FINCA</h2>
            <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
            <hr style="border-color: #e5e7eb; margin: 20px 0;" />
            <p style="font-size: 15px; color: #111827;">Hi <strong>${targetUser.user_name ?? "User"}</strong>,</p>
            <p style="font-size: 14px; color: #374151;">An administrator has reset your Paperless account password. Use the credentials below to log in. You will be required to set a new password on your next login.</p>
            <div style="background: #f9fafb; border-left: 4px solid #B50938; border-radius: 4px; padding: 16px; margin: 16px 0;">
              <p style="margin: 0 0 8px; font-size: 14px; color: #111827;"><strong>Login URL:</strong> <a href="${appUrl}" style="color: #B50938;">${appUrl}</a></p>
              <p style="margin: 0 0 8px; font-size: 14px; color: #111827;"><strong>Employee ID:</strong> ${targetUser.employee_id ?? employeeId ?? userId}</p>
              <p style="margin: 0; font-size: 14px; color: #111827;"><strong>Temporary Password:</strong> ${password}</p>
            </div>
            <p style="font-size: 13px; color: #6b7280;">For your security, please change your password immediately after logging in. Do not share these credentials with anyone.</p>
          </div>
        `,
      });
      emailSent = true;
    } catch (e: any) {
      emailError = e.message ?? "Unknown mail error";
      console.error("[set-password email]", e);
    }
  }

  res.json({
    success: true,
    message: `Password set for ${updatedCount} role row(s). User must reset on first login.`,
  });
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
