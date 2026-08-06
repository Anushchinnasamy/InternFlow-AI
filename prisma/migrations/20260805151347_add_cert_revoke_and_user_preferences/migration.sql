-- AlterTable
ALTER TABLE "Certificate" ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedReason" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "preferences" JSONB;
