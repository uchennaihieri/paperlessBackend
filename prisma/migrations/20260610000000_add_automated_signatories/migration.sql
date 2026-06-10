-- AlterTable: add automated signatories and form treater role to FormTemplate
ALTER TABLE "FormTemplate" ADD COLUMN "formTreaterRole" TEXT;
ALTER TABLE "FormTemplate" ADD COLUMN "automatedSignatories" JSONB;
ALTER TABLE "FormTemplate" ADD COLUMN "automatedSigningType" TEXT;
