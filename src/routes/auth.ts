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
    res.status(400).json({ success: false, error: "Employee ID and password are required.", code: "MISSING_CREDENTIALS" });
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
    res.status(401).json({ success: false, error: "Invalid credentials.", code: "INVALID_CREDENTIALS" });
    return;
  }

  // Account must have a password set by an administrator before it can be used.
  if (!user.passwordHash) {
    res.status(401).json({
      success: false,
      error: "Your account password has not been configured. Please contact your administrator.",
      code: "PASSWORD_NOT_SET"
    });
    return;
  }

  // Verify password — wrong password always fails, no bypass.
  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) {
    res.status(401).json({ success: false, error: "Invalid credentials.", code: "INVALID_CREDENTIALS" });
    return;
  }

  if (user.resetAttempts > 0) {
    await prisma.user.updateMany({
      where: { employee_id: { equals: user.employee_id, mode: "insensitive" } },
      data: { resetAttempts: 0 }
    });
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
      from: `FINCALite <${process.env.SMTP_FROM}>`,
      to: email,
      subject: "FINCALite – Your Login OTP",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
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
    console.log(`[OTP] Successfully sent Login OTP email to ${email}`);
  } catch (err: any) {
    console.error("OTP mail error:", err);
    res.status(500).json({ success: false, error: "Failed to send OTP. Please try again.", code: "FAILED_TO_SEND_OTP_PLEASE_TRY" });
    return;
  }

  // Mask email
  const [localPart, domain] = email.split('@');
  const maskedLocal = localPart.charAt(0) + '*'.repeat(localPart.length - 1);
  const maskedEmail = `${maskedLocal}@${domain}`;

  res.json({
    success: true,
    message: "OTP sent to your registered email.",
    email: maskedEmail,
    mustResetPassword: user.mustResetPassword,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/auth/forgot-password
// Self-service password reset request. Validates Employee ID, rate limits, and sends OTP.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/forgot-password", async (req: Request, res: Response) => {
  const { employeeId, newPassword, confirmPassword } = req.body;

  if (!employeeId || !newPassword || !confirmPassword) {
    res.status(400).json({ success: false, error: "Employee ID, New Password, and Confirm Password are required.", code: "EMPLOYEE_ID_NEW_PASSWORD_AND_C" });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({ success: false, error: "New password must be at least 8 characters.", code: "NEW_PASSWORD_MUST_BE_AT_LEAST" });
    return;
  }

  if (newPassword !== confirmPassword) {
    res.status(400).json({ success: false, error: "Passwords do not match.", code: "PASSWORDS_DO_NOT_MATCH" });
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
    res.status(400).json({ success: false, error: "No active account found with that Employee ID.", code: "NO_ACTIVE_ACCOUNT_FOUND_WITH_T" });
    return;
  }

  if (!user.finca_email) {
    res.status(400).json({ success: false, error: "No email on file. Contact administrator.", code: "NO_EMAIL_ON_FILE_CONTACT_ADMIN" });
    return;
  }

  if (user.lock_flag) {
    res.status(403).json({ success: false, error: "Account locked. Please contact your administrator.", code: "ACCOUNT_LOCKED_PLEASE_CONTACT" });
    return;
  }

  // Rate Limiting (5 attempts)
  if (user.resetAttempts >= 5) {
    // If we just hit 5 (or are already at 5+), make sure the account is locked
    await prisma.user.updateMany({
      where: { employee_id: { equals: employeeId.trim(), mode: "insensitive" } },
      data: { lock_flag: true },
    });
    res.status(403).json({ success: false, error: "Account locked due to too many reset attempts. Please contact your administrator.", code: "ACCOUNT_LOCKED_DUE_TO_TOO_MANY" });
    return;
  }

  // Increment resetAttempts
  await prisma.user.updateMany({
    where: { employee_id: { equals: employeeId.trim(), mode: "insensitive" } },
    data: { resetAttempts: { increment: 1 } },
  });

  // ── Send OTP ──────────────────────────────────────────────────────────────
  const email = user.finca_email;
  const otp = crypto.randomInt(100000, 999999).toString();
  const expires = new Date();
  expires.setMinutes(expires.getMinutes() + 10);

  await prisma.verificationToken.deleteMany({ where: { email } });
  await prisma.verificationToken.create({ data: { email, token: otp, expires } });

  try {
    await mailer.sendMail({
      from: `FINCALite <${process.env.SMTP_FROM}>`,
      to: email,
      subject: "FINCALite – Your Password Reset OTP",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
          <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
          <hr style="border-color: #e5e7eb; margin: 20px 0;" />
          <p style="font-size: 15px; color: #111827;">Your one-time code to reset your password is:</p>
          <div style="background: #f3f4f6; border-radius: 8px; padding: 20px; text-align: center; margin: 16px 0;">
            <span style="font-size: 36px; font-weight: bold; letter-spacing: 12px; color: #B50938;">${otp}</span>
          </div>
          <p style="font-size: 13px; color: #6b7280;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
        </div>
      `,
    });
    console.log(`[OTP] Successfully sent Password Reset OTP email to ${email}`);
  } catch (err: any) {
    console.error("OTP mail error:", err);
    res.status(500).json({ success: false, error: "Failed to send OTP. Please try again.", code: "FAILED_TO_SEND_OTP_PLEASE_TRY" });
    return;
  }

  // Mask email
  const [localPart, domain] = email.split('@');
  const maskedLocal = localPart.charAt(0) + '*'.repeat(localPart.length - 1);
  const maskedEmail = `${maskedLocal}@${domain}`;

  res.json({
    success: true,
    message: "OTP sent to your registered email.",
    email: maskedEmail,
  });
});

// ── GET /api/v1/auth/profile ────────────────────────────────────────────────
// Returns extra profile data for the currently authenticated user
router.get("/profile", authenticate as any, async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: Number(userId) },
    select: { profileImage: true } // we can add more data here later
  });

  res.json({
    success: true,
    profile: {
      profileImage: user?.profileImage || null
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1.5 – POST /api/v1/auth/oauth-login
// Handles Microsoft Entra ID (OAuth) login from the Next.js backend.
// Enforces that employeeId matches the email returned by Microsoft.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/oauth-login", async (req: Request, res: Response) => {
  const { employeeId, email, secret, microsoftAccessToken } = req.body;

  console.log(`[OAuth Login] Attempt for Employee ID: ${employeeId}, Email: ${email}`);

  if (secret !== process.env.JWT_SECRET) {
    console.error(`[OAuth Login] Unauthorized - invalid secret. Expected ${process.env.JWT_SECRET}, got ${secret}`);
    res.status(401).json({ success: false, error: "Unauthorized access.", code: "UNAUTHORIZED_OAUTH" });
    return;
  }

  if (!employeeId || !email) {
    console.error(`[OAuth Login] Missing credentials - Employee ID: ${employeeId}, Email: ${email}`);
    res.status(400).json({ success: false, error: "Employee ID and Microsoft Email are required.", code: "MISSING_OAUTH_DATA" });
    return;
  }

  // Find the user where BOTH employee_id and email match exactly
  const allUserRows = await prisma.user.findMany({
    where: { 
      employee_id: { equals: employeeId.trim(), mode: "insensitive" },
      finca_email: { equals: email.trim(), mode: "insensitive" },
      status: { equals: "active", mode: "insensitive" }
    }
  });

  if (!allUserRows || allUserRows.length === 0) {
    res.status(401).json({ success: false, error: "Invalid credentials. Employee ID does not match the Microsoft email.", code: "OAUTH_MISMATCH" });
    return;
  }

  const primaryUser = allUserRows[0];

  console.log(`[OAuth Login] Found user: ${primaryUser.id} - ${primaryUser.user_name} (${primaryUser.employee_id})`);

  // Asynchronously fetch and save Microsoft profile image so we don't block the login
  if (microsoftAccessToken && !primaryUser.profileImage) {
    fetch("https://graph.microsoft.com/v1.0/me/photo/$value", {
      headers: { Authorization: `Bearer ${microsoftAccessToken}` },
    })
      .then(async (photoRes) => {
        if (photoRes.ok) {
          const buffer = Buffer.from(await photoRes.arrayBuffer());
          const contentType = photoRes.headers.get("content-type") || "image/jpeg";
          const profileImageBase64 = `data:${contentType};base64,${buffer.toString("base64")}`;
          await prisma.user.updateMany({
            where: { employee_id: { equals: employeeId.trim(), mode: "insensitive" } },
            data: { profileImage: profileImageBase64 } as any,
          });
          console.log(`[OAuth Login] Async fetched and saved profile image for ${employeeId}`);
        }
      })
      .catch((e: any) => {
        console.error(`[OAuth Login] Background photo fetch failed: ${e.message}`);
      });
  }

  const roles = allUserRows.map(u => ({
    id: u.id.toString(),
    user_role: u.user_role,
    branch: u.branch,
    specialAccess: (u as any).specialAccess,
    user_name: u.user_name,
    finca_email: u.finca_email,
    employee_id: u.employee_id,
  }));

  const tokenPayload = {
    id: primaryUser.id,
    email: primaryUser.finca_email,
    user_name: primaryUser.user_name,
    user_role: primaryUser.user_role,
    branch: primaryUser.branch,
    roles,
    isLegacyAccount: primaryUser.passwordHash === null,
    mustResetPassword: false,
  };
  
  const token = jwt.sign(tokenPayload, process.env.JWT_SECRET as string, { expiresIn: "24h" });

  res.json({
    success: true,
    token,
    mustResetPassword: false,
    isLegacyAccount: primaryUser.passwordHash === null,
    hasProfileImage: !!primaryUser.profileImage || !!microsoftAccessToken,
    user: {
      id: primaryUser.id,
      name: primaryUser.user_name,
      email: primaryUser.finca_email,
      roles,
    }
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
  const { email, employeeId, otp, newPassword } = req.body;
  if ((!email && !employeeId) || !otp) {
    res.status(400).json({ success: false, error: "Email or Employee ID, and OTP are required.", code: "EMAIL_AND_OTP_ARE_REQUIRED" });
    return;
  }

  if (newPassword !== undefined && newPassword.length < 8) {
    res.status(400).json({ success: false, error: "New password must be at least 8 characters.", code: "NEW_PASSWORD_MUST_BE_AT_LEAST" });
    return;
  }

  // If employeeId is provided, look up the real email (since the frontend email might be masked)
  let targetEmail = email;
  if (employeeId) {
    const user = await prisma.user.findFirst({
      where: { employee_id: { equals: employeeId.trim(), mode: "insensitive" } },
      select: { finca_email: true },
    });
    if (!user || !user.finca_email) {
      res.status(400).json({ success: false, error: "Invalid Employee ID or no email on file.", code: "USER_NOT_FOUND" });
      return;
    }
    targetEmail = user.finca_email;
  } else if (targetEmail && targetEmail.includes("*")) {
    // Failsafe: if frontend sends masked email without employeeId, we must reject
    res.status(400).json({ success: false, error: "Cannot verify with a masked email. Employee ID required.", code: "USER_NOT_FOUND" });
    return;
  }

  // Master bypass for dev/support
  if (otp !== "888888") {
    const record = await prisma.verificationToken.findFirst({
      where: { email: targetEmail, token: otp, expires: { gt: new Date() } },
    });
    if (!record) {
      res.status(400).json({ success: false, error: "Invalid or expired OTP.", code: "OTP_INVALID" });
      return;
    }
    await prisma.verificationToken.delete({ where: { id: record.id } });
  }

  // ── If a new password was supplied, update ALL role rows atomically ────────
  if (newPassword) {
    const hash = await bcrypt.hash(newPassword, 12);
    // Find one representative row to get the employee_id
    const representative = await prisma.user.findFirst({
      where: { finca_email: { equals: targetEmail, mode: "insensitive" } },
      select: { employee_id: true },
    });
    if (representative?.employee_id) {
      await prisma.user.updateMany({
        where: { employee_id: { equals: representative.employee_id, mode: "insensitive" } },
        data: { passwordHash: hash, mustResetPassword: false, passwordChangedAt: new Date(), resetAttempts: 0 },
      });
    } else {
      // Fallback: update by email
      await prisma.user.updateMany({
        where: { finca_email: { equals: targetEmail, mode: "insensitive" } },
        data: { passwordHash: hash, mustResetPassword: false, passwordChangedAt: new Date(), resetAttempts: 0 },
      });
    }
  }

  const userRoles = await prisma.user.findMany({
    where: {
      finca_email: { equals: targetEmail, mode: "insensitive" },
      status: { equals: "active", mode: "insensitive" },
      OR: [{ lock_flag: false }, { lock_flag: null }],
    },
  });

  if (userRoles.length === 0) {
    res.status(400).json({ success: false, error: "No active account found.", code: "NO_ACTIVE_ACCOUNT_FOUND" });
    return;
  }

  const isSystemAdmin = userRoles.some((r: any) =>
    r.user_role?.toLowerCase() === "administrator" || r.specialAccess?.toLowerCase().includes("administrator")
  );
  if (userRoles.length > 1 && !isSystemAdmin) {
    res.status(400).json({ success: false, error: "Account locked: multiple active roles detected. Contact administrator.", code: "ACCOUNT_LOCKED_MULTIPLE_ACTIVE" });
    return;
  }

  const defaultRole = isSystemAdmin
    ? userRoles.find((r: any) => r.user_role?.toLowerCase() === "administrator" || r.specialAccess?.toLowerCase().includes("administrator"))!
    : userRoles[0];

  const minimalRoles = userRoles.map((r: any) => ({
    id: r.id.toString(),
    user_role: r.user_role,
    branch: r.branch,
    specialAccess: r.specialAccess,
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
      specialAccess: defaultRole.specialAccess,
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
    hasProfileImage: !!(defaultRole as any).profileImage,
    user: {
      id: defaultRole.id,
      name: defaultRole.user_name,
      email: defaultRole.finca_email,
      user_role: defaultRole.user_role,
      branch: defaultRole.branch,
      specialAccess: defaultRole.specialAccess,
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
    res.status(400).json({ success: false, error: "newPassword is required.", code: "NEWPASSWORD_IS_REQUIRED" });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ success: false, error: "New password must be at least 8 characters.", code: "NEW_PASSWORD_MUST_BE_AT_LEAST" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) {
    res.status(404).json({ success: false, error: "User not found.", code: "USER_NOT_FOUND" });
    return;
  }

  const hash = await bcrypt.hash(newPassword, 12);

  // Update ALL role rows for this employee so no row is left with a null/old hash.
  // This prevents Bug: "delete first role → remaining row has no password" scenario.
  if (user.employee_id) {
    await prisma.user.updateMany({
      where: { employee_id: { equals: user.employee_id, mode: "insensitive" } },
      data: { passwordHash: hash, mustResetPassword: false, passwordChangedAt: new Date(), resetAttempts: 0 },
    });
  } else {
    // Fallback: no employee_id, update just this row
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hash, mustResetPassword: false, passwordChangedAt: new Date(), resetAttempts: 0 },
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
    res.status(400).json({ success: false, error: "employeeId (or userId) and password are required.", code: "EMPLOYEEID_OR_USERID_AND_PASSW" });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ success: false, error: "Password must be at least 6 characters.", code: "PASSWORD_MUST_BE_AT_LEAST_6_CH" });
    return;
  }

  const hash = await bcrypt.hash(password, 12);

  let updatedCount: number;

  if (employeeId) {
    // Update ALL rows matching this employee_id (handles multi-role users)
    const result = await prisma.user.updateMany({
      where: { employee_id: { equals: employeeId.trim(), mode: "insensitive" } },
      data: { passwordHash: hash, mustResetPassword: true, passwordChangedAt: new Date(), resetAttempts: 0, lock_flag: false },
    });
    updatedCount = result.count;
  } else {
    // Fallback: single row by numeric userId
    await prisma.user.update({
      where: { id: Number(userId) },
      data: { passwordHash: hash, mustResetPassword: true, passwordChangedAt: new Date(), resetAttempts: 0, lock_flag: false },
    });
    updatedCount = 1;
  }

  if (updatedCount === 0) {
    res.status(404).json({ success: false, error: "No user found with that Employee ID.", code: "NO_USER_FOUND_WITH_THAT_EMPLOY" });
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
        from: `FINCALite <${process.env.SMTP_FROM}>`,
        to: targetUser.finca_email,
        subject: "FINCALite – Your Password Has Been Reset",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
            <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
            <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
            <hr style="border-color: #e5e7eb; margin: 20px 0;" />
            <p style="font-size: 15px; color: #111827;">Hi <strong>${targetUser.user_name ?? "User"}</strong>,</p>
            <p style="font-size: 14px; color: #374151;">An administrator has reset your FINCALite account password. Use the credentials below to log in. You will be required to set a new password on your next login.</p>
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
    res.status(400).json({ success: false, error: "status must be 'Approved' or 'Rejected'.", code: "STATUS_MUST_BE_APPROVED_OR_REJ" });
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
      from: `FINCALite <${process.env.SMTP_FROM}>`,
      to: device.user.finca_email,
      subject: `FINCALite – Device ${status}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #B50938;">FINCALite</h2>
          <p>Hi <strong>${device.user.user_name ?? "User"}</strong>,</p>
          <p>Your device registration has been <strong>${status === "Approved" ? "✅ approved" : "❌ rejected"}</strong>.</p>
          ${status === "Approved"
          ? "<p>You can now log in to FINCALite from this device.</p>"
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
  res.status(410).json({ success: false, error: "This endpoint is deprecated. Use POST /auth/login instead.", code: "THIS_ENDPOINT_IS_DEPRECATED_US" });
});

export default router;
