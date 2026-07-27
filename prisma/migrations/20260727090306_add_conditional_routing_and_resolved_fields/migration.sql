-- AlterTable
ALTER TABLE "FormTemplate" ADD COLUMN     "conditionalRouting" JSONB;

-- AlterTable
ALTER TABLE "FormSubmission" ADD COLUMN     "resolvedOwner" VARCHAR(100),
ADD COLUMN     "resolvedTreaterBranch" VARCHAR(100),
ADD COLUMN     "resolvedTreaterRole" VARCHAR(100);
