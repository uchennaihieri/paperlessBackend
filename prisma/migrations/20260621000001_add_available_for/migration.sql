-- AlterTable
ALTER TABLE "pdf_templates" ADD COLUMN     "availableFor" TEXT[] DEFAULT ARRAY['forms']::TEXT[];
