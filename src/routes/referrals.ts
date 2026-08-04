import { Router } from "express";
import { z } from "zod";
import { InternshipStatus } from "@prisma/client";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX } from "../middleware/rbac";
import { withAudit } from "../lib/withAudit";
import { prisma } from "../lib/prisma";
import { transition } from "../lib/transition";
import { addBusinessDays } from "../lib/businessDays";
import { sendTemplatedEmail } from "../lib/notifications";

const router = Router();

const CONFLICT_KEYWORDS = /\b(family|relative|spouse|sibling|parent|child|cousin|uncle|aunt|niece|nephew|close friend)\b/i;

const createReferralSchema = z.object({
  candidateId: z.string().min(1),
  mentorId: z.string().min(1),
  unpaidConsent: z.boolean(),
  inPersonReady: z.boolean(),
  locationAligned: z.boolean(),
  priorRelationship: z.string().min(1),
  projectTitle: z.string().min(1),
  projectOverview: z.string().min(1),
  proposedStart: z.coerce.date(),
  proposedEnd: z.coerce.date(),
  site: z.string().min(1),
  department: z.string().min(1),
});

router.post("/", authenticate, requireRole(...PERMISSION_MATRIX.referral.create), async (req, res) => {
  const parsed = createReferralSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const data = parsed.data;

  const fieldErrors: { field: string; error: string }[] = [];
  if (!data.unpaidConsent) fieldErrors.push({ field: "unpaidConsent", error: "Must be true to submit a referral" });
  if (!data.inPersonReady) fieldErrors.push({ field: "inPersonReady", error: "Must be true to submit a referral" });
  if (!data.locationAligned) fieldErrors.push({ field: "locationAligned", error: "Must be true to submit a referral" });
  if (fieldErrors.length > 0) {
    res.status(400).json({ error: "Referral does not meet submission requirements", fieldErrors });
    return;
  }

  const conflictDeclared = CONFLICT_KEYWORDS.test(data.priorRelationship);

  const referral = await withAudit(
    {
      actorId: req.user!.userId,
      role: req.user!.role,
      action: "CREATE",
      entity: "Referral",
      entityId: (created) => created.id,
      after: { ...data, conflictDeclared },
      ip: req.ip ?? null,
    },
    () =>
      prisma.referral.create({
        data: {
          candidateId: data.candidateId,
          referrerId: req.user!.userId,
          mentorId: data.mentorId,
          unpaidConsent: data.unpaidConsent,
          inPersonReady: data.inPersonReady,
          locationAligned: data.locationAligned,
          priorRelationship: data.priorRelationship,
          conflictDeclared,
          projectTitle: data.projectTitle,
          projectOverview: data.projectOverview,
          proposedStart: data.proposedStart,
          proposedEnd: data.proposedEnd,
          site: data.site,
          department: data.department,
        },
      })
  );

  const submitted = await transition({
    entity: "REFERRAL",
    entityId: referral.id,
    from: InternshipStatus.DRAFT,
    to: InternshipStatus.SUBMITTED,
    actorId: req.user!.userId,
    role: req.user!.role,
    ip: req.ip ?? null,
  });

  const task = await withAudit(
    {
      actorId: req.user!.userId,
      role: req.user!.role,
      action: "CREATE",
      entity: "Task",
      entityId: (created) => created.id,
      after: { type: "MENTOR_CONFIRM", referralId: referral.id },
      ip: req.ip ?? null,
    },
    () =>
      prisma.task.create({
        data: {
          referralId: referral.id,
          type: "MENTOR_CONFIRM",
          assigneeRole: "MENTOR",
          dueAt: addBusinessDays(new Date(), 2),
        },
      })
  );

  const [candidate, referrerUser, mentorUser] = await Promise.all([
    prisma.candidate.findUnique({ where: { id: data.candidateId } }),
    prisma.user.findUnique({ where: { id: req.user!.userId } }),
    prisma.user.findUnique({ where: { id: data.mentorId } }),
  ]);
  if (candidate && referrerUser) {
    await sendTemplatedEmail({
      to: referrerUser.email,
      templateId: "T01_REFERRAL_RECEIVED",
      mergeData: { referrerName: referrerUser.name, candidateName: candidate.fullName, projectTitle: data.projectTitle },
    });
  }
  if (candidate && referrerUser && mentorUser) {
    await sendTemplatedEmail({
      to: mentorUser.email,
      templateId: "T02_MENTOR_CONFIRM_REQUEST",
      mergeData: {
        mentorName: mentorUser.name,
        referrerName: referrerUser.name,
        candidateName: candidate.fullName,
        projectTitle: data.projectTitle,
      },
    });
  }

  res.status(201).json({ referral: submitted, task });
});

