import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { encrypt, decrypt, hashToken } from "../lib/crypto";

const router = Router();
router.use(authenticate as any);

// ── POST /api/v1/security/register ───────────────────────────────────────────
// Register/update a new 8-char security token + encrypted signature blob
router.post("/register", async (req: AuthRequest, res: Response) => {
  const userEmail = req.user?.email;
  if (!userEmail) { res.status(401).json({ success: false, error: "Not logged in", code: "NOT_LOGGED_IN" }); return; }

  const { token, signatureBlob } = req.body;

  if (!token || token.length < 8) {
    res.status(400).json({ success: false, error: "Token must be at least 8 characters long.", code: "TOKEN_MUST_BE_AT_LEAST_8_CHARA" });
    return;
  }
  if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[0-9]/.test(token)) {
    res.status(400).json({ success: false, error: "Token must contain at least one uppercase letter, one lowercase letter, and one number.", code: "TOKEN_MUST_CONTAIN_AT_LEAST_ON" });
    return;
  }

  if (!signatureBlob) {
    res.status(400).json({ success: false, error: "Signature blob is required.", code: "SIGNATURE_BLOB_IS_REQUIRED" });
    return;
  }

  const hashedToken = hashToken(token);
  const encryptedSignature = encrypt(signatureBlob);

  await prisma.securityData.upsert({
    where: { userEmail },
    update: { hashedToken, encryptedSignature },
    create: { userEmail, hashedToken, encryptedSignature },
  });

  res.json({ success: true });
});

// ── POST /api/v1/security/verify-token ───────────────────────────────────────
// Verify a given token and return the decrypted signature if valid
router.post("/verify-token", async (req: AuthRequest, res: Response) => {
  const userEmail = req.user?.email;
  if (!userEmail) { res.status(401).json({ success: false, error: "Not logged in", code: "NOT_LOGGED_IN" }); return; }

  const { token } = req.body;
  const hashedInput = hashToken(token);
  const data = await prisma.securityData.findFirst({
    where: { userEmail: { equals: userEmail, mode: "insensitive" } },
  });

  if (!data) {
    res.status(404).json({ success: false, error: "No security signature token found for your account.", code: "NO_SECURITY_SIGNATURE_TOKEN_FO" });
    return;
  }
  if (data.hashedToken !== hashedInput) {
    res.status(400).json({ success: false, error: "Invalid signature token.", code: "INVALID_SIGNATURE_TOKEN" });
    return;
  }

  const rawSignature = decrypt(data.encryptedSignature);
  res.json({ success: true, signatureData: rawSignature });
});

// ── GET /api/v1/security/my-signature ────────────────────────────────────────
router.get("/my-signature", async (req: AuthRequest, res: Response) => {
  const userEmail = req.user?.email;
  if (!userEmail) { res.status(401).json({ success: false, error: "Not logged in", code: "NOT_LOGGED_IN" }); return; }

  const data = await prisma.securityData.findFirst({
    where: { userEmail: { equals: userEmail, mode: "insensitive" } },
  });
  if (!data) { res.status(404).json({ success: false, error: "No signature configured yet.", code: "NO_SIGNATURE_CONFIGURED_YET" }); return; }

  const rawSignature = decrypt(data.encryptedSignature);
  res.json({ success: true, signatureData: rawSignature });
});

// ── GET /api/v1/security/notification-preferences ─────────────────────────────
router.get("/notification-preferences", async (req: AuthRequest, res: Response) => {
  const userEmail = req.user?.email;
  if (!userEmail) { res.status(401).json({ success: false, error: "Not logged in", code: "NOT_LOGGED_IN" }); return; }

  const user = await prisma.user.findFirst({
    where: { finca_email: { equals: userEmail, mode: "insensitive" } }
  });

  if (!user) {
    res.status(404).json({ success: false, error: "User not found", code: "USER_NOT_FOUND" });
    return;
  }

  const defaultPrefs = {
    channels: { email: true, teams: false },
    patterns: {
      onSubmitForm: false,
      onToSign: true,
      onFinalApprover: false,
      onMyFormSigned: false,
      onMyFormProcessing: false,
      onCompleted: true,
      onBusinessUnitTreat: false,
      onDeclined: true
    }
  };

  const currentPrefs = user.notificationPreferences as any || {};
  
  const mergedPrefs = {
    channels: { ...defaultPrefs.channels, ...(currentPrefs.channels || {}) },
    patterns: { ...defaultPrefs.patterns, ...(currentPrefs.patterns || {}) }
  };

  res.json({ success: true, preferences: mergedPrefs });
});

// ── POST /api/v1/security/notification-preferences ────────────────────────────
router.post("/notification-preferences", async (req: AuthRequest, res: Response) => {
  const userEmail = req.user?.email;
  if (!userEmail) { res.status(401).json({ success: false, error: "Not logged in", code: "NOT_LOGGED_IN" }); return; }

  const { preferences } = req.body;
  if (!preferences) {
    res.status(400).json({ success: false, error: "Missing preferences payload", code: "MISSING_PREFERENCES_PAYLOAD" });
    return;
  }

  await prisma.user.updateMany({
    where: { finca_email: { equals: userEmail, mode: "insensitive" } },
    data: { notificationPreferences: preferences }
  });

  res.json({ success: true });
});

export default router;
