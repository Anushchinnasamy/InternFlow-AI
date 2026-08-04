-- AlterTable
ALTER TABLE "Internship" ADD COLUMN     "adAccountRef" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "delayReminderCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "payload" JSONB;

-- CreateTable
CREATE TABLE "CredentialToken" (
    "id" TEXT NOT NULL,
    "internshipId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "mockUsername" TEXT NOT NULL,
    "mockPassword" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "reissueCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialToken_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CredentialToken" ADD CONSTRAINT "CredentialToken_internshipId_fkey" FOREIGN KEY ("internshipId") REFERENCES "Internship"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
