import { Router, Response } from "express";
import { authenticate, requireAdmin, type AuthRequest } from "../middleware/authenticate";
import prisma from "../lib/prisma";

const router = Router();

// ── GET /api/v1/app-version ───────────────────────────────────────────────────
// Public (authenticated users): returns the latest published app version
router.get("/", authenticate as any, async (_req, res: Response) => {
  const latest = await prisma.appVersion.findFirst({
    orderBy: { publishedAt: "desc" },
    select: {
      id: true,
      version: true,
      downloadUrl: true,
      releaseNotes: true,
      publishedAt: true,
    },
  });
  res.json({ success: true, data: latest ?? null });
});

// ── PUT /api/v1/app-version ───────────────────────────────────────────────────
// Admin-only: publish a new app version (upsert — creates or updates the single record)
router.put("/", authenticate as any, requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const { version, downloadUrl, releaseNotes } = req.body;

  if (!version) {
    res.status(400).json({ success: false, error: "version is required" });
    return;
  }

  const record = await prisma.appVersion.create({
    data: {
      version,
      downloadUrl: downloadUrl ?? "",  // not used for delivery; streaming endpoint is the source of truth
      releaseNotes: releaseNotes ?? null,
      publishedBy: req.user!.email,
    },
  });

  res.json({ success: true, data: record });
});

// ── GET /api/v1/app-version/history ──────────────────────────────────────────
// Admin-only: return all published versions (most recent first)
router.get("/history", authenticate as any, requireAdmin as any, async (_req, res: Response) => {
  const versions = await prisma.appVersion.findMany({
    orderBy: { publishedAt: "desc" },
    take: 20,
  });
  res.json({ success: true, data: versions });
});

export default router;
