const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Account Services (Mobile) forms...");

  const mobileForms = [
    {
      name: "Loan Application",
      description: "Standard Loan Application form for Account Services",
      mobileEnabled: true,
      fields: [
        { id: "f1", label: "Applicant Name", type: "text", required: true, description: "Full legal name" },
        { id: "f2", label: "Amount Requested (₦)", type: "number", required: true, description: "e.g. 500000" },
        { id: "f3", label: "Loan Purpose", type: "textarea", required: true, description: "Why do you need this loan?" }
      ],
      pdfGeneratorType: "none",
    },
    {
      name: "Deposit Account Opening",
      description: "Open a new deposit account via mobile",
      mobileEnabled: true,
      fields: [
        { id: "f1", label: "Full Name", type: "text", required: true, description: "As it appears on ID" },
        { id: "f2", label: "BVN", type: "number", required: true, description: "11-digit Bank Verification Number" },
        { id: "f3", label: "Initial Deposit (₦)", type: "number", required: true, description: "" }
      ],
      pdfGeneratorType: "none",
    }
  ];

  for (const form of mobileForms) {
    // Upsert to avoid duplicate errors
    await prisma.formTemplate.upsert({
      where: { name: form.name },
      update: {
        description: form.description,
        mobileEnabled: form.mobileEnabled,
        fields: form.fields,
      },
      create: form,
    });
    console.log(`Seeded form: ${form.name}`);
  }

  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
