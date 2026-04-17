import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/authenticate";

const router = Router();
router.use(authenticate as any);

// ── POST /api/v1/upload — DISABLED ───────────────────────────────────────────
// File uploads are no longer accepted as a separate step.
// Files must be attached directly when submitting a form via POST /submissions.
// This ensures files are only stored once a form is actually submitted, and
// are organised under: uploads/{FORM NAME}/{REFERENCE}/{filename}
router.post("/", (_req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    error:
      "Direct file uploads are no longer supported. " +
      "Attach files as part of POST /api/v1/submissions using multipart/form-data.",
  });
});

export default router;
