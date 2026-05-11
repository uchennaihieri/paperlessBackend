import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { hashToken } from "../lib/crypto";
import { isSharePointEnabled, uploadToSharePoint } from "../lib/sharepoint";
import { generateContractPdf, getContractPreviewHtml } from "../lib/pdfGenerator";

const router = Router();
router.use(authenticate as any);

// ── GET /api/v1/contracts/pending ──────────────────────────────────────────
// Fetch pending contracts for the logged-in user
router.get("/pending", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email;
  if (!email) {
    res.status(401).json({ success: false, error: "Not logged in" });
    return;
  }

  try {
    const contracts = await prisma.contractRequest.findMany({
      where: {
        submitterEmail: { equals: email, mode: "insensitive" },
        status: "Pending",
      },
      include: {
        submission: {
          select: {
            reference: true,
            formName: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, contracts });
  } catch (error: any) {
    console.error("Failed to fetch pending contracts:", error);
    res.status(500).json({ success: false, error: "Failed to fetch pending contracts." });
  }
});

// ── GET /api/v1/contracts/:id/preview ─────────────────────────────────────────
// Get the HTML preview of the contract
router.get("/:id/preview", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email;
  if (!email) {
    res.status(401).json({ success: false, error: "Not logged in" });
    return;
  }

  try {
    const contract = await prisma.contractRequest.findUnique({
      where: { id: req.params.id }
    });

    if (!contract) {
      res.status(404).json({ success: false, error: "Contract not found." });
      return;
    }

    if (contract.submitterEmail.toLowerCase() !== email.toLowerCase()) {
      res.status(403).json({ success: false, error: "Not authorized to view this contract." });
      return;
    }

    const html = await getContractPreviewHtml(contract.id);
    if (!html) {
      res.status(500).json({ success: false, error: "Failed to generate contract preview." });
      return;
    }

    res.json({ success: true, html });
  } catch (error: any) {
    console.error("Failed to generate preview:", error);
    res.status(500).json({ success: false, error: "An error occurred while generating the preview." });
  }
});

// ── POST /api/v1/contracts/:id/sign ──────────────────────────────────────────
// Sign a pending contract request securely
router.post("/:id/sign", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email;
  if (!email) {
    res.status(401).json({ success: false, error: "Not logged in" });
    return;
  }

  const { drawnSignatureBase64, selfieBase64 } = req.body;
  if (!drawnSignatureBase64 || !selfieBase64) {
    res.status(400).json({ success: false, error: "Signature and selfie are required." });
    return;
  }

  try {
    const contract = await prisma.contractRequest.findUnique({
      where: { id: req.params.id },
      include: {
        submission: {
          select: { reference: true, formName: true }
        }
      }
    });

    if (!contract || contract.status !== "Pending") {
      res.status(400).json({ success: false, error: "Contract not found or already signed." });
      return;
    }

    if (contract.submitterEmail.toLowerCase() !== email.toLowerCase()) {
      res.status(403).json({ success: false, error: "Not authorized to sign this contract." });
      return;
    }

    // Generate Contract PDF with new base64 parameters
    const pdfResult = await generateContractPdf(contract.id, drawnSignatureBase64, selfieBase64);
    if (!pdfResult) {
      res.status(500).json({ success: false, error: "Failed to generate contract PDF." });
      return;
    }

    let storedPath = "";
    if (isSharePointEnabled()) {
      const formFolder = contract.submission.formName.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase();
      const refFolder = contract.submission.reference?.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase() || contract.submissionId.slice(-6).toUpperCase();
      storedPath = await uploadToSharePoint(
        pdfResult.buffer,
        pdfResult.filename,
        "application/pdf",
        `uploads/${formFolder}/${refFolder}/Contracts`
      );
    }

    if (storedPath) {
      await prisma.submissionDocument.create({
        data: {
          submissionId: contract.submissionId,
          fieldName: "SignedContract",
          originalName: pdfResult.filename,
          filePath: storedPath,
          mimeType: "application/pdf",
          size: pdfResult.buffer.length,
        },
      });
    }

    // Update contract status
    await prisma.contractRequest.update({
      where: { id: contract.id },
      data: {
        status: "Signed",
        signedAt: new Date(),
        signatureToken: "3_STEP_WIZARD", // Placeholder to indicate token was replaced by 3-step wizard
        pdfPath: storedPath,
      },
    });

    res.json({ success: true, message: "Contract signed successfully." });
  } catch (error: any) {
    console.error("Failed to sign contract:", error);
    res.status(500).json({ success: false, error: "An error occurred while signing the contract." });
  }
});

export default router;
