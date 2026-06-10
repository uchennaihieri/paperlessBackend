-- Migration: Add automated signatories and form treater role to FormTemplate
-- These three columns were added to schema.prisma but never had a migration generated.

-- 1. Add formTreaterRole column
ALTER TABLE "FormTemplate" ADD COLUMN IF NOT EXISTS "formTreaterRole" TEXT;

-- 2. Add automatedSignatories column (JSON)
ALTER TABLE "FormTemplate" ADD COLUMN IF NOT EXISTS "automatedSignatories" JSONB;

-- 3. Add automatedSigningType column
ALTER TABLE "FormTemplate" ADD COLUMN IF NOT EXISTS "automatedSigningType" TEXT;
