-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "JoiningRecord" ADD COLUMN     "correctionFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "dob" TIMESTAMP(3),
ADD COLUMN     "internshipId" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ALTER COLUMN "address" DROP NOT NULL,
ALTER COLUMN "emergencyContactName" DROP NOT NULL,
ALTER COLUMN "emergencyContactPhone" DROP NOT NULL,
ALTER COLUMN "govtIdType" DROP NOT NULL,
ALTER COLUMN "govtIdNumber" DROP NOT NULL,
ALTER COLUMN "educationHistory" DROP NOT NULL,
ALTER COLUMN "consentVersion" DROP NOT NULL,
ALTER COLUMN "consentedAt" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "correctionFields" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_userId_key" ON "Candidate"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "JoiningRecord_internshipId_key" ON "JoiningRecord"("internshipId");

-- AddForeignKey
ALTER TABLE "Candidate" ADD CONSTRAINT "Candidate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JoiningRecord" ADD CONSTRAINT "JoiningRecord_internshipId_fkey" FOREIGN KEY ("internshipId") REFERENCES "Internship"("id") ON DELETE SET NULL ON UPDATE CASCADE;

