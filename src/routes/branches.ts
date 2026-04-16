import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";

const router = Router();
router.use(authenticate as any);

// ── GET /api/v1/branches ──────────────────────────────────────────────────────
// Returns all distinct branch values from the users table.
// Frontend prepends { id: "ALL", name: "All Branches" } for dropdowns.
router.get("/", async (_req, res: Response) => {
  const rows = await prisma.user.findMany({
    where: {
      branch: { not: null },
      status: { equals: "active", mode: "insensitive" },
    },
    select: { branch: true },
    distinct: ["branch"],
    orderBy: { branch: "asc" },
  });

  const branches = rows
    .map((r: any) => r.branch as string)
    .filter(Boolean)
    .map((b: string) => ({ id: b, name: b }));

  res.json({ success: true, data: branches });
});

export default router;
