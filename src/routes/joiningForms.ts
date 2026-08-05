import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { DocumentType, InternshipStatus } from "@prisma/client";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX } from "../middleware/rbac";
import { withAudit } from "../lib/withAudit";
import { prisma } from "../lib/prisma";
import { transition } from "../lib/transition";
import { addBusinessDays } from "../lib/businessDays";
import { completeTask } from "../lib/tasks";
import { saveUploadedFile } from "../lib/uploads";
import { canViewUnmaskedPii, maskJoiningRecord } from "../lib/pii";
import { findCandidateForUser, findActiveInternshipForCandidate } from "../lib/candidateContext";
import { joiningFormMissingInfoCheck, joiningFormSmartValidation } from "../lib/ai";
import { sendTemplatedEmail } from "../lib/notifications";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const JOINING_FORM_EDITABLE_FIELDS = [
  "address",
  "emergencyContactName",
  "emergencyContactPhone",
  "govtIdType",
  "govtIdNumber",
  "educationHistory",
  "employmentHistory",
  "dob",
  "consentVersion",
  "consentedAt",
] as const;
const DATE_FIELDS = new Set(["dob", "consentedAt"]);

async function loadOwnedJoiningRecord(id: string, userId: string) {
  const record = await prisma.joiningRecord.findUnique({ where: { id }, include: { candidate: true } });
  if (!record) return { error: "not_found" as const };
  if (record.candidate.userId !== userId) return { error: "forbidden" as const };
  return { record };
}

router.post("/", authenticate, requireRole(...PERMISSION_MATRIX.joiningRecord.create), async (req, res) => {
  const candidate = await findCandidateForUser(req.user!.userId);
  if (!candidate) {
    res.status(404).json({ error: "No candidate profile is linked to this account" });
    return;
  }

  const internship = await findActiveInternshipForCandidate(candidate.id);
  if (!internship) {
    res.status(409).json({ error: "No internship found for this candidate" });
    return;
  }
  if (internship.status !== InternshipStatus.JOINING_PENDING) {
    res.status(409).json({ error: `Internship is in status ${internship.status}, expected JOINING_PENDING` });
    return;
  }

  const existing = await prisma.joiningRecord.findUnique({ where: { candidateId: candidate.id } });
  if (existing) {
    res.status(409).json({ error: "A joining form already exists for this candidate", joiningFormId: existing.id });
    return;
  }

  const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

  const joiningRecord = await withAudit(
    {
      ...actor,
      action: "CREATE",
      entity: "JoiningRecord",
      entityId: (created) => created.id,
      after: { candidateId: candidate.id, internshipId: internship.id },
    },
    () => prisma.joiningRecord.create({ data: { candidateId: candidate.id, internshipId: internship.id } })
  );

  res.status(201).json({ joiningRecord });
});

const patchSchema = z
  .object({
    address: z.string().optional(),
    emergencyContactName: z.string().optional(),
    emergencyContactPhone: z.string().optional(),
    govtIdType: z.string().optional(),
    govtIdNumber: z.string().optional(),
    educationHistory: z.array(z.record(z.string(), z.unknown())).optional(),
    employmentHistory: z.array(z.record(z.string(), z.unknown())).optional(),
    dob: z.coerce.date().optional(),
    consentVersion: z.string().optional(),
    consentedAt: z.coerce.date().optional(),
  })
  .strict();

router.patch("/:id", authenticate, requireRole(...PERMISSION_MATRIX.joiningRecord.update), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  const parsedBody = patchSchema.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
    return;
  }

  const loaded = await loadOwnedJoiningRecord(parsedParams.data.id, req.user!.userId);
  if (loaded.error === "not_found") {
    res.status(404).json({ error: "Joining form not found" });
    return;
  }
  if (loaded.error === "forbidden") {
    res.status(403).json({ error: "This is not your joining form" });
    return;
  }
  const record = loaded.record!;

  if (record.locked) {
    res.status(409).json({ error: "Joining form is locked; ask HR to unlock it before editing" });
    return;
  }

  let allowedFields: readonly string[] = JOINING_FORM_EDITABLE_FIELDS;
  if (record.submittedAt) {
    if (record.correctionFields.length === 0) {
      res.status(409).json({ error: "Joining form already submitted and awaiting HR verification" });
      return;
    }
    allowedFields = record.correctionFields;
  }

  const requestedFields = Object.keys(parsedBody.data);
  const disallowed = requestedFields.filter((f) => !allowedFields.includes(f));
  if (disallowed.length > 0) {
    res.status(400).json({ error: "Some fields are not editable right now", disallowed, allowedFields });
    return;
  }

  const data = parsedBody.data as Record<string, unknown>;
  for (const field of DATE_FIELDS) {
    if (field in data && data[field]) data[field] = new Date(data[field] as string);
  }

  const updated = await withAudit(
    {
      actorId: req.user!.userId,
      role: req.user!.role,
      action: "UPDATE",
      entity: "JoiningRecord",
      entityId: record.id,
      before: Object.fromEntries(requestedFields.map((f) => [f, (record as Record<string, unknown>)[f]])),
      after: data,
      ip: req.ip ?? null,
    },
    () => prisma.joiningRecord.update({ where: { id: record.id }, data })
  );

  res.json({ joiningRecord: updated });
});

