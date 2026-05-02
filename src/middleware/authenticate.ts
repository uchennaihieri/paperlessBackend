import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma";

export interface AuthRequest extends Request {
  user?: {
    id: number;
    email: string;
    user_name: string;
    user_role: string;
    branch: string | null;
    employee_id: string | null;
  };
}

/**
 * Verifies the Bearer JWT and attaches the decoded payload to req.user.
 * Also checks that the token was NOT issued before the user's last password change.
 * If the admin resets a user's password, any existing tokens are immediately invalidated.
 */
export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ success: false, error: "Missing or invalid Authorization header" });
    return;
  }

  const token = header.split(" ")[1];
  try {
    const secret = process.env.JWT_SECRET ?? "supersecretjwtkey";
    const payload = jwt.verify(token, secret) as any;

    // ── Password-change invalidation ──────────────────────────────────────────
    // If the user's password was changed after this token was issued, reject it.
    //
    // IMPORTANT: JWT `iat` is in whole seconds. `passwordChangedAt` is stored
    // with millisecond precision. We truncate to seconds before comparing so
    // a fresh token issued in the same second as the password update is NOT
    // falsely rejected (which would create an unbreakable login loop).
    if (payload.id) {
      const user = await prisma.user.findUnique({
        where: { id: Number(payload.id) },
        select: { passwordChangedAt: true },
      });
      if (user?.passwordChangedAt) {
        const pwChangedAtSec = Math.floor(user.passwordChangedAt.getTime() / 1000);
        if (payload.iat && pwChangedAtSec > payload.iat) {
          res.status(401).json({ success: false, error: "Session expired due to a password change. Please log in again.", code: "PASSWORD_CHANGED" });
          return;
        }
      }
    }

    req.user = payload;
    next();
  } catch {
    res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
}

/**
 * Gate that restricts a route to administrator-role users only.
 * Must be used after `authenticate`.
 */
export function requireAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.user?.user_role?.toLowerCase() !== "administrator") {
    res.status(403).json({ success: false, error: "Forbidden: Administrators only" });
    return;
  }
  next();
}