const REFERRAL_OVERRIDE_FIELDS = [
  "projectTitle",
  "projectOverview",
  "proposedStart",
  "proposedEnd",
  "site",
  "department",
  "priorRelationship",
] as const;
const CANDIDATE_OVERRIDE_FIELDS = [
  "fullName",
  "email",
  "phone",
  "qualification",
  "institution",
  "skills",
  "nationality",
  "city",
] as const;
const DATE_FIELDS = new Set(["proposedStart", "proposedEnd"]);

const hrReviewSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "RETURN_FOR_CORRECTION"]),
    reason: z.string().optional(),
    fieldsToCorrect: z.array(z.string()).optional(),
  })
  .refine((data) => data.decision === "APPROVE" || (data.reason && data.reason.length > 0), {
    message: "reason is required for REJECT and RETURN_FOR_CORRECTION",
    path: ["reason"],
  })
  .refine(
    (data) => data.decision !== "RETURN_FOR_CORRECTION" || (data.fieldsToCorrect && data.fieldsToCorrect.length > 0),
    { message: "fieldsToCorrect is required for RETURN_FOR_CORRECTION", path: ["fieldsToCorrect"] }
  );

router.post("/:id/hr-review", authenticate, requireRole(...PERMISSION_MATRIX.referral.hrReview), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  const parsedBody = hrReviewSchema.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
    return;
  }
  const { id } = parsedParams.data;
  const { decision, reason, fieldsToCorrect } = parsedBody.data;

  if (fieldsToCorrect) {
    const correctableFields: readonly string[] = [...REFERRAL_OVERRIDE_FIELDS, ...CANDIDATE_OVERRIDE_FIELDS];
    const invalid = fieldsToCorrect.filter((f) => !correctableFields.includes(f));
    if (invalid.length > 0) {
      res.status(400).json({ error: "fieldsToCorrect contains fields that are not overridable", invalid });
      return;
    }
  }

  const referral = await prisma.referral.findUnique({
    where: { id },
    include: { internship: true, candidate: true, referrer: true },
  });
  if (!referral) {
    res.status(404).json({ error: "Referral not found" });
    return;
  }
  if (!referral.internship) {
    res.status(409).json({ error: "No internship exists yet for this referral" });
    return;
  }
  if (referral.internship.status !== InternshipStatus.HR_REVIEW) {
    res.status(409).json({ error: `Internship is in status ${referral.internship.status}, expected HR_REVIEW` });
    return;
  }

  const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

  if (decision === "REJECT") {
    const updatedInternship = await transition({
      entity: "INTERNSHIP",
      entityId: referral.internship.id,
      from: InternshipStatus.HR_REVIEW,
      to: InternshipStatus.REJECTED,
      ...actor,
      reason,
    });
    const updatedReferral = await transition({
      entity: "REFERRAL",
      entityId: referral.id,
      from: referral.status,
      to: InternshipStatus.REJECTED,
      ...actor,
      reason,
    });
    await sendTemplatedEmail({
      to: referral.referrer.email,
      templateId: "T22_REJECTION_DECLINE",
      mergeData: { recipientName: referral.referrer.name, candidateName: referral.candidate.fullName, decisionWord: "rejected", reason },
      internshipId: referral.internship.id,
    });
    res.json({ referral: updatedReferral, internship: updatedInternship });
    return;
  }

  if (decision === "RETURN_FOR_CORRECTION") {
    const updatedReferral = await withAudit(
      {
        ...actor,
        action: "RETURN_FOR_CORRECTION",
        entity: "Referral",
        entityId: referral.id,
        before: { correctionFields: referral.correctionFields },
        after: { correctionFields: fieldsToCorrect, reason },
      },
      () => prisma.referral.update({ where: { id: referral.id }, data: { correctionFields: fieldsToCorrect } })
    );
    await sendTemplatedEmail({
      to: referral.referrer.email,
      templateId: "T08_RETURNED_FOR_CORRECTION",
      mergeData: {
        recipientName: referral.referrer.name,
        reviewerRole: "HR",
        correctionFields: fieldsToCorrect!.join(", "),
        reason,
      },
      internshipId: referral.internship.id,
    });
    res.json({ referral: updatedReferral, message: "Returned to referrer for correction" });
    return;
  }

  // APPROVE
  if (referral.correctionFields.length > 0) {
    await withAudit(
      {
        ...actor,
        action: "CLEAR_CORRECTION_FIELDS",
        entity: "Referral",
        entityId: referral.id,
        before: { correctionFields: referral.correctionFields },
        after: { correctionFields: [] },
      },
      () => prisma.referral.update({ where: { id: referral.id }, data: { correctionFields: [] } })
    );
  }

  await transition({
    entity: "INTERNSHIP",
    entityId: referral.internship.id,
    from: InternshipStatus.HR_REVIEW,
    to: InternshipStatus.APPROVED,
    ...actor,
  });
  const updatedInternship = await transition({
    entity: "INTERNSHIP",
    entityId: referral.internship.id,
    from: InternshipStatus.APPROVED,
    to: InternshipStatus.JOINING_PENDING,
    ...actor,
  });

  const task = await withAudit(
    {
      ...actor,
      action: "CREATE",
      entity: "Task",
      entityId: (created) => created.id,
      after: { type: "JOINING_FORM_ISSUED", internshipId: referral.internship.id },
    },
    () =>
      prisma.task.create({
        data: {
          internshipId: referral.internship!.id,
          type: "JOINING_FORM_ISSUED",
          assigneeRole: "CANDIDATE",
          dueAt: new Date(),
        },
      })
  );

  // Day 6: real sends replace the Day 3 "queued" NotificationLog stub —
  // T04/T05 are new (referrer + candidate), T06 is what that stub used to be.
  const [, , notification] = await Promise.all([
    sendTemplatedEmail({
      to: referral.referrer.email,
      templateId: "T04_REFERRAL_APPROVED",
      mergeData: { referrerName: referral.referrer.name, candidateName: referral.candidate.fullName },
      internshipId: referral.internship.id,
    }),
    sendTemplatedEmail({
      to: referral.candidate.email,
      templateId: "T05_CONGRATULATIONS",
      mergeData: { candidateName: referral.candidate.fullName, projectTitle: referral.projectTitle },
      internshipId: referral.internship.id,
    }),
    sendTemplatedEmail({
      to: referral.candidate.email,
      templateId: "T06_JOINING_FORM_ISSUED",
      mergeData: { candidateName: referral.candidate.fullName, projectTitle: referral.projectTitle },
      internshipId: referral.internship.id,
    }),
  ]);

  res.json({ internship: updatedInternship, task, notification });
});

