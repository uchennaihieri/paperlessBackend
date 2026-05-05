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
  if (!userEmail) { res.status(401).json({ success: false, error: "Not logged in" }); return; }

  const { token, signatureBlob } = req.body;
  
  if (!token || token.length < 8) {
    res.status(400).json({ success: false, error: "Token must be at least 8 characters long." });
    return;
  }
  if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[0-9]/.test(token)) {
    res.status(400).json({ success: false, error: "Token must contain at least one uppercase letter, one lowercase letter, and one number." });
    return;
  }

  if (!signatureBlob) {
    res.status(400).json({ success: false, error: "Signature blob is required." });
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
  if (!userEmail) { res.status(401).json({ success: false, error: "Not logged in" }); return; }

  const { token } = req.body;
  const hashedInput = hashToken(token);
  const data = await prisma.securityData.findFirst({
    where: { userEmail: { equals: userEmail, mode: "insensitive" } },
  });

  if (!data) {
    res.status(404).json({ success: false, error: "No security signature token found for your account." });
    return;
  }
  if (data.hashedToken !== hashedInput) {
    res.status(400).json({ success: false, error: "Invalid signature token." });
    return;
  }

  const rawSignature = decrypt(data.encryptedSignature);
  res.json({ success: true, signatureData: rawSignature });
});

// ── GET /api/v1/security/my-signature ────────────────────────────────────────
router.get("/my-signature", async (req: AuthRequest, res: Response) => {
  const userEmail = req.user?.email;
  if (!userEmail) { res.status(401).json({ success: false, error: "Not logged in" }); return; }

  const data = await prisma.securityData.findFirst({
    where: { userEmail: { equals: userEmail, mode: "insensitive" } },
  });
  if (!data) { res.status(404).json({ success: false, error: "No signature configured yet." }); return; }

  const rawSignature = decrypt(data.encryptedSignature);
  res.json({ success: true, signatureData: rawSignature });
});

export default router;