router.post(
  "/:id/attachments",
  authenticate,
  requireRole(...PERMISSION_MATRIX.joiningRecord.uploadAttachment),
  upload.single("file"),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const parsedBody = z.object({ documentType: z.enum(["GOVT_ID", "EDUCATION_CERT"]) }).safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "A 'file' upload is required" });
      return;
    }

    const loaded = await loadOwnedJoiningRecord(parsedParams.data.id, req.user!.userId);
    if (loaded.error === "not_found") {
      res.status(404).json({ error: "Joining form not found" });
      return;
    }
    if (loaded.error === "forbidden") {
      res.status(403).json({ error: "This is not your joining form" });
      return;
    }
    const record = loaded.record!;
    if (record.locked) {
      res.status(409).json({ error: "Joining form is locked; ask HR to unlock it before uploading" });
      return;
    }
    if (!record.internshipId) {
      res.status(409).json({ error: "Joining form is not linked to an internship" });
      return;
    }

    const { storageUri, sha256 } = await saveUploadedFile(record.internshipId, req.file);
    const documentType = parsedBody.data.documentType as DocumentType;
    const existingCount = await prisma.document.count({
      where: { internshipId: record.internshipId, type: documentType },
    });

    const document = await withAudit(
      {
        actorId: req.user!.userId,
        role: req.user!.role,
        action: "CREATE",
        entity: "Document",
        entityId: (created) => created.id,
        after: { type: documentType, internshipId: record.internshipId, sha256 },
        ip: req.ip ?? null,
      },
      () =>
        prisma.document.create({
          data: {
            internshipId: record.internshipId!,
            type: documentType,
            storageUri,
            sha256,
            version: existingCount + 1,
          },
        })
    );

    res.status(201).json({ document });
  }
);

router.get("/:id", authenticate, requireRole(...PERMISSION_MATRIX.joiningRecord.read), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const record = await prisma.joiningRecord.findUnique({ where: { id: parsedParams.data.id }, include: { candidate: true } });
  if (!record) {
    res.status(404).json({ error: "Joining form not found" });
    return;
  }
  if (req.user!.role === "CANDIDATE" && record.candidate.userId !== req.user!.userId) {
    res.status(403).json({ error: "This is not your joining form" });
    return;
  }

  const reveal = req.query.reveal === "true";
  if (reveal && canViewUnmaskedPii(req.user!.role)) {
    await prisma.auditEvent.create({
      data: {
        actorId: req.user!.userId,
        role: req.user!.role,
        action: "PII_REVEAL",
        entity: "JoiningRecord",
        entityId: record.id,
        ip: req.ip ?? null,
      },
    });
  }

  // Strip the nested candidate relation before responding — it was only
  // loaded for the ownership check above, and candidate.dob is unmasked
  // PII that maskJoiningRecord() doesn't (and shouldn't have to) reach into.
  const { candidate: _candidate, ...recordWithoutCandidate } = record;
  res.json({ joiningRecord: maskJoiningRecord(recordWithoutCandidate, req.user!.role, reveal) });
});

const MANDATORY_SUBMIT_FIELDS = [
  "address",
  "emergencyContactName",
  "emergencyContactPhone",
  "govtIdType",
  "govtIdNumber",
  "consentVersion",
  "consentedAt",
] as const;

