import { Router, Request, Response } from "express";
import prisma from "../../lib/prisma";

const router = Router();

async function getOrCreateDepositTemplate() {
  let template = await prisma.formTemplate.findFirst({
    where: { name: "New Deposit Account" },
  });
  if (!template) {
    template = await prisma.formTemplate.create({
      data: {
        name: "New Deposit Account",
        description: "Customer deposit account opening form submitted via mobile app.",
        fields: [],
        formOwner: "Mobile",
        formTreater: "Operations",
      },
    });
  }
  return template;
}

// POST /api/v1/mobile/submissions/deposit
router.post("/", async (req: Request, res: Response) => {
  const { formResponses, submittedById, submissionId } = req.body;

  const template = await getOrCreateDepositTemplate();
  const year = new Date().getFullYear();
  const count = await prisma.formSubmission.count({
    where: { formName: "New Deposit Account", NOT: { status: "Draft" } },
  });
  const reference = `DA-${year}-${String(count + 1).padStart(5, "0")}`;

  let submission;
  if (submissionId) {
    submission = await prisma.formSubmission.update({
      where: { id: submissionId },
      data: { reference, status: "Submitted", formResponses, submittedById: submittedById ?? null },
    });
  } else {
    submission = await prisma.formSubmission.create({
      data: {
        formName: "New Deposit Account",
        reference,
        status: "Submitted",
        formResponses,
        signingType: "sequential",
        templateId: template.id,
        submittedById: submittedById ?? null,
      },
    });
  }

  res.json({ success: true, submission });
});

export default router;
