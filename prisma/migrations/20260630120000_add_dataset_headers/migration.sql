-- AlterTable
ALTER TABLE "UploadedDataset" ADD COLUMN "headers" TEXT[] DEFAULT ARRAY[]::TEXT[];
