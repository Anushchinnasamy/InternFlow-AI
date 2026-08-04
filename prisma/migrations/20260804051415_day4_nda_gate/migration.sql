-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "providerRef" TEXT,
ADD COLUMN     "signatureMeta" JSONB;
