import { Router, Response } from "express";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { getCustomerBVN, getCustomerNIN } from "../lib/qoreid";
import { logger } from "../lib/logger";
import prisma from "../lib/prisma";

const router = Router();
router.use(authenticate as any);

const CACHE_HOURS = 96;
const CACHE_MS = CACHE_HOURS * 60 * 60 * 1000;

// Helper to log the verification action to a submission's audit trail
async function logToAuditTrail(
  submissionId: string | undefined, 
  user: any, 
  actionMsg: string
) {
  if (!submissionId) return;

  try {
    const form = await prisma.formSubmission.findUnique({ where: { id: submissionId } });
    if (!form) return;

    await prisma.formAuditTrail.create({
      data: {
        submissionId: form.id,
        formReference: form.reference,
        prevStatus: form.status,
        newStatus: form.status,
        action: "identity_verified",
        actorName: user?.user_name || "Unknown",
        actorEmail: user?.email || "Unknown",
        note: actionMsg
      }
    });
  } catch (err) {
    logger.error(`Failed to write to audit trail for ${submissionId}:`, err);
  }
}

/**
 * POST /api/v1/identity/bvn/:idNumber
 * Verify a customer's identity using their Bank Verification Number (BVN)
 * Utilizes a 96-hour database cache to prevent redundant external API hits.
 */
router.post("/bvn/:idNumber", async (req: AuthRequest, res: Response) => {
  const { idNumber } = req.params;
  const { firstname, lastname, dob, phone, email, gender, submissionId } = req.body;

  if (!firstname || !lastname) {
    res.status(400).json({ success: false, error: "firstname and lastname are required" });
    return;
  }

  try {
    const cutoffTime = new Date(Date.now() - CACHE_MS);
    
    // 1. Check Cache
    const existingLog = await prisma.identityVerificationLog.findFirst({
      where: {
        idType: "bvn",
        idNumber,
        createdAt: { gte: cutoffTime }
      },
      orderBy: { createdAt: "desc" }
    });

    let data;
    if (existingLog) {
      data = existingLog.responseData;
    } else {
      // 2. Fetch fresh from QoreID
      data = await getCustomerBVN(idNumber, { firstname, lastname, dob, phone, email, gender });
      
      // 3. Cache it
      await prisma.identityVerificationLog.create({
        data: {
          idType: "bvn",
          idNumber,
          requestData: { firstname, lastname, dob, phone, email, gender },
          responseData: data as any,
          verifiedBy: req.user?.email || "Unknown"
        }
      });
    }

    // 4. Log to Audit Trail if tied to a submission
    await logToAuditTrail(submissionId, req.user, `BVN Verified for ${firstname} ${lastname}`);

    res.json({ success: true, data });
  } catch (error: any) {
    logger.error("Error in getBVNData route:", error);
    res.status(500).json({ success: false, error: error.message || "Failed to verify BVN" });
  }
});

/**
 * POST /api/v1/identity/nin/:idNumber
 * Verify a customer's identity using their National Identity Number (NIN)
 * Utilizes a 96-hour database cache to prevent redundant external API hits.
 */
router.post("/nin/:idNumber", async (req: AuthRequest, res: Response) => {
  const { idNumber } = req.params;
  const { firstname, lastname, middlename, dob, phone, email, gender, submissionId } = req.body;

  if (!firstname || !lastname) {
    res.status(400).json({ success: false, error: "firstname and lastname are required" });
    return;
  }

  try {
    const cutoffTime = new Date(Date.now() - CACHE_MS);
    
    // 1. Check Cache
    const existingLog = await prisma.identityVerificationLog.findFirst({
      where: {
        idType: "nin",
        idNumber,
        createdAt: { gte: cutoffTime }
      },
      orderBy: { createdAt: "desc" }
    });

    let data;
    if (existingLog) {
      data = existingLog.responseData;
    } else {
      // 2. Fetch fresh from QoreID
      data = await getCustomerNIN(idNumber, { firstname, lastname, middlename, dob, phone, email, gender });
      
      // 3. Cache it
      await prisma.identityVerificationLog.create({
        data: {
          idType: "nin",
          idNumber,
          requestData: { firstname, lastname, middlename, dob, phone, email, gender },
          responseData: data as any,
          verifiedBy: req.user?.email || "Unknown"
        }
      });
    }

    // 4. Log to Audit Trail if tied to a submission
    await logToAuditTrail(submissionId, req.user, `NIN Verified for ${firstname} ${lastname}`);

    res.json({ success: true, data });
  } catch (error: any) {
    logger.error("Error in getNINData route:", error);
    res.status(500).json({ success: false, error: error.message || "Failed to verify NIN" });
  }
});

export default router;
