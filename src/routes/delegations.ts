import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { mailer } from "../lib/mailer";

const router = Router();
const prisma = new PrismaClient();

router.use(authenticate as any);

// ── GET /api/v1/delegations/me ────────────────────────────────────────────────
router.get("/me", async (req: AuthRequest, res: Response) => {
  try {
    const userId = Number(req.user?.id);
    if (!userId) {
      res.status(401).json({ success: false, error: "Unauthorized" });
      return;
    }

    const given = await prisma.userDelegation.findMany({
      where: { originalUserId: userId },
      include: {
        delegateUser: { select: { user_name: true, finca_email: true, branch: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    const received = await prisma.userDelegation.findMany({
      where: { delegateUserId: userId },
      include: {
        originalUser: { select: { user_name: true, finca_email: true, branch: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    res.json({ success: true, data: { given, received } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /api/v1/delegations/user/:userId ──────────────────────────────────────
router.get("/user/:userId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = Number(req.params.userId);
    if (!userId) {
      res.status(400).json({ success: false, error: "Invalid user ID" });
      return;
    }

    // Admins can see anyone's, users can only see their own
    const currentUserId = Number(req.user?.id);
    if (userId !== currentUserId && req.user?.specialAccess !== "Administrator") {
      res.status(403).json({ success: false, error: "Forbidden" });
      return;
    }

    const given = await prisma.userDelegation.findMany({
      where: { originalUserId: userId },
      include: {
        delegateUser: { select: { user_name: true, finca_email: true, branch: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    const received = await prisma.userDelegation.findMany({
      where: { delegateUserId: userId },
      include: {
        originalUser: { select: { user_name: true, finca_email: true, branch: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    res.json({ success: true, data: { given, received } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /api/v1/delegations ──────────────────────────────────────────────────
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const { originalUserId, delegateUserId, initiatedBy } = req.body;
    
    // Validate users
    const originalUser = await prisma.user.findUnique({ where: { id: Number(originalUserId) } });
    const delegateUser = await prisma.user.findUnique({ where: { id: Number(delegateUserId) } });

    if (!originalUser || !delegateUser) {
      res.status(404).json({ success: false, error: "User not found" });
      return;
    }

    // Cancel any existing pending or active delegations for this originalUser
    await prisma.userDelegation.updateMany({
      where: {
        originalUserId: originalUser.id,
        status: { in: ["Pending", "Active"] }
      },
      data: { status: "Reverted" }
    });

    const delegation = await prisma.userDelegation.create({
      data: {
        originalUserId: originalUser.id,
        delegateUserId: delegateUser.id,
        initiatedBy: initiatedBy || "User",
        status: "Pending"
      }
    });

    // Notify delegatee
    if (delegateUser.finca_email) {
      await mailer.sendMail({
        from: process.env.SMTP_FROM || "no-reply@finca.com",
        to: delegateUser.finca_email,
        subject: `Delegation Request from ${originalUser.user_name}`,
        html: `
          <h3>Delegation Request</h3>
          <p>Hello ${delegateUser.user_name},</p>
          <p><strong>${originalUser.user_name}</strong> has requested to delegate their workflow forms to you.</p>
          <p>Please log in to your dashboard to Approve or Decline this request.</p>
        `
      }).catch(console.error);
    }

    res.status(201).json({ success: true, data: delegation });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /api/v1/delegations/:id/approve ──────────────────────────────────────
router.post("/:id/approve", async (req: AuthRequest, res: Response) => {
  try {
    const delegation = await prisma.userDelegation.findUnique({ where: { id: req.params.id }, include: { originalUser: true, delegateUser: true } });
    if (!delegation) {
      res.status(404).json({ success: false, error: "Delegation not found" });
      return;
    }
    if (delegation.delegateUserId !== Number(req.user?.id) && req.user?.specialAccess !== "Administrator") {
      res.status(403).json({ success: false, error: "Forbidden" });
      return;
    }

    // Mark active
    const updated = await prisma.userDelegation.update({
      where: { id: delegation.id },
      data: { status: "Active" }
    });

    res.json({ success: true, data: updated });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /api/v1/delegations/:id/decline ──────────────────────────────────────
router.post("/:id/decline", async (req: AuthRequest, res: Response) => {
  try {
    const delegation = await prisma.userDelegation.findUnique({ where: { id: req.params.id }, include: { originalUser: true, delegateUser: true } });
    if (!delegation) {
      res.status(404).json({ success: false, error: "Delegation not found" });
      return;
    }
    if (delegation.delegateUserId !== Number(req.user?.id) && req.user?.specialAccess !== "Administrator") {
      res.status(403).json({ success: false, error: "Forbidden" });
      return;
    }

    const updated = await prisma.userDelegation.update({
      where: { id: delegation.id },
      data: { status: "Declined" }
    });

    if (delegation.originalUser.finca_email) {
      await mailer.sendMail({
        from: process.env.SMTP_FROM || "no-reply@finca.com",
        to: delegation.originalUser.finca_email,
        subject: `Delegation Request Declined`,
        html: `
          <h3>Delegation Declined</h3>
          <p>Hello ${delegation.originalUser.user_name},</p>
          <p><strong>${delegation.delegateUser.user_name}</strong> has declined your workflow delegation request.</p>
          <p>Please log in to select a different delegate.</p>
        `
      }).catch(console.error);
    }

    res.json({ success: true, data: updated });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /api/v1/delegations/:id/revert ───────────────────────────────────────
router.post("/:id/revert", async (req: AuthRequest, res: Response) => {
  try {
    const delegation = await prisma.userDelegation.findUnique({ where: { id: req.params.id } });
    if (!delegation) {
      res.status(404).json({ success: false, error: "Delegation not found" });
      return;
    }
    
    // Original user, delegate, or admin can revert
    const userId = Number(req.user?.id);
    const isAdmin = req.user?.specialAccess === "Administrator";
    if (delegation.originalUserId !== userId && delegation.delegateUserId !== userId && !isAdmin) {
      res.status(403).json({ success: false, error: "Forbidden" });
      return;
    }

    const updated = await prisma.userDelegation.update({
      where: { id: delegation.id },
      data: { status: "Reverted" }
    });

    res.json({ success: true, data: updated });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
