-- CreateTable
CREATE TABLE "SharepointSyncQueue" (
    "id" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "targetFolder" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMsg" TEXT,
    "documentId" TEXT,
    "fileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharepointSyncQueue_pkey" PRIMARY KEY ("id")
);
