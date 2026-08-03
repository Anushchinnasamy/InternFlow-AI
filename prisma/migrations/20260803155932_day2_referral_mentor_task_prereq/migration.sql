/*
  Warnings:

  - Added the required column `mentorId` to the `Referral` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_internshipId_fkey";

-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "mentorId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "referralId" TEXT,
ALTER COLUMN "internshipId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_internshipId_fkey" FOREIGN KEY ("internshipId") REFERENCES "Internship"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE SET NULL ON UPDATE CASCADE;
