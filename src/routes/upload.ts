import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "C:\\Users\\USER\\uploads";

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

const router = Router();
router.use(authenticate as any);

// ── POST /api/v1/upload ───────────────────────────────────────────────────────
router.post("/", upload.array("files"), async (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[];
  if (!files || files.length === 0) {
    res.status(400).json({ success: false, error: "No files received." });
    return;
  }

  const savedNames: string[] = [];
  for (const file of files) {
    await prisma.uploadedFile.create({
      data: {
        fileName: file.filename,
        originalName: file.originalname,
        filePath: path.join(UPLOAD_DIR, file.filename),
        size: file.size,
        mimeType: file.mimetype || "application/octet-stream",
      },
    });
    savedNames.push(file.filename);
  }

  res.json({ success: true, files: savedNames });
});

export default router;
