-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "templateMappings" JSONB;

-- AlterTable
ALTER TABLE "FormTemplate" ADD COLUMN     "templateMappings" JSONB;

-- CreateTable
CREATE TABLE "UserDelegation" (
    "id" TEXT NOT NULL,
    "originalUserId" INTEGER NOT NULL,
    "delegateUserId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "initiatedBy" TEXT NOT NULL DEFAULT 'User',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDelegation_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "UserDelegation" ADD CONSTRAINT "UserDelegation_originalUserId_fkey" FOREIGN KEY ("originalUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDelegation" ADD CONSTRAINT "UserDelegation_delegateUserId_fkey" FOREIGN KEY ("delegateUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
