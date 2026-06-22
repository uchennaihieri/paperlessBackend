-- CreateTable
CREATE TABLE "UploadedDataset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "sharedWith" TEXT[],
    "status" TEXT NOT NULL,
    "runFirstCentral" BOOLEAN NOT NULL DEFAULT false,
    "runCreditRegistry" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedDataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetRecord" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "bvn" TEXT,
    "rowData" JSONB NOT NULL,
    "firstCentralRef" TEXT,
    "creditRegistryRef" TEXT,
    "processingStatus" TEXT NOT NULL,

    CONSTRAINT "DatasetRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DatasetRecord_reference_key" ON "DatasetRecord"("reference");

-- AddForeignKey
ALTER TABLE "DatasetRecord" ADD CONSTRAINT "DatasetRecord_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "UploadedDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
