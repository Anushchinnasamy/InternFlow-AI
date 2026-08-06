-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "expiredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "checklist" JSONB;
