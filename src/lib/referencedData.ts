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
      console.log(`[extractReferencedData] Field: ${field.label}, Desc: ${field.description}, Match:`, match);
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
        
        console.log(`[extractReferencedData] targetFormResponses for ${targetLabel}:`, targetFormResponses?.[targetLabel]);

        // If we successfully found the value, inject it
        if (targetFormResponses && targetFormResponses[targetLabel] !== undefined) {
          referencedResponses[field.label] = targetFormResponses[targetLabel];
        }
      }
    }
  }

  console.log(`[extractReferencedData] Final referencedResponses:`, referencedResponses);
  return referencedResponses;
}
