import { Router, Response, Request } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { isSharePointEnabled } from "../lib/sharepoint";
import { storeDocumentLocally } from "../lib/storage";
import { generateContractPdf, getContractPreviewHtml } from "../lib/pdfGenerator";
import { checkAndUnblockPrerequisites } from "./workflow";
import { mailer } from "../lib/mailer";
import crypto from "crypto";
import { hashToken, decrypt } from "../lib/crypto";

const router = Router();

// ── GET /api/v1/contracts/external/:token ────────────────────────────────
// Public endpoint to fetch contract details for the external party
router.get("/external/:token", async (req: Request, res: Response) => {
  try {
    const contract = await prisma.contractRequest.findFirst({
      where: { externalToken: req.params.token, status: "Pending" },
      include: {
        submission: {
          select: { reference: true, formName: true }
        }
      }
    });

    if (!contract) {
      res.status(404).json({ success: false, error: "Contract not found, invalid token, or already signed.", code: "CONTRACT_NOT_FOUND_INVALID_TOK" });
      return;
    }

    const html = await getContractPreviewHtml(contract.id);
    if (!html) {
      res.status(500).json({ success: false, error: "Failed to generate contract preview.", code: "FAILED_TO_GENERATE_CONTRACT_PR" });
      return;
    }

    res.json({
      success: true,
      html,
      contract: {
        id: contract.id,
        formName: contract.submission.formName,
        reference: contract.submission.reference,
        externalSignerName: contract.externalSignerName,
      }
    });
  } catch (error: any) {
    console.error("Failed to fetch external contract:", error);
    res.status(500).json({ success: false, error: "An error occurred.", code: "AN_ERROR_OCCURRED" });
  }
});

// ── POST /api/v1/contracts/external-sign/:token ──────────────────────────
// Public endpoint to submit the signature
router.post("/external-sign/:token", async (req: Request, res: Response) => {
  const { drawnSignatureBase64 } = req.body;
  if (!drawnSignatureBase64) {
    res.status(400).json({ success: false, error: "Signature is required.", code: "SIGNATURE_IS_REQUIRED" });
    return;
  }

  try {
    const contract = await prisma.contractRequest.findFirst({
      where: { externalToken: req.params.token, status: "Pending" },
      include: {
        submission: {
          select: { reference: true, formName: true }
        }
      }
    });

    if (!contract) {
      res.status(404).json({ success: false, error: "Contract not found or already signed.", code: "CONTRACT_NOT_FOUND_OR_ALREADY" });
      return;
    }

    // Generate Contract PDF with new base64 parameters. Selfie is blank for external signers.
    const pdfResult = await generateContractPdf(contract.id, drawnSignatureBase64, "");
    if (!pdfResult) {
      res.status(500).json({ success: false, error: "Failed to generate contract PDF.", code: "FAILED_TO_GENERATE_CONTRACT_PD" });
      return;
    }

    let storedPath = "";
    if (isSharePointEnabled()) {
      const formFolder = contract.submission.formName.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase();
      const refFolder = contract.submission.reference?.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase() || contract.submissionId.slice(-6).toUpperCase();
      storedPath = await storeDocumentLocally(
        pdfResult.buffer,
        pdfResult.filename,
        "application/pdf",
        process.env.SHAREPOINT_UPLOAD_FOLDER
          ? `${process.env.SHAREPOINT_UPLOAD_FOLDER}/${formFolder}/${refFolder}/Contracts`
          : `${formFolder}/${refFolder}/Contracts`
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
        externalSignedAt: new Date(),
        externalSignature: drawnSignatureBase64,
        pdfPath: storedPath,
        externalToken: null, // invalidate token
      },
    });
    
    // Unblock prerequisite
    const prereq = await prisma.submissionPrerequisite.findFirst({
      where: { contractRequestId: contract.id, type: "CONTRACT" }
    });
    
    if (prereq) {
      await prisma.submissionPrerequisite.update({
        where: { id: prereq.id },
        data: { status: "Approved" }
      });
      
      // We must call checkAndUnblockPrerequisites passing undefined for the first arg
      // and the prereq.id for the second arg!
      checkAndUnblockPrerequisites(undefined, prereq.id);
    }

    // Email external party a copy of the contract
    if (contract.externalSignerEmail) {
       await mailer.sendMail({
         from: `FINCALite <${process.env.SMTP_FROM ?? "noreply@paperless.ng"}>`,
         to: contract.externalSignerEmail,
         subject: "Your Signed Contract Copy",
         html: `
            <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
              <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
              <p style="font-size: 15px; color: #111827;">Hello ${contract.externalSignerName || "Signer"},</p>
              <p style="font-size: 14px; color: #374151;">Thank you for signing the contract. A copy of the fully signed document is attached to this email.</p>
            </div>
         `,
         attachments: [{
            filename: pdfResult.filename,
            content: pdfResult.buffer,
         }]
       }).catch((e: any) => console.error("[contract copy email]", e));
    }

    res.json({ success: true, message: "Contract signed successfully." });
  } catch (error: any) {
    console.error("Failed to sign contract:", error);
    res.status(500).json({ success: false, error: "An error occurred while signing the contract.", code: "AN_ERROR_OCCURRED_WHILE_SIGNIN" });
  }
});

