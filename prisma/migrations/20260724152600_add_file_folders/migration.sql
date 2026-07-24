-- AlterTable
ALTER TABLE "FormSubmission" ADD COLUMN "treaterBranch" VARCHAR(100);

-- CreateTable
CREATE TABLE "file_folders" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_folder_access" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "accessLevel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_folder_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_folder_submissions" (
    "folderId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_folder_submissions_pkey" PRIMARY KEY ("folderId","submissionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_folder_access_folderId_userId_key" ON "file_folder_access"("folderId", "userId");

-- AddForeignKey
ALTER TABLE "file_folders" ADD CONSTRAINT "file_folders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_folder_access" ADD CONSTRAINT "file_folder_access_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "file_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_folder_access" ADD CONSTRAINT "file_folder_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_folder_submissions" ADD CONSTRAINT "file_folder_submissions_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "file_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_folder_submissions" ADD CONSTRAINT "file_folder_submissions_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "FormSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
