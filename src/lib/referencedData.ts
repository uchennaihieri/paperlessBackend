export async function extractReferencedData(
  templateFields: any[],
  mainSubmissionId: string,
  prismaClient: any
): Promise<Record<string, any>> {
  const referencedResponses: Record<string, any> = {};
  let fetchedMainSubmission: any = null;
  let fetchedPrereqs: any[] | null = null;

  for (const field of templateFields) {
    if (field.description) {
      const match = field.description.match(/View Referenced "(?:(MainForm|Prerequisite\.\d+)\.)?([^"]+)"/i);
      if (match) {
        const targetType = match[1] || "MainForm"; // e.g. "MainForm" or "Prerequisite.1"
        const targetLabel = match[2];

        let targetFormResponses: any = null;

        if (targetType.toLowerCase() === "mainform") {
          if (!fetchedMainSubmission) {
            fetchedMainSubmission = await prismaClient.formSubmission.findUnique({
              where: { id: mainSubmissionId }
            });
          }
          if (fetchedMainSubmission) {
            targetFormResponses = typeof fetchedMainSubmission.formResponses === "string"
              ? JSON.parse(fetchedMainSubmission.formResponses)
              : fetchedMainSubmission.formResponses;
          }
        } else {
          const orderMatch = targetType.match(/Prerequisite\.(\d+)/i);
          if (orderMatch) {
            const targetOrder = parseInt(orderMatch[1], 10);
            if (!fetchedPrereqs) {
              fetchedPrereqs = await prismaClient.submissionPrerequisite.findMany({
                where: { mainSubmissionId },
                include: { prereqSubmission: true }
              });
            }
            const targetPrereq = fetchedPrereqs?.find((p: any) => p.order === targetOrder);
            if (targetPrereq && targetPrereq.prereqSubmission) {
              targetFormResponses = typeof targetPrereq.prereqSubmission.formResponses === "string"
                ? JSON.parse(targetPrereq.prereqSubmission.formResponses)
                : targetPrereq.prereqSubmission.formResponses;
            }
          }
        }
        
        // Handle .email suffix for prerequisite fields
        const isEmailRequest = targetLabel.endsWith(".email");
        const baseTargetLabel = isEmailRequest ? targetLabel.slice(0, -6) : targetLabel;

        if (targetFormResponses && targetFormResponses[baseTargetLabel] !== undefined) {
          if (isEmailRequest) {
            const refCode = targetFormResponses[baseTargetLabel];
            if (refCode && typeof refCode === "string") {
              const prereqSub = await prismaClient.formSubmission.findFirst({
                where: { reference: { equals: refCode.trim(), mode: "insensitive" } },
                include: { submittedBy: true }
              });
              
              if (prereqSub) {
                const submitterEmail = prereqSub.submittedBy?.finca_email || prereqSub.publicSubmitterEmail;
                if (submitterEmail) {
                  referencedResponses[field.label] = submitterEmail;
                }
              }
            }
          } else {
            referencedResponses[field.label] = targetFormResponses[baseTargetLabel];
          }
        }
      }
    }
  }

  return referencedResponses;
}
