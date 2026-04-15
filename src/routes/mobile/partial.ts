import { Router, Request, Response } from "express";
import prisma from "../../lib/prisma";

const router = Router();

// POST /api/v1/mobile/submissions/partial
// Creates or updates a draft submission step by step
router.post("/", async (req: Request, res: Response) => {
  const { submissionId, formName, formResponses, submittedById } = req.body;

  if (!formName) {
    res.status(400).json({ success: false, error: "Form name is required" });
    return;
  }

  // Ensure a template exists (auto-create if needed)
  let template = await prisma.formTemplate.findUnique({ where: { name: formName } });
  if (!template) {
    template = await prisma.formTemplate.create({
      data: {
        name: formName,
        fields: [],
        description: "Auto-generated for mobile submission",
      },
    });
  }

  let submission;
  if (submissionId) {
    // Update existing draft
    submission = await prisma.formSubmission.update({
      where: { id: submissionId },
      data: { formResponses, updatedAt: new Date() },
    });
  } else {
    // Create new draft
    const count = await prisma.formSubmission.count();
    const reference = `DA-DRAFT-${new Date().getFullYear()}-${(count + 1).toString().padStart(5, "0")}`;
    submission = await prisma.formSubmission.create({
      data: {
        reference,
        formName,
        status: "Draft",
        formResponses,
        submittedById: submittedById ? parseInt(submittedById as string) : null,
        templateId: template.id,
      },
    });
  }

  res.json({ success: true, submissionId: submission.id, reference: submission.reference });
});

export default router;
