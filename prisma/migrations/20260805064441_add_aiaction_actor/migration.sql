-- AlterTable
ALTER TABLE "AiAction" ADD COLUMN     "actorId" TEXT;

-- AddForeignKey
ALTER TABLE "AiAction" ADD CONSTRAINT "AiAction_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
