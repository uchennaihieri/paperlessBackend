-- AlterTable
ALTER TABLE "UploadedFile" ADD COLUMN     "sharepointPath" TEXT,
ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "submission_documents" ADD COLUMN     "sharepointPath" TEXT,
ADD COLUMN     "syncedAt" TIMESTAMP(3);
