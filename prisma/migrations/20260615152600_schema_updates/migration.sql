-- DropForeignKey
ALTER TABLE "SubmissionPrerequisite" DROP CONSTRAINT "SubmissionPrerequisite_targetFormId_fkey";

-- AlterTable
ALTER TABLE "FormSubmission" ADD COLUMN     "publicSubmitterEmail" TEXT,
ADD COLUMN     "publicSubmitterName" TEXT,
ADD COLUMN     "requestBatchId" TEXT;

-- AlterTable
ALTER TABLE "FormTemplate" ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicSlug" TEXT;



-- CreateTable
CREATE TABLE "FormRequestBatch" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "message" TEXT,
    "prefilledData" JSONB,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormRequestBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormRequest" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "targetEmail" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "submissionId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FormRequest_token_key" ON "FormRequest"("token");

-- CreateIndex
CREATE UNIQUE INDEX "FormTemplate_publicSlug_key" ON "FormTemplate"("publicSlug");

-- AddForeignKey
ALTER TABLE "SubmissionPrerequisite" ADD CONSTRAINT "SubmissionPrerequisite_targetFormId_fkey" FOREIGN KEY ("targetFormId") REFERENCES "FormTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormRequestBatch" ADD CONSTRAINT "FormRequestBatch_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "FormTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormRequest" ADD CONSTRAINT "FormRequest_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "FormRequestBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
