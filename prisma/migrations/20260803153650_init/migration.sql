-- CreateEnum
CREATE TYPE "Role" AS ENUM ('REFERRER', 'CANDIDATE', 'MENTOR', 'HR', 'PROGRAM_OWNER', 'ADMIN_SECURITY', 'IT_ADMIN', 'LEGAL', 'SYSADMIN');

-- CreateEnum
CREATE TYPE "AiActionType" AS ENUM ('RESUME_PARSE', 'FORM_PREFILL', 'CONFIDENCE_SCORE', 'DUPLICATE_DETECTION', 'MISSING_INFO_CHECK', 'SMART_VALIDATION', 'EMAIL_DRAFT', 'SLA_RISK_PREDICTION', 'CHATBOT_ANSWER');

-- CreateEnum
CREATE TYPE "InternshipStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'MENTOR_REVIEW', 'HR_REVIEW', 'APPROVED', 'JOINING_PENDING', 'JOINING_SUBMITTED', 'VERIFIED', 'ID_ISSUED', 'NDA_PENDING', 'NDA_SIGNED', 'ACCESS_PROVISIONED', 'READY_TO_START', 'ACTIVE', 'EXTENDED', 'COMPLETED', 'CLOSED', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('RESUME', 'NDA', 'CONFIRMATION_LETTER', 'CERTIFICATE', 'GOVT_ID', 'EDUCATION_CERT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "department" TEXT,
    "site" TEXT,
    "managerId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "dob" TIMESTAMP(3) NOT NULL,
    "nationality" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "qualification" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "skills" TEXT[],
    "linkedinUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "unpaidConsent" BOOLEAN NOT NULL,
    "inPersonReady" BOOLEAN NOT NULL,
    "locationAligned" BOOLEAN NOT NULL,
    "priorRelationship" TEXT,
    "conflictDeclared" BOOLEAN NOT NULL DEFAULT false,
    "projectTitle" TEXT NOT NULL,
    "projectOverview" TEXT NOT NULL,
    "proposedStart" TIMESTAMP(3) NOT NULL,
    "proposedEnd" TIMESTAMP(3) NOT NULL,
    "site" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "status" "InternshipStatus" NOT NULL DEFAULT 'DRAFT',
    "aiParsed" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Internship" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "nonWorkerId" TEXT,
    "actualStart" TIMESTAMP(3),
    "actualEnd" TIMESTAMP(3),
    "status" "InternshipStatus" NOT NULL DEFAULT 'SUBMITTED',
    "adAccountActive" BOOLEAN NOT NULL DEFAULT false,
    "adDeactivatedAt" TIMESTAMP(3),
    "badgeNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Internship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JoiningRecord" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "emergencyContactName" TEXT NOT NULL,
    "emergencyContactPhone" TEXT NOT NULL,
    "govtIdType" TEXT NOT NULL,
    "govtIdNumber" TEXT NOT NULL,
    "educationHistory" JSONB NOT NULL,
    "employmentHistory" JSONB,
    "consentVersion" TEXT NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JoiningRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "internshipId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "storageUri" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "internshipId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "assigneeRole" "Role" NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "slaBreached" BOOLEAN NOT NULL DEFAULT false,
    "escalationTier" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckIn" (
    "id" TEXT NOT NULL,
    "internshipId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "concernFlag" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL,
    "internshipId" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "storageUri" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "role" "Role",
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAction" (
    "id" TEXT NOT NULL,
    "type" "AiActionType" NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "input" JSONB,
    "output" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION,
    "modelUsed" TEXT NOT NULL,
    "humanOverride" BOOLEAN NOT NULL DEFAULT false,
    "overriddenBy" TEXT,
    "overriddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Internship_referralId_key" ON "Internship"("referralId");

-- CreateIndex
CREATE UNIQUE INDEX "JoiningRecord_candidateId_key" ON "JoiningRecord"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_internshipId_key" ON "Certificate"("internshipId");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_referenceNumber_key" ON "Certificate"("referenceNumber");

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Internship" ADD CONSTRAINT "Internship_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Internship" ADD CONSTRAINT "Internship_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JoiningRecord" ADD CONSTRAINT "JoiningRecord_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_internshipId_fkey" FOREIGN KEY ("internshipId") REFERENCES "Internship"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_internshipId_fkey" FOREIGN KEY ("internshipId") REFERENCES "Internship"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckIn" ADD CONSTRAINT "CheckIn_internshipId_fkey" FOREIGN KEY ("internshipId") REFERENCES "Internship"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_internshipId_fkey" FOREIGN KEY ("internshipId") REFERENCES "Internship"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
