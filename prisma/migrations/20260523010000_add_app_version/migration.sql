-- CreateTable
CREATE TABLE "app_versions" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "downloadUrl" TEXT NOT NULL,
    "releaseNotes" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_versions_pkey" PRIMARY KEY ("id")
);
