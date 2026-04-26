import { Router, Request, Response } from "express";
import prisma from "../lib/prisma";

const router = Router();

// GET /api/v1/mobile/dashboard?userId=<id>
router.get("/", async (req: Request, res: Response) => {
  const userId = req.query.userId as string | undefined;
  if (!userId) {
    res.status(400).json({ success: false, error: "userId is required" });
    return;
  }

  const userIdInt = parseInt(userId);
  if (isNaN(userIdInt)) {
    res.status(400).json({ success: false, error: "userId must be a number" });
    return;
  }

  const submissions = await prisma.formSubmission.findMany({
    where: { 
      submittedById: userIdInt,
      template: {
        mobileEnabled: true,
      }
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      reference: true,
      formName: true,
      status: true,
      updatedAt: true,
      formResponses: true,
    },
  });

  const stats = {
    pending: submissions.filter((s) => s.status === "Draft").length,
    inReview: submissions.filter((s) =>
      ["Submitted", "In-review", "Awaiting Final Approval"].includes(s.status)
    ).length,
    completed: submissions.filter((s) => s.status === "Completed").length,
    errors: submissions.filter((s) => s.status === "Rejected").length,
  };

  res.json({ success: true, stats, submissions });
});

export default router;
