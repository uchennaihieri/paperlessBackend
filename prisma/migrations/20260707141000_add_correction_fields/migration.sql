-- AlterTable
ALTER TABLE "FormSubmission" ADD COLUMN "correctionRequests" JSONB;

-- AlterTable
ALTER TABLE "form_audit_trail" ADD COLUMN "formReference" TEXT;
