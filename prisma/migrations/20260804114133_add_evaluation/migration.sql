-- CreateEnum
CREATE TYPE "EvaluationRecommendation" AS ENUM ('HIRE', 'MAYBE', 'REJECT');

-- CreateEnum
CREATE TYPE "EvaluationDecision" AS ENUM ('REJECT', 'SHORTLIST', 'SELECT');

-- AlterEnum
ALTER TYPE "AiActionType" ADD VALUE 'MATCH_SCORE';

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "jobDescription" TEXT NOT NULL,
    "matchScore" INTEGER NOT NULL,
    "recommendation" "EvaluationRecommendation" NOT NULL,
    "strengths" TEXT[],
    "weaknesses" TEXT[],
    "aiSummary" TEXT NOT NULL,
    "rubricCommunication" INTEGER,
    "rubricTechnical" INTEGER,
    "rubricExperience" INTEGER,
    "rubricCulturalFit" INTEGER,
    "decision" "EvaluationDecision",
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evaluation_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
