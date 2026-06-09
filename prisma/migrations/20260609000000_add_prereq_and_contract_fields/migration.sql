-- AlterTable: make targetFormId nullable
ALTER TABLE "SubmissionPrerequisite" ALTER COLUMN "targetFormId" DROP NOT NULL;

-- AlterTable: make targetEmail nullable
ALTER TABLE "SubmissionPrerequisite" ALTER COLUMN "targetEmail" DROP NOT NULL;

-- AlterTable: add new columns to SubmissionPrerequisite
ALTER TABLE "SubmissionPrerequisite"
ADD COLUMN "type" TEXT NOT NULL DEFAULT 'FORM',
ADD COLUMN "contractRequestId" TEXT,
ADD COLUMN "order" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "declineReason" TEXT;

-- DropIndex: remove old composite unique constraint
DROP INDEX "SubmissionPrerequisite_mainSubmissionId_targetFormId_target_key";

-- CreateIndex: add index on mainSubmissionId
CREATE INDEX "SubmissionPrerequisite_mainSubmissionId_idx" ON "SubmissionPrerequisite"("mainSubmissionId");

-- AlterTable: add internal signing columns to contract_requests
ALTER TABLE "contract_requests"
ADD COLUMN "internalSignature" TEXT,
ADD COLUMN "internalSignerJobTitle" TEXT;

-- AlterTable: add external signing columns to contract_requests
ALTER TABLE "contract_requests"
ADD COLUMN "externalSignerName" TEXT,
ADD COLUMN "externalSignerEmail" TEXT,
ADD COLUMN "externalToken" TEXT,
ADD COLUMN "externalSignedAt" TIMESTAMP(3),
ADD COLUMN "externalSignature" TEXT;

-- CreateIndex: unique constraint on externalToken
CREATE UNIQUE INDEX "contract_requests_externalToken_key" ON "contract_requests"("externalToken");