const overrideSchema = z.object({
  entity: z.enum(["REFERRAL", "CANDIDATE"]),
  field: z.string().min(1),
  value: z.unknown(),
  aiActionId: z.string().min(1),
});

router.patch("/:id/override", authenticate, requireRole(...PERMISSION_MATRIX.referral.override), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  const parsedBody = overrideSchema.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
    return;
  }
  const { id } = parsedParams.data;
  const { entity, field, value, aiActionId } = parsedBody.data;

  const referral = await prisma.referral.findUnique({ where: { id }, include: { candidate: true } });
  if (!referral) {
    res.status(404).json({ error: "Referral not found" });
    return;
  }

  const allowedFields: readonly string[] = entity === "REFERRAL" ? REFERRAL_OVERRIDE_FIELDS : CANDIDATE_OVERRIDE_FIELDS;
  if (!allowedFields.includes(field)) {
    res.status(400).json({ error: `Field '${field}' is not overridable on ${entity}`, allowedFields });
    return;
  }

  // While HR has the referral in a RETURN_FOR_CORRECTION hold, only the
  // fields HR named remain editable — everything else in the normal
  // whitelist is locked until HR clears correctionFields (on the next
  // hr-review decision).
  if (referral.correctionFields.length > 0 && !referral.correctionFields.includes(field)) {
    res.status(400).json({
      error: `Field '${field}' is not in the current correction list`,
      correctionFields: referral.correctionFields,
    });
    return;
  }

  const coercedValue = DATE_FIELDS.has(field) ? new Date(value as string) : value;
  const targetBefore: Record<string, unknown> = entity === "REFERRAL" ? referral : referral.candidate;

  const result = await withAudit(
    {
      actorId: req.user!.userId,
      role: req.user!.role,
      action: "OVERRIDE_AI_FIELD",
      entity: entity === "REFERRAL" ? "Referral" : "Candidate",
      entityId: entity === "REFERRAL" ? referral.id : referral.candidateId,
      before: { [field]: targetBefore[field] },
      after: { [field]: coercedValue, aiActionId },
      ip: req.ip ?? null,
    },
    async () => {
      const updated =
        entity === "REFERRAL"
          ? await prisma.referral.update({ where: { id: referral.id }, data: { [field]: coercedValue } })
          : await prisma.candidate.update({ where: { id: referral.candidateId }, data: { [field]: coercedValue } });

      const aiAction = await prisma.aiAction.update({
        where: { id: aiActionId },
        data: { humanOverride: true, overriddenBy: req.user!.userId, overriddenAt: new Date() },
      });

      return { updated, aiAction };
    }
  );

  res.json(result);
});

const mentorConfirmSchema = z
  .object({
    decision: z.enum(["CONFIRM", "DECLINE"]),
    reason: z.string().optional(),
    amendedStart: z.coerce.date().optional(),
    amendedEnd: z.coerce.date().optional(),
  })
  .refine((data) => data.decision !== "DECLINE" || (data.reason && data.reason.length > 0), {
    message: "reason is required when declining",
    path: ["reason"],
  });