router.post("/:id/submit", authenticate, requireRole(...PERMISSION_MATRIX.joiningRecord.submit), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const loaded = await loadOwnedJoiningRecord(parsedParams.data.id, req.user!.userId);
  if (loaded.error === "not_found") {
    res.status(404).json({ error: "Joining form not found" });
    return;
  }
  if (loaded.error === "forbidden") {
    res.status(403).json({ error: "This is not your joining form" });
    return;
  }
  const record = loaded.record!;
  if (record.locked) {
    res.status(409).json({ error: "Joining form is locked" });
    return;
  }
  if (!record.internshipId) {
    res.status(409).json({ error: "Joining form is not linked to an internship" });
    return;
  }

  const internship = await prisma.internship.findUnique({ where: { id: record.internshipId } });
  if (!internship || internship.status !== InternshipStatus.JOINING_PENDING) {
    res.status(409).json({ error: `Internship is in status ${internship?.status}, expected JOINING_PENDING` });
    return;
  }

  const missingFields = MANDATORY_SUBMIT_FIELDS.filter((f) => !(record as Record<string, unknown>)[f]);
  const educationHistory = Array.isArray(record.educationHistory) ? record.educationHistory : [];
  if (educationHistory.length === 0) missingFields.push("educationHistory" as never);
  if (missingFields.length > 0) {
    res.status(400).json({ error: "Joining form is missing mandatory fields", missingFields });
    return;
  }

  const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

  const missingInfo = await joiningFormMissingInfoCheck({
    address: record.address,
    emergencyContactName: record.emergencyContactName,
    emergencyContactPhone: record.emergencyContactPhone,
    govtIdType: record.govtIdType,
    govtIdProvided: Boolean(record.govtIdNumber),
    educationHistory: educationHistory as { institution?: unknown; qualification?: unknown; endYear?: unknown }[],
    employmentHistory: Array.isArray(record.employmentHistory) ? record.employmentHistory : null,
    entityId: record.id,
    actorId: actor.actorId,
  });

  const validation = await joiningFormSmartValidation({
    joiningDob: record.dob,
    candidateDob: record.candidate.dob,
    emergencyContactPhone: record.emergencyContactPhone,
    candidatePhone: record.candidate.phone,
    educationHistory: educationHistory as { endYear?: unknown }[],
    entityId: record.id,
    actorId: actor.actorId,
  });

  const updated = await withAudit(
    {
      ...actor,
      action: "SUBMIT",
      entity: "JoiningRecord",
      entityId: record.id,
      before: { submittedAt: null },
      after: { submittedAt: new Date() },
    },
    () => prisma.joiningRecord.update({ where: { id: record.id }, data: { submittedAt: new Date() } })
  );

  const updatedInternship = await transition({
    entity: "INTERNSHIP",
    entityId: internship.id,
    from: InternshipStatus.JOINING_PENDING,
    to: InternshipStatus.JOINING_SUBMITTED,
    ...actor,
  });

  await withAudit(
    {
      ...actor,
      action: "CREATE",
      entity: "Task",
      entityId: (created) => created.id,
      after: { type: "HR_VERIFY_JOINING", internshipId: internship.id },
    },
    () =>
      prisma.task.create({
        data: {
          internshipId: internship.id,
          type: "HR_VERIFY_JOINING",
          assigneeRole: "HR",
          dueAt: addBusinessDays(new Date(), 2),
        },
      })
  );

  res.json({
    joiningRecord: maskJoiningRecord(updated, req.user!.role, false),
    internship: updatedInternship,
    missingInfo,
    validation,
  });
});

const verifySchema = z
  .object({
    decision: z.enum(["LOCK", "RETURN_FOR_CORRECTION"]),
    reason: z.string().optional(),
    fieldsToCorrect: z.array(z.string()).optional(),
  })
  .refine((data) => data.decision === "LOCK" || (data.reason && data.reason.length > 0), {
    message: "reason is required for RETURN_FOR_CORRECTION",
    path: ["reason"],
  })
  .refine(
    (data) => data.decision !== "RETURN_FOR_CORRECTION" || (data.fieldsToCorrect && data.fieldsToCorrect.length > 0),
    { message: "fieldsToCorrect is required for RETURN_FOR_CORRECTION", path: ["fieldsToCorrect"] }
  );

