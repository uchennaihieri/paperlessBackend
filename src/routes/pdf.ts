import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/authenticate";
import { generateSubmissionPdf } from "../lib/pdfGenerator";

const router = Router();
router.use(authenticate as any);

// ── GET /api/v1/pdf?id=<submissionId>&action=print|download ──────────────────
router.get("/", async (req: Request, res: Response) => {
  const id = req.query.id as string | undefined;
  const action = req.query.action as string | undefined;

  if (!id) {
    res.status(400).json({ error: "Missing submission ID" });
    return;
  }

  const pdfResult = await generateSubmissionPdf(id);

  if (!pdfResult) {
    res.status(404).json({ error: "Submission not found or could not generate PDF" });
    return;
  }

  const disposition =
    action === "print" ? `inline; filename="${pdfResult.filename}"` : `attachment; filename="${pdfResult.filename}"`;

  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": disposition,
  });
  res.send(pdfResult.buffer);
});

export default router;
