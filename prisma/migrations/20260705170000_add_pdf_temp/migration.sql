-- CreateTable
CREATE TABLE "PdfTemp" (
    "id" TEXT NOT NULL,
    "pdfBuffer" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PdfTemp_pkey" PRIMARY KEY ("id")
);
