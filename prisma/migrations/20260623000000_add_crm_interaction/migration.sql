-- CreateTable
CREATE TABLE "CrmInteraction" (
    "id" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "feedbackText" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "loggedByEmail" TEXT NOT NULL,
    "loggedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmInteraction_pkey" PRIMARY KEY ("id")
);
