-- AlterTable
ALTER TABLE "FormSubmission" ADD COLUMN IF NOT EXISTS "correctionRequests" JSONB;

-- AlterTable
ALTER TABLE "form_audit_trail" ADD COLUMN IF NOT EXISTS "formReference" TEXT;
