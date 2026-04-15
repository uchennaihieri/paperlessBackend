import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, requireAdmin, AuthRequest } from "../middleware/authenticate";

const router = Router();

// All form-template endpoints require a valid session
router.use(authenticate as any);

// ── GET /api/v1/forms ─────────────────────────────────────────────────────────
router.get("/", async (_req, res: Response) => {
  const templates = await prisma.formTemplate.findMany({ orderBy: { createdAt: "asc" } });
  res.json({ success: true, data: templates });
});

// ── GET /api/v1/forms/branches ────────────────────────────────────────────────
router.get("/branches", async (_req, res: Response) => {
  const rows = await prisma.user.findMany({
    where: { branch: { not: null }, status: { equals: "active", mode: "insensitive" } },
    select: { branch: true },
    distinct: ["branch"],
    orderBy: { branch: "asc" },
  });
  const branches = rows.map((r) => r.branch!).filter(Boolean);
  res.json({ success: true, data: branches });
});

// ── GET /api/v1/forms/search-users ───────────────────────────────────────────
router.get("/search-users", async (req, res: Response) => {
  const query = (req.query.q ?? "") as string;
  if (!query || query.length < 2) {
    res.json({ success: true, data: [] });
    return;
  }
  const users = await prisma.user.findMany({
    where: {
      status: { equals: "active", mode: "insensitive" },
      OR: [
        { user_name: { contains: query, mode: "insensitive" } },
        { finca_email: { contains: query, mode: "insensitive" } },
      ],
    },
    select: { id: true, user_name: true, finca_email: true, branch: true, user_role: true },
    take: 15,
  });
  res.json({ success: true, data: users });
});

// ── GET /api/v1/forms/:id ──────────────────────────────────────────────────────
router.get("/:id", async (req, res: Response) => {
  const template = await prisma.formTemplate.findUnique({ where: { id: req.params.id } });
  if (!template) {
    res.status(404).json({ success: false, error: "Form template not found" });
    return;
  }
  res.json({ success: true, data: template });
});

// ── POST /api/v1/forms ─────────────────────────────────────────────────────────
router.post("/", requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const { name, description, fields, formOwner, formTreater, htmlTemplate } = req.body;
  try {
    const template = await prisma.formTemplate.create({
      data: {
        name,
        description,
        fields,
        formOwner: formOwner ?? null,
        formTreater: formTreater ?? null,
        htmlTemplate: htmlTemplate ?? null,
      },
    });
    res.status(201).json({ success: true, data: template });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ success: false, error: "A form with this name already exists." });
    } else {
      throw err;
    }
  }
});

// ── PATCH /api/v1/forms/:id ───────────────────────────────────────────────────
router.patch("/:id", requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const { name, description, fields, formOwner, formTreater, htmlTemplate } = req.body;
  try {
    const template = await prisma.formTemplate.update({
      where: { id: req.params.id },
      data: {
        name,
        description,
        fields,
        formOwner: formOwner ?? null,
        formTreater: formTreater ?? null,
        htmlTemplate: htmlTemplate ?? null,
      },
    });
    res.json({ success: true, data: template });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ success: false, error: "A form with this name already exists." });
    } else {
      throw err;
    }
  }
});

// ── DELETE /api/v1/forms/:id ──────────────────────────────────────────────────
router.delete("/:id", requireAdmin as any, async (req, res: Response) => {
  await prisma.formTemplate.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

export default router;
