import { Router } from "express";
import { z } from "zod";
import { Internship, InternshipStatus, Prisma, Role } from "@prisma/client";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX } from "../middleware/rbac";
import { prisma } from "../lib/prisma";
import { withAudit } from "../lib/withAudit";
import { transition } from "../lib/transition";
import { sendTemplatedEmail } from "../lib/notifications";

const router = Router();

interface ExtensionPayload {
  requestedEndDate: string;
  justification: string;
  hrApproved: boolean;
  hrApprovedBy: string | null;
  hrApprovedAt: string | null;
  programOwnerApproved: boolean;
  programOwnerApprovedBy: string | null;
  programOwnerApprovedAt: string | null;
}

const decideSchema = z.object({ decision: z.enum(["APPROVE", "REJECT"]) });

// HR and PROGRAM_OWNER each call this separately with their own token —
// requireRole guarantees req.user!.role is one of the two here, so both
// approvals must come from two distinct requests, not one caller wearing
// two hats.
router.post("/:taskId/decide", authenticate, requireRole(...PERMISSION_MATRIX.extension.decide), async (req, res) => {
  const parsedParams = z.object({ taskId: z.string().min(1) }).safeParse(req.params);
  const parsedBody = decideSchema.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
    return;
  }
  const { taskId } = parsedParams.data;
  const { decision } = parsedBody.data;

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (task.type !== "EXTENSION_REQUEST") {
    res.status(409).json({ error: "Task is not an EXTENSION_REQUEST" });
    return;
  }
  if (task.completedAt) {
    res.status(409).json({ error: "This extension request has already been decided" });
    return;
  }
  if (!task.internshipId) {
    res.status(409).json({ error: "Extension request has no linked internship" });
    return;
  }

  const payload = task.payload as unknown as ExtensionPayload | null;
  if (!payload) {
    res.status(500).json({ error: "Extension request task is missing its payload" });
    return;
  }

  const role = req.user!.role;
  const alreadyDecided = role === Role.HR ? payload.hrApproved : payload.programOwnerApproved;
  if (alreadyDecided) {
    res.status(409).json({ error: `${role} has already recorded a decision on this extension request` });
    return;
  }

  const actor = { actorId: req.user!.userId, role, ip: req.ip ?? null };

  const internshipForNotice = await prisma.internship.findUnique({
    where: { id: task.internshipId },
    include: { mentor: true, referral: { include: { candidate: true } } },
  });

  if (decision === "REJECT") {
    const rejectedTask = await withAudit(
      {
        ...actor,
        action: "REJECT",
        entity: "Task",
        entityId: task.id,
        before: { completedAt: null },
        after: { completedAt: new Date(), rejectedBy: role },
      },
      () => prisma.task.update({ where: { id: task.id }, data: { completedAt: new Date() } })
    );
    if (internshipForNotice) {
      await sendTemplatedEmail({
        to: internshipForNotice.mentor.email,
        templateId: "T18_EXTENSION_OUTCOME",
        mergeData: {
          recipientName: internshipForNotice.mentor.name,
          candidateName: internshipForNotice.referral.candidate.fullName,
          requestedEndDate: payload.requestedEndDate.slice(0, 10),
          outcome: `rejected by ${role}`,
        },
        internshipId: internshipForNotice.id,
      });
    }
    res.json({ task: rejectedTask, message: `Extension request rejected by ${role}` });
    return;
  }

  // APPROVE
  const now = new Date();
  const updatedPayload: ExtensionPayload =
    role === Role.HR
      ? { ...payload, hrApproved: true, hrApprovedBy: req.user!.userId, hrApprovedAt: now.toISOString() }
      : {
          ...payload,
          programOwnerApproved: true,
          programOwnerApprovedBy: req.user!.userId,
          programOwnerApprovedAt: now.toISOString(),
        };

  const bothApproved = updatedPayload.hrApproved && updatedPayload.programOwnerApproved;

  const updatedTask = await withAudit(
    {
      ...actor,
      action: "APPROVE",
      entity: "Task",
      entityId: task.id,
      before: { payload: task.payload },
      after: { payload: updatedPayload, bothApproved },
    },
    () =>
      prisma.task.update({
        where: { id: task.id },
        data: {
          payload: updatedPayload as unknown as Prisma.InputJsonValue,
          ...(bothApproved ? { completedAt: now } : {}),
        },
      })
  );

  if (!bothApproved) {
    res.json({ task: updatedTask, message: `Recorded ${role} approval; waiting on the other approver` });
    return;
  }

  const requestedEndDate = new Date(updatedPayload.requestedEndDate);

  const internship = (await transition({
    entity: "INTERNSHIP",
    entityId: task.internshipId,
    from: InternshipStatus.ACTIVE,
    to: InternshipStatus.EXTENDED,
    ...actor,
  })) as Internship;

  const finalInternship = await withAudit(
    {
      ...actor,
      action: "UPDATE",
      entity: "Internship",
      entityId: task.internshipId,
      before: { actualEnd: internship.actualEnd },
      after: { actualEnd: requestedEndDate },
    },
    () => prisma.internship.update({ where: { id: task.internshipId! }, data: { actualEnd: requestedEndDate } })
  );

  // "call ADAdapter conceptually to extend account validity" — the adapter
  // interface (src/lib/adapters/ad.ts) only defines provision()/deactivate()
  // per CLAUDE.md rule 6, so there's no extend() to call yet; a real
  // extension call lands when a live adapter exists. For now this is just
  // an audit trail entry standing in for that future call.
  await prisma.auditEvent.create({
    data: {
      actorId: req.user!.userId,
      role,
      action: "AD_EXTEND_LOGGED",
      entity: "Internship",
      entityId: task.internshipId,
      after: { note: "ManualADAdapter has no live extend() call; logged only", newEndDate: requestedEndDate },
      ip: req.ip ?? null,
    },
  });

  if (internshipForNotice) {
    await sendTemplatedEmail({
      to: internshipForNotice.mentor.email,
      templateId: "T18_EXTENSION_OUTCOME",
      mergeData: {
        recipientName: internshipForNotice.mentor.name,
        candidateName: internshipForNotice.referral.candidate.fullName,
        requestedEndDate: updatedPayload.requestedEndDate.slice(0, 10),
        outcome: "approved by both HR and Program Owner",
      },
      internshipId: internshipForNotice.id,
    });
  }

  res.json({ task: updatedTask, internship: finalInternship });
});

export default router;
