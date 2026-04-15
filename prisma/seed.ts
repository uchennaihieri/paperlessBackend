import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const forms = [
  {
    name: "PETTY CASH LIVE",
    description: "Request for petty cash reimbursement.",
    fields: [
      { id: "f1", label: "Amount (₦)", type: "number", required: true, description: "Please enter a whole number" },
      { id: "f2", label: "Amount in words", type: "text", required: true, description: "Enter your answer" },
      { id: "f3", label: "Bank Name", type: "text", required: true, description: "Enter your answer" },
      { id: "f4", label: "Account Number", type: "text", required: true, description: "Please enter at most 10 characters", maxLength: 10 },
      { id: "f5", label: "Account Name", type: "text", required: true, description: "Enter your answer" },
      { id: "f6", label: "Description of Need", type: "textarea", required: true, description: "Enter your answer" },
      { id: "f7", label: "Add Image Evidence (Receipt or Unreceipted)", type: "file", required: false, description: "File number limit: 10, Single file size limit: 100MB, Allowed file types: PDF, Image", maxFiles: 10, accept: ".pdf,image/*" },
    ],
  },
  {
    name: "CASH ADVANCE REQUEST FORM",
    description: "Request for cash advance.",
    fields: [
      { id: "f1", label: "Date Needed", type: "date", required: true, description: "Please input date (M/d/yyyy)" },
      { id: "f2", label: "Department", type: "text", required: true, description: "Enter your answer" },
      { id: "f3", label: "Beneficiary Name", type: "text", required: true, description: "Enter your answer" },
      { id: "f4", label: "Beneficiary Account", type: "text", required: true, description: "Enter your answer" },
      { id: "f5", label: "Beneficiary Bank Name", type: "text", required: true, description: "Enter your answer" },
      { id: "f6", label: "Amount", type: "number", required: true, description: "Enter your answer" },
      { id: "f7", label: "Purpose", type: "textarea", required: true, description: "Enter your answer" },
      { id: "f8", label: "Attach Invoice or Other documentation", type: "file", required: true, description: "File number limit: 10, Single file size limit: 100MB", maxFiles: 10, accept: ".doc,.docx,.xls,.xlsx,.ppt,.pptx,.pdf,image/*,video/*,audio/*" },
    ],
  },
  {
    name: "JOURNAL ENTRIES LIVE",
    description: "Submit journal entries.",
    fields: [
      { id: "f1", label: "REFERENCE", type: "text", required: true, description: "Enter your answer" },
      { id: "f2", label: "EXCEL FILE", type: "file", required: true, description: "File number limit: 1, Single file size limit: 10MB, Allowed file types: Excel", maxFiles: 1, accept: ".xls,.xlsx" },
    ],
  },
  {
    name: "PAYMENT REQUEST LIVE",
    description: "Request payment for expenses.",
    fields: [
      { id: "f1", label: "Expense Period", type: "date", required: true, description: "Please input date (M/d/yyyy)" },
      { id: "f2", label: "Beneficiary Name", type: "text", required: true, description: "Enter your answer" },
      { id: "f3", label: "Beneficiary Account", type: "text", required: true, description: "Enter your answer" },
      { id: "f4", label: "Beneficiary Bank Name", type: "text", required: true, description: "Enter your answer" },
      { id: "f5", label: "Manager Name", type: "text", required: true, description: "Enter your answer" },
      { id: "f6", label: "Department", type: "text", required: true, description: "Enter your answer" },
      { id: "f7", label: "Amount", type: "number", required: true, description: "Enter your answer" },
      { id: "f8", label: "Amount in words", type: "text", required: true, description: "Enter your answer" },
      { id: "f9", label: "Narration", type: "text", required: true, description: "Enter your answer" },
      { id: "f10", label: "Attach Expense Items Excel and Receipts", type: "file", required: true, description: "File number limit: 10, Single file size limit: 100MB", maxFiles: 10, accept: ".xls,.xlsx,.pdf,image/*" },
    ],
  },
  {
    name: "EXPENSE REIMBURSABLE FORM",
    description: "Request repayment for out-of-pocket expenses.",
    fields: [
      { id: "f1", label: "Beneficiary Name", type: "text", required: true, description: "Enter your answer" },
      { id: "f2", label: "Beneficiary Account", type: "text", required: true, description: "Enter your answer" },
      { id: "f3", label: "Beneficiary Bank Name", type: "text", required: true, description: "Enter your answer" },
      { id: "f4", label: "Manager Name", type: "text", required: true, description: "Enter your answer" },
      { id: "f5", label: "Department", type: "text", required: true, description: "Enter your answer" },
      { id: "f6", label: "Narration", type: "text", required: true, description: "Enter your answer" },
      { id: "f7", label: "SUBTOTAL", type: "number", required: true, description: "The value must be a number" },
      { id: "f8", label: "Less Cash Advance", type: "number", required: true, description: "The value must be a number" },
      { id: "f9", label: "Total Reimbursement", type: "number", required: true, description: "The value must be a number" },
      { id: "f10", label: "Total Reimbursement in words", type: "text", required: true, description: "Enter your answer" },
      { id: "f11", label: "Attach Expense Items on Excel Sheet or Receipts", type: "file", required: true, description: "File number limit: 10, Single file size limit: 100MB", maxFiles: 10, accept: ".doc,.docx,.xls,.xlsx,.ppt,.pptx,.pdf,image/*" },
    ],
  },
  {
    name: "UNRECEIPTED EXPENSE LIVE",
    description: "Submit unreceipted expenses.",
    fields: [
      { id: "f1", label: "Name of Staff", type: "text", required: true, description: "Enter your answer" },
      { id: "f2", label: "Department", type: "text", required: true, description: "Enter your answer" },
      { id: "f3", label: "Amount", type: "number", required: true, description: "The value must be a number" },
      { id: "f4", label: "Amount in words", type: "text", required: true, description: "Enter your answer" },
      { id: "f5", label: "Items bought", type: "text", required: true, description: "Enter your answer" },
    ],
  },
  {
    name: "REVERSAL FORM",
    description: "Request for reversal of a transaction.",
    fields: [
      { id: "f1", label: "REFERENCE", type: "text", required: true, description: "Enter your answer" },
      { id: "f2", label: "REVERSED FILE", type: "file", required: true, description: "File number limit: 5, Single file size limit: 10MB, Allowed file types: Word, Excel, PPT, PDF", maxFiles: 5, accept: ".doc,.docx,.xls,.xlsx,.ppt,.pptx,.pdf" },
    ],
  },
];

async function main() {
  for (const form of forms) {
    const existing = await prisma.formTemplate.findUnique({ where: { name: form.name } });
    const data = { ...form, formOwner: "Head Office", formTreater: "Head Office", fields: form.fields as any };

    if (!existing) {
      await prisma.formTemplate.create({ data });
      console.log(`✓ Created: ${form.name}`);
    } else {
      await prisma.formTemplate.update({
        where: { name: form.name },
        data: { fields: form.fields as any, description: form.description, formOwner: "Head Office", formTreater: "Head Office" },
      });
      console.log(`↻ Updated: ${form.name}`);
    }
  }
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
