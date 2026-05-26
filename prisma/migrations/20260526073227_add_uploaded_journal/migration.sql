-- CreateTable
CREATE TABLE "uploaded_journals" (
    "id" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sharepointPath" TEXT NOT NULL,
    "totalDebit" DECIMAL(18,2) NOT NULL,
    "totalCredit" DECIMAL(18,2) NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "linkedSessionRef" TEXT,

    CONSTRAINT "uploaded_journals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uploaded_journals_uploadId_key" ON "uploaded_journals"("uploadId");

-- CreateIndex
CREATE INDEX "uploaded_journals_uploadedAt_idx" ON "uploaded_journals"("uploadedAt");

-- CreateIndex
CREATE INDEX "uploaded_journals_linkedSessionRef_idx" ON "uploaded_journals"("linkedSessionRef");

-- AlterTable
ALTER TABLE "journal_entries" ADD COLUMN "uploadedJournalId" TEXT;

-- CreateIndex
CREATE INDEX "journal_entries_uploadedJournalId_idx" ON "journal_entries"("uploadedJournalId");

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_uploadedJournalId_fkey" FOREIGN KEY ("uploadedJournalId") REFERENCES "uploaded_journals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
