-- CreateTable
CREATE TABLE "pdf_job_queue" (
    "id" TEXT NOT NULL,
    "sourceSubmissionId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "targetSubmissionId" TEXT,
    "targetFieldName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "errorMsg" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pdf_job_queue_pkey" PRIMARY KEY ("id")
);
