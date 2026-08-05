import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/rbac";
import { prisma } from "../lib/prisma";
import { emailDraft } from "../lib/ai";
import { emailAdapter } from "../lib/adapters/email";
import { withAudit } from "../lib/withAudit";

const router = Router();

const draftSchema = z.object({
  to: z.string().email(),
  context: z.string().min(1),
  templateHint: z.string().optional(),
  internshipId: z.string().optional(),
});

router.post("/draft", authenticate, requireRole(Role.HR, Role.PROGRAM_OWNER), async (req, res) => {
  const parsed = draftSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { to, context, templateHint, internshipId } = parsed.data;

  const draft = await emailDraft({ to, context, templateHint, entityId: internshipId, internshipId, actorId: req.user!.userId });

  res.status(201).json({ aiActionId: draft.aiActionId, subject: draft.subject, body: draft.body });
});

const approveAndSendSchema = z.object({
  subject: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
});

// The only path from an AI draft to an actual send — never auto-sent, per
// CLAUDE.md's advisory-only rule for AiAction. If the caller edited the
// subject/body from what the model produced, the AiAction is flagged
// humanOverride: true.
router.post("/draft/:id/approve-and-send", authenticate, requireRole(Role.HR, Role.PROGRAM_OWNER), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  const parsedBody = approveAndSendSchema.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
    return;
  }
  const { id } = parsedParams.data;

  const aiAction = await prisma.aiAction.findUnique({ where: { id } });
  if (!aiAction || aiAction.type !== "EMAIL_DRAFT") {
    res.status(404).json({ error: "No email draft found for this id" });
    return;
  }

  const templateId = `AI_DRAFT:${id}`;
  const alreadySent = await prisma.notificationLog.findFirst({ where: { templateId } });
  if (alreadySent) {
    res.status(409).json({ error: "This draft has already been sent" });
    return;
  }

  const output = aiAction.output as { subject: string; body: string };
  const input = aiAction.input as { to: string; context: string; templateHint?: string; internshipId?: string };

  const finalSubject = parsedBody.data.subject ?? output.subject;
  const finalBody = parsedBody.data.body ?? output.body;
  const wasEdited = finalSubject !== output.subject || finalBody !== output.body;

  if (wasEdited) {
    await prisma.aiAction.update({
      where: { id },
      data: { humanOverride: true, overriddenBy: req.user!.userId, overriddenAt: new Date() },
    });
  }

  const result = await emailAdapter.sendRaw(input.to, finalSubject, finalBody);
  const notificationLog = await prisma.notificationLog.create({
    data: {
      templateId,
      recipient: input.to,
      status: result.status,
      providerId: result.providerId,
      internshipId: input.internshipId ?? null,
    },
  });

  res.json({ notificationLog, humanOverride: wasEdited, subject: finalSubject, body: finalBody });
});

// Frontend Day F2 — own-notifications feed (self-scoped like GET /me, no
// role restriction). Pairs NotificationLog rows addressed to the caller's
// email with open Task rows assigned to the caller's role, so the frontend
// can render one merged "Email / Escalation / Reminder" feed.
router.get("/mine", authenticate, async (req, res) => {
  const caller = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!caller) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [notifications, pendingTasks] = await Promise.all([
    prisma.notificationLog.findMany({
      where: { recipient: caller.email },
      orderBy: { sentAt: "desc" },
      take: 100,
    }),
    prisma.task.findMany({
      where: { assigneeRole: req.user!.role, completedAt: null },
      orderBy: { dueAt: "asc" },
      take: 100,
    }),
  ]);

  res.json({ notifications, pendingTasks });
});

const notificationIdParamsSchema = z.object({ id: z.string().min(1) });

router.patch("/:id/read", authenticate, async (req, res) => {
  const parsedParams = notificationIdParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { id } = parsedParams.data;

  const [caller, notification] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.user!.userId } }),
    prisma.notificationLog.findUnique({ where: { id } }),
  ]);
  // Scoped to the caller's own notifications — a recipient mismatch is
  // reported as 404, not 403, so the id space can't be probed by role.
  if (!caller || !notification || notification.recipient !== caller.email) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }

  if (notification.readAt) {
    res.json({ notificationLog: notification });
    return;
  }

  const updated = await withAudit(
    {
      actorId: req.user!.userId,
      role: req.user!.role,
      action: "MARK_READ",
      entity: "NotificationLog",
      entityId: id,
      before: { readAt: null },
      after: { readAt: new Date() },
      ip: req.ip ?? null,
    },
    () => prisma.notificationLog.update({ where: { id }, data: { readAt: new Date() } })
  );

  res.json({ notificationLog: updated });
});

router.patch("/read-all", authenticate, async (req, res) => {
  const caller = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!caller) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const unread = await prisma.notificationLog.findMany({
    where: { recipient: caller.email, readAt: null },
    select: { id: true },
  });
  if (unread.length === 0) {
    res.json({ updatedCount: 0 });
    return;
  }

  const now = new Date();
  await withAudit(
    {
      actorId: req.user!.userId,
      role: req.user!.role,
      action: "MARK_ALL_READ",
      entity: "NotificationLog",
      entityId: `bulk:${caller.id}`,
      before: { readAt: null },
      after: { readAt: now, count: unread.length },
      ip: req.ip ?? null,
    },
    () =>
      prisma.notificationLog.updateMany({
        where: { id: { in: unread.map((n) => n.id) } },
        data: { readAt: now },
      })
  );

  res.json({ updatedCount: unread.length });
});

export default router;
