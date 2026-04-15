import { Router, Request, Response } from "express";
import fs from "fs/promises";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";

const router = Router();
router.use(authenticate as any);

// ── GET /api/v1/file?id=<uploadedFileId> ─────────────────────────────────────
router.get("/", async (req: Request, res: Response) => {
  const id = req.query.id as string | undefined;
  if (!id) {
    res.status(400).send("File ID is required");
    return;
  }

  const record = await prisma.uploadedFile.findUnique({ where: { id } });
  if (!record) {
    res.status(404).send("File not found");
    return;
  }

  const fileBuffer = await fs.readFile(record.filePath);

  res.set({
    "Content-Type": record.mimeType || "application/octet-stream",
    "Content-Disposition": `inline; filename="${record.originalName}"`,
  });
  res.send(fileBuffer);
});

export default router;
