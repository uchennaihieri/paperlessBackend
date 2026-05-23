-- AlterTable
ALTER TABLE "FormTemplate" ADD COLUMN     "generatesExcel" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "formStatuses" JSONB,
ADD COLUMN     "formTemplateId" TEXT,
ADD COLUMN     "reportType" TEXT NOT NULL DEFAULT 'manual',
ALTER COLUMN "script" DROP NOT NULL;