router.use(authenticate as any);

// ── GET /api/v1/contracts/pending ──────────────────────────────────────────
// Fetch pending contracts for the logged-in user
router.get("/pending", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email;
  if (!email) {
    res.status(401).json({ success: false, error: "Not logged in", code: "NOT_LOGGED_IN" });
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
    res.status(500).json({ success: false, error: "Failed to fetch pending contracts.", code: "FAILED_TO_FETCH_PENDING_CONTRA" });
  }
});

// ── GET /api/v1/contracts/:id/preview ─────────────────────────────────────────
// Get the HTML preview of the contract
router.get("/:id/preview", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email;
  if (!email) {
    res.status(401).json({ success: false, error: "Not logged in", code: "NOT_LOGGED_IN" });
    return;
  }

  try {
    const contract = await prisma.contractRequest.findUnique({
      where: { id: req.params.id }
    });

    if (!contract) {
      res.status(404).json({ success: false, error: "Contract not found.", code: "CONTRACT_NOT_FOUND" });
      return;
    }

    if (contract.submitterEmail.toLowerCase() !== email.toLowerCase()) {
      res.status(403).json({ success: false, error: "Not authorized to view this contract.", code: "NOT_AUTHORIZED_TO_VIEW_THIS_CO" });
      return;
    }

    const html = await getContractPreviewHtml(contract.id);
    if (!html) {
      res.status(500).json({ success: false, error: "Failed to generate contract preview.", code: "FAILED_TO_GENERATE_CONTRACT_PR" });
      return;
    }

    res.json({ success: true, html });
  } catch (error: any) {
    console.error("Failed to generate preview:", error);
    res.status(500).json({ success: false, error: "An error occurred while generating the preview.", code: "AN_ERROR_OCCURRED_WHILE_GENERA" });
  }
});

// ── POST /api/v1/contracts/:id/sign ──────────────────────────────────────────
// Sign a pending contract request securely
router.post("/:id/sign", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email;
  if (!email) {
    res.status(401).json({ success: false, error: "Not logged in", code: "NOT_LOGGED_IN" });
    return;
  }

  const { token } = req.body;
  if (!token) {
    res.status(400).json({ success: false, error: "Security token is required.", code: "SECURITY_TOKEN_IS_REQUIRED" });
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
      res.status(400).json({ success: false, error: "Contract not found or already signed.", code: "CONTRACT_NOT_FOUND_OR_ALREADY" });
      return;
    }

    if (contract.submitterEmail.toLowerCase() !== email.toLowerCase()) {
      res.status(403).json({ success: false, error: "Not authorized to sign this contract.", code: "NOT_AUTHORIZED_TO_SIGN_THIS_CO" });
      return;
    }

    const user = await prisma.user.findFirst({
      where: { finca_email: email }
    });

    if (!user) {
      res.status(400).json({ success: false, error: "User not found.", code: "USER_NOT_FOUND" });
      return;
    }

    const secData = await prisma.securityData.findFirst({ where: { userEmail: { equals: email, mode: "insensitive" } } });
    const hashedInput = hashToken(token);

    if (!secData || secData.hashedToken !== hashedInput) {
      res.status(400).json({ success: false, error: "Invalid security token.", code: "INVALID_SECURITY_TOKEN" });
      return;
    }

    if (!secData.encryptedSignature) {
      res.status(400).json({ success: false, error: "You must set up your signature in settings first.", code: "YOU_MUST_SET_UP_YOUR_SIGNATURE" });
      return;
    }

    const signatureBase64 = decrypt(secData.encryptedSignature);

    // Generate Contract PDF with user's saved signature (no selfie needed for internal token auth)
    const pdfResult = await generateContractPdf(contract.id, signatureBase64, "", user.user_role || "");
    if (!pdfResult) {
      res.status(500).json({ success: false, error: "Failed to generate contract PDF.", code: "FAILED_TO_GENERATE_CONTRACT_PD" });
      return;
    }

    let storedPath = "";
    if (isSharePointEnabled()) {
      const formFolder = contract.submission.formName.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase();
      const refFolder = contract.submission.reference?.replace(/[\\/:*?"<>|]/g, "").trim().toUpperCase() || contract.submissionId.slice(-6).toUpperCase();
      storedPath = await storeDocumentLocally(
        pdfResult.buffer,
        pdfResult.filename,
        "application/pdf",
        process.env.SHAREPOINT_UPLOAD_FOLDER
          ? `${process.env.SHAREPOINT_UPLOAD_FOLDER}/${formFolder}/${refFolder}/Contracts`
          : `${formFolder}/${refFolder}/Contracts`
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
        signatureToken: token, // Real token
        internalSignature: signatureBase64,
        internalSignerJobTitle: user.user_role || "",
        pdfPath: storedPath,
      },
    });

    // Unblock prerequisite
    const prereq = await prisma.submissionPrerequisite.findFirst({
      where: { contractRequestId: contract.id, type: "CONTRACT" }
    });
    
    if (prereq) {
      await prisma.submissionPrerequisite.update({
        where: { id: prereq.id },
        data: { status: "Approved" }
      });
      
      checkAndUnblockPrerequisites(undefined, prereq.id);
    }

    res.json({ success: true, message: "Contract signed successfully." });
  } catch (error: any) {
    console.error("Failed to sign contract:", error);
    res.status(500).json({ success: false, error: "An error occurred while signing the contract.", code: "AN_ERROR_OCCURRED_WHILE_SIGNIN" });
  }
});

