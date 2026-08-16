-- AlterTable
ALTER TABLE "submission_documents" ADD COLUMN "hasSignatureTable" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "esave_admin_scopes" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "esave_admin_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "esave_admin_scopes_phone_key" ON "esave_admin_scopes"("phone");