router.post(
  "/:id/mentor-confirm",
  authenticate,
  requireRole(...PERMISSION_MATRIX.referral.mentorConfirm),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const parsedBody = mentorConfirmSchema.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
      return;
    }
    const { id } = parsedParams.data;
    const { decision, reason, amendedStart, amendedEnd } = parsedBody.data;

    const referral = await prisma.referral.findUnique({ where: { id }, include: { candidate: true, referrer: true } });
    if (!referral) {
      res.status(404).json({ error: "Referral not found" });
      return;
    }
    if (referral.mentorId !== req.user!.userId) {
      res.status(403).json({ error: "You are not the assigned mentor for this referral" });
      return;
    }
    if (referral.status !== InternshipStatus.SUBMITTED) {
      res.status(409).json({ error: `Referral is in status ${referral.status}, expected SUBMITTED` });
      return;
    }

    const pendingTask = await prisma.task.findFirst({
      where: { referralId: referral.id, type: "MENTOR_CONFIRM", completedAt: null },
    });

    if (decision === "DECLINE") {
      const updatedReferral = await transition({
        entity: "REFERRAL",
        entityId: referral.id,
        from: InternshipStatus.SUBMITTED,
        to: InternshipStatus.REJECTED,
        actorId: req.user!.userId,
        role: req.user!.role,
        ip: req.ip ?? null,
        reason,
      });

      if (pendingTask) {
        await withAudit(
          {
            actorId: req.user!.userId,
            role: req.user!.role,
            action: "COMPLETE",
            entity: "Task",
            entityId: pendingTask.id,
            before: { completedAt: null },
            after: { completedAt: new Date(), reason: `declined: ${reason}` },
            ip: req.ip ?? null,
          },
          () => prisma.task.update({ where: { id: pendingTask.id }, data: { completedAt: new Date() } })
        );
      }

      await sendTemplatedEmail({
        to: referral.referrer.email,
        templateId: "T22_REJECTION_DECLINE",
        mergeData: {
          recipientName: referral.referrer.name,
          candidateName: referral.candidate.fullName,
          decisionWord: "declined by the mentor",
          reason,
        },
      });

      res.json({ referral: updatedReferral });
      return;
    }

    // CONFIRM
    if (amendedStart || amendedEnd) {
      await withAudit(
        {
          actorId: req.user!.userId,
          role: req.user!.role,
          action: "UPDATE",
          entity: "Referral",
          entityId: referral.id,
          before: { proposedStart: referral.proposedStart, proposedEnd: referral.proposedEnd },
          after: { proposedStart: amendedStart ?? referral.proposedStart, proposedEnd: amendedEnd ?? referral.proposedEnd },
          ip: req.ip ?? null,
        },
        () =>
          prisma.referral.update({
            where: { id: referral.id },
            data: {
              ...(amendedStart ? { proposedStart: amendedStart } : {}),
              ...(amendedEnd ? { proposedEnd: amendedEnd } : {}),
            },
          })
      );
    }

    await transition({
      entity: "REFERRAL",
      entityId: referral.id,
      from: InternshipStatus.SUBMITTED,
      to: InternshipStatus.MENTOR_REVIEW,
      actorId: req.user!.userId,
      role: req.user!.role,
      ip: req.ip ?? null,
    });

    const internship = await withAudit(
      {
        actorId: req.user!.userId,
        role: req.user!.role,
        action: "CREATE",
        entity: "Internship",
        entityId: (created) => created.id,
        after: { referralId: referral.id, mentorId: referral.mentorId },
        ip: req.ip ?? null,
      },
      () =>
        prisma.internship.create({
          data: {
            referralId: referral.id,
            mentorId: referral.mentorId,
            status: InternshipStatus.MENTOR_REVIEW,
          },
        })
    );

    const updatedInternship = await transition({
      entity: "INTERNSHIP",
      entityId: internship.id,
      from: InternshipStatus.MENTOR_REVIEW,
      to: InternshipStatus.HR_REVIEW,
      actorId: req.user!.userId,
      role: req.user!.role,
      ip: req.ip ?? null,
    });

    if (pendingTask) {
      await withAudit(
        {
          actorId: req.user!.userId,
          role: req.user!.role,
          action: "COMPLETE",
          entity: "Task",
          entityId: pendingTask.id,
          before: { completedAt: null },
          after: { completedAt: new Date() },
          ip: req.ip ?? null,
        },
        () => prisma.task.update({ where: { id: pendingTask.id }, data: { completedAt: new Date() } })
      );
    }

    const finalReferral = await prisma.referral.findUnique({ where: { id: referral.id } });

    res.json({ referral: finalReferral, internship: updatedInternship });
  }
);

export default router;
