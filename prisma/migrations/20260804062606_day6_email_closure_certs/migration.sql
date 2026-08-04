-- AlterTable
ALTER TABLE "Internship" ADD COLUMN     "badgeReturnedAt" TIMESTAMP(3),
ADD COLUMN     "certificateApprovedAt" TIMESTAMP(3),
ADD COLUMN     "certificateApprovedBy" TEXT,
ADD COLUMN     "certificateRequestedAt" TIMESTAMP(3),
ADD COLUMN     "mentorCompletionConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "mentorCompletionRemark" TEXT,
ADD COLUMN     "mentorCompletionSatisfactory" BOOLEAN,
ADD COLUMN     "nonWorkerIdDeactivatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN     "internshipId" TEXT,
ADD COLUMN     "providerId" TEXT;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_internshipId_fkey" FOREIGN KEY ("internshipId") REFERENCES "Internship"("id") ON DELETE SET NULL ON UPDATE CASCADE;
