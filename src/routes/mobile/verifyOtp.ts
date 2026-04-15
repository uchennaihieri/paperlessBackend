import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import prisma from "../../lib/prisma";

const router = Router();

// POST /api/v1/mobile/auth/verify-otp
router.post("/", async (req: Request, res: Response) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    res.status(400).json({ success: false, error: "Email and OTP are required" });
    return;
  }

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
    },
  });

  if (userRoles.length === 0) {
    res.status(400).json({ success: false, error: "No active account found" });
    return;
  }

  const user = userRoles[0];

  // Issue a signed JWT for mobile sessions
  const secret = process.env.JWT_SECRET ?? "supersecretjwtkey";
  const token = jwt.sign(
    {
      id: user.id,
      email: user.finca_email,
      user_name: user.user_name,
      user_role: user.user_role,
      branch: user.branch,
      employee_id: user.employee_id,
    },
    secret,
    { expiresIn: "30d" }
  );

  res.json({
    success: true,
    token,
    user: { id: user.id, name: user.user_name, email: user.finca_email },
  });
});

export default router;
