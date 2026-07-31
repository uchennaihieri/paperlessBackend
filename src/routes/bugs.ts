import { Router } from "express";
import multer from "multer";
import prisma from "../lib/prisma";
import { storeDocumentLocally } from "../lib/storage";
import { mailer } from "../lib/mailer";
import { notifier } from "../lib/notifier";
import { logger } from "../lib/logger";
import { isSharePointEnabled, downloadFromSharePoint } from "../lib/sharepoint";

export const bugsRouter = Router();

const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function isAdmin(user: { user_role?: string; specialAccess?: string } | null): boolean {
  if (!user) return false;
  const role = user.user_role?.toLowerCase() ?? "";
  const special = user.specialAccess?.toLowerCase() ?? "";
  return role === "administrator" || special.includes("administrator");
}

async function getAdminEmails(): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: {
      OR: [
        { user_role: { equals: "administrator", mode: "insensitive" } },
        { specialAccess: { contains: "administrator", mode: "insensitive" } },
      ],
    },
    select: { finca_email: true },
  });
  return admins
    .map((a) => a.finca_email)
    .filter((e): e is string => !!e);
}

// ── GET /api/v1/bugs — List bug reports with search, filters, pagination ──────

bugsRouter.get("/", async (req, res, next) => {
  try {
    const search = (req.query.search as string) || "";
    const status = (req.query.status as string) || "";
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const where: any = {};

    if (status && status !== "All") {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    const [data, total] = await Promise.all([
      prisma.bugReport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          postedBy: {
            select: { user_name: true, finca_email: true },
          },
          attachments: {
            select: { id: true, originalName: true, mimeType: true, size: true },
          },
          _count: {
            select: { comments: true, upvotes: true },
          },
        },
      }),
      prisma.bugReport.count({ where }),
    ]);

    // Mask anonymous posters
    const masked = data.map((bug: any) => ({
      ...bug,
      postedBy: bug.isAnonymous
        ? { user_name: "Anonymous", finca_email: null }
        : bug.postedBy,
    }));

    res.json({
      data: masked,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/bugs/attachments/:id — Download a bug attachment ─────────────

bugsRouter.get("/attachments/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    // @ts-ignore
    const att = await prisma.bugAttachment.findUnique({ where: { id } });
    if (!att) {
      res.status(404).send("Attachment not found");
      return;
    }

    res.set({
      "Content-Type": att.mimeType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${att.originalName}"`,
    });

    const fs = require("fs/promises");
    const path = require("path");
    const baseDir = process.env.LOCAL_UPLOAD_DIR || path.join(process.cwd(), "uploads");
    const absolutePath = path.join(baseDir, att.filePath);

    // 1. Try local disk first (much faster)
    try {
      const buffer = await fs.readFile(absolutePath);
      res.send(buffer);
      return;
    } catch (localErr) {
      // 2. If not found locally, try SharePoint (if enabled)
      if (isSharePointEnabled()) {
        try {
          const { buffer } = await downloadFromSharePoint(att.filePath);
          res.send(buffer);
          return;
        } catch (spErr) {
          res.status(500).send("Failed to retrieve file from local disk and SharePoint.");
          return;
        }
      } else {
        res.status(404).send("File not found on disk, and SharePoint is not enabled.");
        return;
      }
    }
  } catch (error) {
    next(error);
  }
});

// ── GET /api/v1/bugs/:id — Get a single bug report with comments ─────────────

bugsRouter.get("/:id", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid bug ID" });
      return;
    }

    const bug = await prisma.bugReport.findUnique({
      where: { id },
      include: {
        postedBy: {
          select: { user_name: true, finca_email: true },
        },
        attachments: true,
        comments: {
          orderBy: { createdAt: "asc" },
        },
        upvotes: {
          select: { userEmail: true },
        },
        _count: {
          select: { comments: true, upvotes: true },
        },
      },
    });

    if (!bug) {
      res.status(404).json({ error: "Bug report not found" });
      return;
    }

    const masked = {
      ...bug,
      postedBy: bug.isAnonymous
        ? { user_name: "Anonymous", finca_email: null }
        : bug.postedBy,
    };

    res.json(masked);
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/bugs — Create a new bug report ──────────────────────────────

bugsRouter.post("/", memUpload.array("files", 5), async (req, res, next) => {
  try {
    const { title, description, type, isAnonymous, postedById, postedByName, postedByEmail } = req.body;

    if (!title || !description || !postedById) {
      res.status(400).json({ error: "Title, description, and postedById are required." });
      return;
    }

    const userId = parseInt(postedById);
    if (isNaN(userId)) {
      res.status(400).json({ error: "Invalid postedById." });
      return;
    }

    // Create the bug report
    const bug = await prisma.bugReport.create({
      data: {
        title,
        description,
        type: type || "bug",
        isAnonymous: isAnonymous === "true" || isAnonymous === true,
        postedById: userId,
      },
    });

    // Handle file attachments
    const files = (req.files as Express.Multer.File[]) || [];
    for (const file of files) {
      const relativePath = await storeDocumentLocally(
        file.buffer,
        file.originalname,
        file.mimetype,
        `BugsAndFixes/${bug.id}`
      );

      await prisma.bugAttachment.create({
        data: {
          bugReportId: bug.id,
          originalName: file.originalname,
          filePath: relativePath,
          mimeType: file.mimetype,
          size: file.size,
        },
      });
    }

    // Notify all admins (both email and Teams)
    const adminEmails = await getAdminEmails();
    const reportType = (type || "bug") === "feature" ? "Feature Request" : "Bug Report";
    const posterName = isAnonymous === "true" || isAnonymous === true
      ? "Anonymous"
      : (postedByName || "A user");

    const subject = `New ${reportType}: ${title}`;
    const htmlBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2 style="color: #b50938;">New ${reportType} #${bug.id}</h2>
        <p><strong>Posted by:</strong> ${posterName}</p>
        <p><strong>Title:</strong> ${title}</p>
        <p><strong>Description:</strong></p>
        <div style="background: #f5f5f5; padding: 12px; border-radius: 8px; margin: 8px 0;">
          ${description.replace(/\n/g, "<br>")}
        </div>
        ${files.length > 0 ? `<p><strong>Attachments:</strong> ${files.length} file(s)</p>` : ""}
        <p style="color: #888; font-size: 12px; margin-top: 16px;">
          Please review this in the Bugs and Fixes section of FINCALite.
        </p>
      </div>
    `;

    for (const email of adminEmails) {
      // Email notification
      mailer.sendMail({
        to: email,
        subject,
        html: htmlBody,
      }).catch((err) => logger.error(`Bug email notification failed for ${email}: ${err}`));

      // Teams notification
      notifier.notifyInternalUser({
        to: email,
        subject,
        message: `${posterName} submitted a ${reportType.toLowerCase()}: "${title}"`,
      }).catch((err) => logger.error(`Bug Teams notification failed for ${email}: ${err}`));
    }

    // Return the created bug with its attachments
    const full = await prisma.bugReport.findUnique({
      where: { id: bug.id },
      include: {
        attachments: true,
        _count: { select: { comments: true, upvotes: true } },
      },
    });

    res.status(201).json(full);
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/bugs/:id/upvote — Toggle upvote ─────────────────────────────

bugsRouter.post("/:id/upvote", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { userEmail } = req.body;

    if (isNaN(id) || !userEmail) {
      res.status(400).json({ error: "Bug ID and userEmail are required." });
      return;
    }

    // Check if already upvoted
    const existing = await prisma.bugUpvote.findUnique({
      where: { bugReportId_userEmail: { bugReportId: id, userEmail } },
    });

    if (existing) {
      // Remove upvote
      await prisma.bugUpvote.delete({ where: { id: existing.id } });
      const count = await prisma.bugUpvote.count({ where: { bugReportId: id } });
      res.json({ upvoted: false, count });
    } else {
      // Add upvote
      await prisma.bugUpvote.create({
        data: { bugReportId: id, userEmail },
      });
      const count = await prisma.bugUpvote.count({ where: { bugReportId: id } });
      res.json({ upvoted: true, count });
    }
  } catch (error) {
    next(error);
  }
});

// ── POST /api/v1/bugs/:id/comment — Add a comment ────────────────────────────

bugsRouter.post("/:id/comment", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { authorName, authorEmail, content } = req.body;

    if (isNaN(id) || !authorEmail || !content) {
      res.status(400).json({ error: "Bug ID, authorEmail, and content are required." });
      return;
    }

    const bug = await prisma.bugReport.findUnique({ where: { id }, select: { status: true } });
    if (!bug) {
      res.status(404).json({ error: "Bug report not found." });
      return;
    }
    if (bug.status === "Fixed") {
      res.status(400).json({ error: "Cannot add comments to a fixed issue." });
      return;
    }

    const comment = await prisma.bugComment.create({
      data: {
        bugReportId: id,
        authorName: authorName || "Unknown User",
        authorEmail,
        content,
      },
    });

    res.status(201).json(comment);
  } catch (error) {
    next(error);
  }
});

// ── PUT /api/v1/bugs/:id/fix — Mark a bug as fixed (admin only) ───────────────

bugsRouter.put("/:id/fix", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { fixComment, fixedByEmail, fixedByName, userRole, specialAccess } = req.body;

    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid bug ID." });
      return;
    }

    // Check admin privileges
    if (!isAdmin({ user_role: userRole, specialAccess })) {
      res.status(403).json({ error: "Only administrators can mark bugs as fixed." });
      return;
    }

    const bug = await prisma.bugReport.findUnique({
      where: { id },
      include: {
        postedBy: { select: { finca_email: true, user_name: true } },
      },
    });

    if (!bug) {
      res.status(404).json({ error: "Bug report not found." });
      return;
    }

    const updated = await prisma.bugReport.update({
      where: { id },
      data: {
        status: "Fixed",
        fixedByEmail: fixedByEmail || null,
        fixComment: fixComment || null,
        fixedAt: new Date(),
      },
    });

    // Notify the original poster and resolver (both email and Teams)
    const posterEmail = bug.postedBy?.finca_email;
    const emailsToNotify = new Set<string>();
    
    if (posterEmail) emailsToNotify.add(posterEmail);
    if (fixedByEmail) emailsToNotify.add(fixedByEmail);

    if (emailsToNotify.size > 0) {
      const subject = `${bug.type === "feature" ? "Feature request" : "Bug report"} #${bug.id} has been resolved`;
      const htmlBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #16a34a;">Issue Resolved ✓</h2>
          <p><strong>Title:</strong> ${bug.title}</p>
          <p><strong>Resolved by:</strong> ${fixedByName || fixedByEmail || "An administrator"}</p>
          ${fixComment ? `
            <p><strong>Resolution notes:</strong></p>
            <div style="background: #f0fdf4; padding: 12px; border-radius: 8px; border-left: 4px solid #16a34a; margin: 8px 0;">
              ${fixComment.replace(/\n/g, "<br>")}
            </div>
          ` : ""}
          <p style="color: #888; font-size: 12px; margin-top: 16px;">
            View the details in the Bugs and Fixes section of FINCALite.
          </p>
        </div>
      `;

      for (const email of emailsToNotify) {
        mailer.sendMail({
          to: email,
          subject,
          html: htmlBody,
        }).catch((err) => logger.error(`Fix notification email failed for ${email}: ${err}`));

        notifier.notifyInternalUser({
          to: email,
          subject,
          message: `${bug.type === "feature" ? "Feature request" : "Bug report"} "${bug.title}" has been resolved.${fixComment ? ` Notes: ${fixComment}` : ""}`,
        }).catch((err) => logger.error(`Fix Teams notification failed for ${email}: ${err}`));
      }
    }

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

export default bugsRouter;
