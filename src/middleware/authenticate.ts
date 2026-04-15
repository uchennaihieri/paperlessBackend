import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

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
 * The JWT is issued by the /api/v1/mobile/auth/verify-otp endpoint.
 */
export function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ success: false, error: "Missing or invalid Authorization header" });
    return;
  }

  const token = header.split(" ")[1];
  try {
    const secret = process.env.JWT_SECRET ?? "supersecretjwtkey";
    const payload = jwt.verify(token, secret) as any;
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
