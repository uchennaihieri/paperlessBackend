import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/authenticate";

const router = Router();
router.use(authenticate as any, requireAdmin as any);

// ── GET /api/v1/lookup?type=role|branch|specialAccess ─────────────────────────
// Returns all lookup values for a given type, merged with dynamic values
// derived from existing user records so nothing is missed.
router.get("/", async (req, res: Response) => {
  const type = req.query.type as string;
  if (!type) {
    res.status(400).json({ success: false, error: "type query parameter is required" });
    return;
  }

  // Values stored explicitly in the lookup table
  const stored = await prisma.lookupValue.findMany({
    where: { type },
    orderBy: { value: "asc" },
    select: { value: true },
  });

  // Dynamically derive values from existing user rows so we never miss historic entries
  let dynamic: string[] = [];
  if (type === "role") {
    const rows = await prisma.user.findMany({ select: { user_role: true }, distinct: ["user_role"] });
    dynamic = rows.map(r => r.user_role).filter(Boolean) as string[];
  } else if (type === "branch") {
    const rows = await prisma.user.findMany({ select: { branch: true }, distinct: ["branch"] });
    dynamic = rows.map(r => r.branch).filter(Boolean) as string[];
  } else if (type === "specialAccess") {
    const rows = await prisma.user.findMany({ select: { specialAccess: true }, distinct: ["specialAccess"] });
    dynamic = rows.map(r => r.specialAccess).filter(Boolean) as string[];
  }

  // Merge stored + dynamic, de-duplicate, sort
  const merged = Array.from(new Set([...stored.map(s => s.value), ...dynamic])).sort();
  res.json({ success: true, data: merged });
});

// ── POST /api/v1/lookup ────────────────────────────────────────────────────────
// Upsert a custom value into the lookup table for a given type.
router.post("/", async (req: AuthRequest, res: Response) => {
  const { type, value } = req.body as { type: string; value: string };
  if (!type || !value?.trim()) {
    res.status(400).json({ success: false, error: "type and value are required" });
    return;
  }

  await prisma.lookupValue.upsert({
    where: { type_value: { type, value: value.trim() } },
    update: {},
    create: { type, value: value.trim() },
  });

  res.json({ success: true });
});

export default router;
