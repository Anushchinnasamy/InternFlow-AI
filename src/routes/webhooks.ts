import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { withAudit } from "../lib/withAudit";

const router = Router();

const emailStatusSchema = z.object({
  providerId: z.string().min(1),
  status: z.enum(["sent", "delivered", "bounced", "failed"]),
});

// FR-34. Public and provider-signed in production — no signature verification
// yet because there's no real webhook secret in this environment (the
// EmailAdapter falls back to ManualEmailAdapter for the same reason; see
// src/lib/adapters/email.ts). A real provider swap needs to verify the
// signature header here before trusting the body.
router.post("/email-status", async (req, res) => {
  const parsed = emailStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { providerId, status } = parsed.data;

  const log = await prisma.notificationLog.findFirst({ where: { providerId } });
  if (!log) {
    res.status(404).json({ error: "No matching NotificationLog for this providerId" });
    return;
  }

  const updated = await withAudit(
    {
      actorId: null,
      role: null,
      action: "EMAIL_STATUS_UPDATE",
      entity: "NotificationLog",
      entityId: log.id,
      before: { status: log.status },
      after: { status },
    },
    () => prisma.notificationLog.update({ where: { id: log.id }, data: { status } })
  );

  let correctionTask = null;
  if ((status === "bounced" || status === "failed") && log.internshipId) {
    correctionTask = await withAudit(
      {
        actorId: null,
        role: null,
        action: "CREATE",
        entity: "Task",
        entityId: (created) => created.id,
        after: { type: "EMAIL_CORRECTION", internshipId: log.internshipId, notificationLogId: log.id, status },
      },
      () =>
        prisma.task.create({
          data: {
            internshipId: log.internshipId!,
            type: "EMAIL_CORRECTION",
            assigneeRole: "HR",
            dueAt: new Date(Date.now() + 15 * 60 * 1000),
            payload: { notificationLogId: log.id, templateId: log.templateId, recipient: log.recipient, status },
          },
        })
    );
  }

  res.json({ notificationLog: updated, correctionTask });
});

export default router;
