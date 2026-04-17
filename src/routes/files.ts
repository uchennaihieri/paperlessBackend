import { Router, Request, Response } from "express";
import fs from "fs/promises";
import prisma from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";
import { isSharePointEnabled, downloadFromSharePoint } from "../lib/sharepoint";

const router = Router();
router.use(authenticate as any);

// ── GET /api/v1/file ──────────────────────────────────────────────────────────
// Serves a file by either:
//   ?docId=<submissionDocumentId>  ← new (preferred) — structured SharePoint path
//   ?id=<uploadedFileId>           ← legacy — original UploadedFile records
router.get("/", async (req: Request, res: Response) => {
  const docId = req.query.docId as string | undefined;
  const legacyId = req.query.id as string | undefined;

  if (!docId && !legacyId) {
    res.status(400).send("File ID is required. Use ?docId=<id> or ?id=<id>");
    return;
  }

  // ── New path: SubmissionDocument record ─────────────────────────────────────
  if (docId) {
    const doc = await prisma.submissionDocument.findUnique({ where: { id: docId } });
    if (!doc) { res.status(404).send("Document not found"); return; }

    res.set({
      "Content-Type":        doc.mimeType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${doc.originalName}"`,
    });

    if (isSharePointEnabled()) {
      try {
        const { buffer } = await downloadFromSharePoint(doc.filePath);
        res.send(buffer);
      } catch (err) {
        console.error("SharePoint download error:", err);
        res.status(500).send("Failed to retrieve file from SharePoint.");
      }
    } else {
      try {
        const buffer = await fs.readFile(doc.filePath);
        res.send(buffer);
      } catch {
        res.status(404).send("File not found on disk.");
      }
    }
    return;
  }

  // ── Legacy path: UploadedFile record (backward compat) ──────────────────────
  const record = await prisma.uploadedFile.findUnique({ where: { id: legacyId! } });
  if (!record) { res.status(404).send("File not found"); return; }

  res.set({
    "Content-Type":        record.mimeType || "application/octet-stream",
    "Content-Disposition": `inline; filename="${record.originalName}"`,
  });

  if (isSharePointEnabled()) {
    try {
      const { buffer } = await downloadFromSharePoint(record.filePath);
      res.send(buffer);
    } catch (err) {
      console.error("SharePoint download error (legacy):", err);
      res.status(500).send("Failed to retrieve file from SharePoint.");
    }
  } else {
    try {
      const buffer = await fs.readFile(record.filePath);
      res.send(buffer);
    } catch {
      res.status(404).send("File not found on disk.");
    }
  }
});

export default router;
