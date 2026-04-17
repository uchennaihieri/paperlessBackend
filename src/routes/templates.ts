import { Router, Request, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";
import { downloadFromSharePoint } from "../lib/sharepoint";

const router = Router();
router.use(authenticate as any);

// GET /api/v1/templates
router.get("/", async (_req: Request, res: Response) => {
  const templates = await prisma.pdfTemplate.findMany({
    orderBy: { createdAt: "desc" },
  });
  res.json({ success: true, data: templates });
});

// POST /api/v1/templates
router.post("/", async (req: Request, res: Response) => {
  const { name, sharepointPath } = req.body;
  if (!name || !sharepointPath) {
    res.status(400).json({ success: false, error: "name and sharepointPath are required" });
    return;
  }
  try {
    const template = await prisma.pdfTemplate.create({
      data: { name, sharepointPath },
    });
    res.status(201).json({ success: true, data: template });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ success: false, error: "Template with this name already exists" });
    } else {
      res.status(500).json({ success: false, error: "Internal Server Error" });
    }
  }
});

// GET /api/v1/templates/:id
router.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const template = await prisma.pdfTemplate.findUnique({
    where: { id },
    include: { fields: true },
  });
  if (!template) {
    res.status(404).json({ success: false, error: "Template not found" });
    return;
  }
  res.json({ success: true, data: template });
});

// DELETE /api/v1/templates/:id
router.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.pdfTemplate.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to delete template" });
  }
});

// GET /api/v1/templates/:id/file
router.get("/:id/file", async (req: Request, res: Response) => {
  const { id } = req.params;
  const template = await prisma.pdfTemplate.findUnique({ where: { id } });
  if (!template) {
    res.status(404).json({ success: false, error: "Template not found" });
    return;
  }
  
  try {
    const { buffer, mimeType } = await downloadFromSharePoint(template.sharepointPath);
    res.set({
      "Content-Type": "application/pdf",
      "Cache-Control": "public, max-age=300" // 5 mins cache
    });
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/v1/templates/:id/fields
router.get("/:id/fields", async (req: Request, res: Response) => {
  const { id } = req.params;
  const fields = await prisma.pdfTemplateField.findMany({ where: { templateId: id } });
  res.json({ success: true, data: fields });
});

// POST /api/v1/templates/:id/fields
router.post("/:id/fields", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, type, page, x, y, width, height } = req.body;
  
  try {
    const field = await prisma.pdfTemplateField.create({
      data: {
        templateId: id,
        name,
        type,
        page: page ?? 0,
        x, y, width, height
      }
    });
    res.status(201).json({ success: true, data: field });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to create field" });
  }
});

// PUT /api/v1/templates/:id/fields/:fid
router.put("/:id/fields/:fid", async (req: Request, res: Response) => {
  const { fid } = req.params;
  const { name, type, page, x, y, width, height } = req.body;
  
  try {
    const field = await prisma.pdfTemplateField.update({
      where: { id: fid },
      data: { name, type, page, x, y, width, height }
    });
    res.json({ success: true, data: field });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to update field" });
  }
});

// DELETE /api/v1/templates/:id/fields/:fid
router.delete("/:id/fields/:fid", async (req: Request, res: Response) => {
  const { fid } = req.params;
  try {
    await prisma.pdfTemplateField.delete({ where: { id: fid } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to delete field" });
  }
});

export default router;
