import { Router, Response } from "express";
import prisma from "../lib/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";

const router = Router();
router.use(authenticate as any);

// 1. Create a Folder
router.post("/", async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { name } = req.body;
  if (!userId || !name) {
    res.status(400).json({ success: false, error: "Missing folder name" });
    return;
  }

  try {
    const folder = await prisma.fileFolder.create({
      data: {
        name,
        createdById: userId,
        access: {
          create: {
            userId: userId,
            accessLevel: "WRITE"
          }
        }
      }
    });
    res.json({ success: true, data: folder });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Get Folders the user has access to
router.get("/", async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.json({ success: true, data: [] });
    return;
  }

  try {
    const folders = await prisma.fileFolder.findMany({
      where: {
        access: {
          some: { userId }
        }
      },
      include: {
        access: {
          include: { user: { select: { id: true, user_name: true, finca_email: true } } }
        },
        createdBy: { select: { user_name: true, finca_email: true } },
        _count: { select: { submissions: true } }
      },
      orderBy: { createdAt: "desc" }
    });
    res.json({ success: true, data: folders });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// 3. Get all active users (for sharing dropdown)
router.get("/users", async (req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        status: { equals: "active", mode: "insensitive" },
        OR: [{ lock_flag: false }, { lock_flag: null }],
      },
      select: {
        id: true,
        user_name: true,
        finca_email: true
      },
      orderBy: { user_name: "asc" }
    });
    res.json({ success: true, data: users });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Share Folder
router.post("/:id/share", async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const folderId = req.params.id;
  const { targetUserId, accessLevel } = req.body; // accessLevel: "VIEW" | "WRITE"

  if (!userId || !targetUserId || !accessLevel) {
    res.status(400).json({ success: false, error: "Missing required fields" });
    return;
  }

  try {
    // Check if the current user is the creator
    const folder = await prisma.fileFolder.findUnique({
      where: { id: folderId }
    });

    if (!folder || folder.createdById !== userId) {
      res.status(403).json({ success: false, error: "Only the folder creator can share it." });
      return;
    }

    // Upsert the access
    const access = await prisma.fileFolderAccess.upsert({
      where: {
        folderId_userId: {
          folderId,
          userId: Number(targetUserId)
        }
      },
      update: { accessLevel },
      create: {
        folderId,
        userId: Number(targetUserId),
        accessLevel
      }
    });

    res.json({ success: true, data: access });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Add Submission to Folder
router.post("/:id/add-submission", async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const folderId = req.params.id;
  const { submissionId } = req.body;

  if (!userId || !submissionId) {
    res.status(400).json({ success: false, error: "Missing submissionId" });
    return;
  }

  try {
    // Verify user has WRITE access
    const access = await prisma.fileFolderAccess.findUnique({
      where: {
        folderId_userId: { folderId, userId }
      }
    });

    if (!access || access.accessLevel !== "WRITE") {
      res.status(403).json({ success: false, error: "You do not have write access to this folder." });
      return;
    }

    const saved = await prisma.fileFolderSubmission.create({
      data: { folderId, submissionId }
    });

    res.json({ success: true, data: saved });
  } catch (error: any) {
    // Usually means it was already added (unique constraint)
    res.json({ success: true, message: "Submission may already be in folder", error: error.message });
  }
});

// 5. Get Submissions in Folder
router.get("/:id/submissions", async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const folderId = req.params.id;

  if (!userId) {
    res.json({ success: true, data: [] });
    return;
  }

  try {
    // Verify user has access
    const access = await prisma.fileFolderAccess.findUnique({
      where: {
        folderId_userId: { folderId, userId }
      }
    });

    if (!access) {
      res.status(403).json({ success: false, error: "You do not have access to this folder." });
      return;
    }

    const folderSubmissions = await prisma.fileFolderSubmission.findMany({
      where: { folderId },
      include: {
        submission: {
          select: {
            id: true,
            formName: true,
            reference: true,
            status: true,
            createdAt: true,
            publicSubmitterName: true,
            publicSubmitterEmail: true,
            template: { select: { name: true } },
            submittedBy: { select: { user_name: true, finca_email: true } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const items = folderSubmissions.map(fs => fs.submission);
    res.json({ success: true, data: items });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
