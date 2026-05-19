import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest, requireAdmin } from "../middleware/authenticate";

const router = Router();
router.use(authenticate as any);

// ── GET /api/v1/forms-access/user/:email ─────────────────────────────────────
// Returns all forms explicitly assigned to a user
router.get("/user/:email", requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const email = req.params.email;
  try {
    const access = await prisma.formAccess.findMany({
      where: { userEmail: { equals: email, mode: "insensitive" } },
      include: {
        template: { select: { id: true, name: true, description: true } },
      },
    });
    res.json({ success: true, data: access });
  } catch (err) {
    console.error("Error fetching form access for user:", err);
    res.status(500).json({ success: false, error: "Failed to fetch access" });
  }
});

// ── GET /api/v1/forms-access/form/:templateId ──────────────────────────────────
// Returns all users explicitly assigned to a form
router.get("/form/:templateId", requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const templateId = req.params.templateId;
  try {
    const access = await prisma.formAccess.findMany({
      where: { templateId },
      select: { userEmail: true, grantedAt: true, grantedBy: true },
    });
    res.json({ success: true, data: access });
  } catch (err) {
    console.error("Error fetching form access for template:", err);
    res.status(500).json({ success: false, error: "Failed to fetch access" });
  }
});

// ── POST /api/v1/forms-access/user/:email ────────────────────────────────────
// Bulk assigns forms to a user (replaces existing assignments)
// If applyToAll is true, applies added/removed template deltas to all users.
router.post("/user/:email", requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const email = req.params.email;
  const adminEmail = req.user?.email ?? "system";
  const { templateIds, applyToAll, addedTemplateIds, removedTemplateIds } = req.body;

  if (!Array.isArray(templateIds)) {
    res.status(400).json({ success: false, error: "templateIds must be an array" });
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Exact replacement for the target user
      await tx.formAccess.deleteMany({
        where: { userEmail: { equals: email, mode: "insensitive" } },
      });

      if (templateIds.length > 0) {
        await tx.formAccess.createMany({
          data: templateIds.map((id: string) => ({
            userEmail: email.toLowerCase(),
            templateId: id,
            grantedBy: adminEmail,
          })),
        });
      }

      // 2. Global distribution of deltas if requested
      if (applyToAll) {
        const added = Array.isArray(addedTemplateIds) ? addedTemplateIds : [];
        const removed = Array.isArray(removedTemplateIds) ? removedTemplateIds : [];

        // Remove unchecked forms from ALL users
        if (removed.length > 0) {
          await tx.formAccess.deleteMany({
            where: { templateId: { in: removed } },
          });
        }

        // Add checked forms to ALL users
        if (added.length > 0) {
          const allUsers = await tx.user.findMany({
            where: { finca_email: { not: null } },
            select: { finca_email: true },
            distinct: ['finca_email'],
          });

          const globalGrants: { userEmail: string; templateId: string; grantedBy: string }[] = [];
          for (const u of allUsers) {
            const uEmail = u.finca_email?.toLowerCase();
            if (!uEmail) continue;
            
            for (const tId of added) {
              if (uEmail !== email.toLowerCase()) {
                 globalGrants.push({
                   userEmail: uEmail,
                   templateId: tId,
                   grantedBy: adminEmail,
                 });
              }
            }
          }

          if (globalGrants.length > 0) {
             await tx.formAccess.createMany({
               data: globalGrants,
               skipDuplicates: true,
             });
          }
        }
      }
    });

    res.json({ success: true, message: "Form access updated." });
  } catch (err) {
    console.error("Error updating user form access:", err);
    res.status(500).json({ success: false, error: "Failed to update access" });
  }
});

// ── POST /api/v1/forms-access/form/:templateId ───────────────────────────────
// Bulk assigns users to a form (replaces existing assignments)
router.post("/form/:templateId", requireAdmin as any, async (req: AuthRequest, res: Response) => {
  const templateId = req.params.templateId;
  const adminEmail = req.user?.email ?? "system";
  const { userEmails } = req.body; // Array of email strings

  if (!Array.isArray(userEmails)) {
    res.status(400).json({ success: false, error: "userEmails must be an array" });
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Clear existing access
      await tx.formAccess.deleteMany({
        where: { templateId },
      });

      // Insert new access
      if (userEmails.length > 0) {
        await tx.formAccess.createMany({
          data: userEmails.map((uEmail: string) => ({
            templateId,
            userEmail: uEmail.toLowerCase(),
            grantedBy: adminEmail,
          })),
        });
      }
    });

    res.json({ success: true, message: "User access updated for form." });
  } catch (err) {
    console.error("Error updating form access for template:", err);
    res.status(500).json({ success: false, error: "Failed to update access" });
  }
});

export default router;