router.post("/:id/verify", authenticate, requireRole(...PERMISSION_MATRIX.joiningRecord.verify), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  const parsedBody = verifySchema.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
    return;
  }
  const { decision, reason, fieldsToCorrect } = parsedBody.data;

  if (fieldsToCorrect) {
    const invalid = fieldsToCorrect.filter((f) => !JOINING_FORM_EDITABLE_FIELDS.includes(f as never));
    if (invalid.length > 0) {
      res.status(400).json({ error: "fieldsToCorrect contains fields that are not editable", invalid });
      return;
    }
  }

  const record = await prisma.joiningRecord.findUnique({
    where: { id: parsedParams.data.id },
    include: { candidate: true },
  });
  if (!record) {
    res.status(404).json({ error: "Joining form not found" });
    return;
  }
  if (!record.internshipId) {
    res.status(409).json({ error: "Joining form is not linked to an internship" });
    return;
  }
  const internship = await prisma.internship.findUnique({ where: { id: record.internshipId } });
  const acceptableStatuses: InternshipStatus[] = [InternshipStatus.JOINING_SUBMITTED, InternshipStatus.VERIFIED];
  if (!internship || !acceptableStatuses.includes(internship.status)) {
    res.status(409).json({ error: `Internship is in status ${internship?.status}, expected JOINING_SUBMITTED` });
    return;
  }

  const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

  if (decision === "RETURN_FOR_CORRECTION") {
    if (record.locked) {
      res.status(409).json({ error: "Joining form is locked; unlock it first" });
      return;
    }
    const updated = await withAudit(
      {
        ...actor,
        action: "RETURN_FOR_CORRECTION",
        entity: "JoiningRecord",
        entityId: record.id,
        before: { correctionFields: record.correctionFields },
        after: { correctionFields: fieldsToCorrect, reason },
      },
      () => prisma.joiningRecord.update({ where: { id: record.id }, data: { correctionFields: fieldsToCorrect } })
    );
    await sendTemplatedEmail({
      to: record.candidate.email,
      templateId: "T08_RETURNED_FOR_CORRECTION",
      mergeData: {
        recipientName: record.candidate.fullName,
        reviewerRole: "HR",
        correctionFields: fieldsToCorrect!.join(", "),
        reason,
      },
      internshipId: record.internshipId,
    });
    res.json({ joiningRecord: maskJoiningRecord(updated, req.user!.role, false), message: "Returned to candidate for correction" });
    return;
  }

  // LOCK
  if (record.locked) {
    res.status(409).json({ error: "Joining form is already locked" });
    return;
  }

  const lockedRecord = await withAudit(
    {
      ...actor,
      action: "LOCK",
      entity: "JoiningRecord",
      entityId: record.id,
      before: { locked: false },
      after: { locked: true, correctionFields: [] },
    },
    () =>
      prisma.joiningRecord.update({
        where: { id: record.id },
        data: { locked: true, lockedAt: new Date(), lockedBy: req.user!.userId, correctionFields: [] },
      })
  );

  let updatedInternship = internship;
  if (internship.status === InternshipStatus.JOINING_SUBMITTED) {
    updatedInternship = (await transition({
      entity: "INTERNSHIP",
      entityId: internship.id,
      from: InternshipStatus.JOINING_SUBMITTED,
      to: InternshipStatus.VERIFIED,
      ...actor,
    })) as typeof internship;

    const pendingTask = await prisma.task.findFirst({
      where: { internshipId: internship.id, type: "HR_VERIFY_JOINING", completedAt: null },
    });
    if (pendingTask) await completeTask(pendingTask.id, actor);
  }

  const existingNonWorkerTask = await prisma.task.findFirst({
    where: { internshipId: internship.id, type: "NON_WORKER_ID" },
  });
  let nonWorkerIdTask = existingNonWorkerTask;
  if (!existingNonWorkerTask) {
    nonWorkerIdTask = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "Task",
        entityId: (created) => created.id,
        after: { type: "NON_WORKER_ID", internshipId: internship.id },
      },
      () =>
        prisma.task.create({
          data: {
            internshipId: internship.id,
            type: "NON_WORKER_ID",
            assigneeRole: "HR",
            dueAt: addBusinessDays(new Date(), 1),
          },
        })
    );
  }

  res.json({
    joiningRecord: maskJoiningRecord(lockedRecord, req.user!.role, false),
    internship: updatedInternship,
    nonWorkerIdTask,
  });
});

router.post("/:id/unlock", authenticate, requireRole(...PERMISSION_MATRIX.joiningRecord.unlock), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  const parsedBody = z.object({ reason: z.string().min(1) }).safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
    return;
  }

  const record = await prisma.joiningRecord.findUnique({ where: { id: parsedParams.data.id } });
  if (!record) {
    res.status(404).json({ error: "Joining form not found" });
    return;
  }
  if (!record.locked) {
    res.status(409).json({ error: "Joining form is not locked" });
    return;
  }
  if (record.internshipId) {
    const internship = await prisma.internship.findUnique({ where: { id: record.internshipId } });
    if (internship && internship.status !== InternshipStatus.VERIFIED) {
      res.status(409).json({ error: `Cannot unlock once the internship has moved past VERIFIED (currently ${internship.status})` });
      return;
    }
  }

  const updated = await withAudit(
    {
      actorId: req.user!.userId,
      role: req.user!.role,
      action: "UNLOCK",
      entity: "JoiningRecord",
      entityId: record.id,
      before: { locked: true },
      after: { locked: false, reason: parsedBody.data.reason },
      ip: req.ip ?? null,
    },
    () =>
      prisma.joiningRecord.update({
        where: { id: record.id },
        data: { locked: false, lockedAt: null, lockedBy: null },
      })
  );

  res.json({ joiningRecord: maskJoiningRecord(updated, req.user!.role, false) });
});

export default router;