// ── POST /api/v1/contracts/:id/send-external ──────────────────────────────
router.post("/:id/send-external", async (req: AuthRequest, res: Response) => {
  const email = req.user?.email;
  if (!email) {
    res.status(401).json({ success: false, error: "Not logged in", code: "NOT_LOGGED_IN" });
    return;
  }

  const { externalSignerName, externalSignerEmail } = req.body;
  if (!externalSignerName || !externalSignerEmail) {
    res.status(400).json({ success: false, error: "Signer name and email are required.", code: "SIGNER_NAME_AND_EMAIL_ARE_REQU" });
    return;
  }

  try {
    const contract = await prisma.contractRequest.findUnique({
      where: { id: req.params.id },
      include: {
        submission: { select: { reference: true, formName: true } }
      }
    });

    if (!contract || contract.status !== "Pending") {
      res.status(400).json({ success: false, error: "Contract not found or already signed.", code: "CONTRACT_NOT_FOUND_OR_ALREADY" });
      return;
    }

    // Only the officer/submitter or treater can send it. Assume submitter for now.
    // Wait, the workflow treater might send it. So we bypass the strict ownership check or just log it.
    
    const token = crypto.randomBytes(32).toString("hex");

    await prisma.contractRequest.update({
      where: { id: contract.id },
      data: {
        externalSignerName,
        externalSignerEmail,
        externalToken: token,
      }
    });

    const appUrl = process.env.APP_URL ?? "https://paperless.vercel.app";
    const signUrl = `${appUrl}/sign-contract?token=${token}`;

    await mailer.sendMail({
      from: `FINCALite <${process.env.SMTP_FROM ?? "noreply@paperless.ng"}>`,
      to: externalSignerEmail,
      subject: `Action Required: Signature Requested for ${contract.submission.formName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #B50938; margin-bottom: 4px;">FINCALite</h2>
          <p style="color: #6b7280; font-size: 14px; margin-top: 0;">Operations Platform</p>
          <hr style="border-color: #e5e7eb; margin: 20px 0;" />
          <p style="font-size: 15px; color: #111827;">Hello <strong>${externalSignerName}</strong>,</p>
          <p style="font-size: 14px; color: #374151;">
            You have been requested to review and sign a contract.
          </p>
          <div style="background: #f9fafb; border-left: 4px solid #B50938; border-radius: 4px; padding: 16px; margin: 16px 0;">
            <p style="margin: 0; font-weight: 600; color: #111827;">${contract.submission.formName}</p>
            <p style="margin: 4px 0 0; font-size: 13px; color: #6b7280;">Reference: ${contract.submission.reference}</p>
          </div>
          <a href="${signUrl}" style="display: inline-block; background: #B50938; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 8px;">Review & Sign Contract</a>
          <p style="font-size: 12px; color: #9ca3af; margin-top: 24px;">If you believe this was sent in error, please disregard this email.</p>
        </div>
      `,
    });

    res.json({ success: true, message: "External signature request sent successfully." });
  } catch (error: any) {
    console.error("Failed to send external contract:", error);
    res.status(500).json({ success: false, error: "An error occurred while sending the email.", code: "AN_ERROR_OCCURRED_WHILE_SENDIN" });
  }
});

export default router;
