import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX } from "../middleware/rbac";
import { prisma } from "../lib/prisma";
import { withAudit } from "../lib/withAudit";
import { EXIT_CHECKLIST_MANUAL_ITEMS } from "../lib/exitChecklist";

const router = Router();

// Frontend Day F4 built this for AD_PROVISION (Email/VPN/Repository/Internal
// Tools). Frontend Day F5 generalized it to also serve EXIT_CHECKLIST
// (assetReturn/emailVpnDeprovision/repositoryRevoke/exitInterviewScheduled —
// finalFeedbackSubmitted/certificateRequestRaised are excluded from manual
// ticking below since they auto-flip from real Internship state, computed at
// task-creation time in POST /internships/:id/close and re-derived at read
// time in GET /internships; see EXIT_CHECKLIST_AUTO_ITEMS).
const CHECKLIST_ITEMS_BY_TASK_TYPE: Record<string, readonly string[]> = {
  AD_PROVISION: ["email", "vpn", "repository", "internalTools"],
  EXIT_CHECKLIST: EXIT_CHECKLIST_MANUAL_ITEMS,
};

export const EXIT_CHECKLIST_AUTO_ITEMS = ["finalFeedbackSubmitted", "certificateRequestRaised"] as const;

const checklistSchema = z.object({
  item: z.string().min(1),
  status: z.enum(["pending", "in_progress", "provisioned"]),
});

// Deliberately does NOT call ADAdapter.provision() or transition anything —
// this is UI progress only. POST /internships/:id/ad-provision (Day 5)
// remains the one place that actually finalizes AD provisioning and flips
// adAccountActive, regardless of checklist state; same principle for
// EXIT_CHECKLIST — ticking items here never fires the Day 6 deactivation
// trio, the Closure page does that as its own explicit, visible step.
router.patch("/:id/checklist", authenticate, requireRole(...PERMISSION_MATRIX.task.updateChecklist), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  const parsedBody = checklistSchema.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
    return;
  }
  const { id } = parsedParams.data;
  const { item, status } = parsedBody.data;

  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const allowedItems = CHECKLIST_ITEMS_BY_TASK_TYPE[task.type];
  if (!allowedItems) {
    res.status(409).json({ error: "Only AD_PROVISION or EXIT_CHECKLIST tasks support a checklist" });
    return;
  }
  if (req.user!.role !== task.assigneeRole) {
    res.status(403).json({ error: `Only ${task.assigneeRole} can update this checklist` });
    return;
  }
  if ((EXIT_CHECKLIST_AUTO_ITEMS as readonly string[]).includes(item)) {
    res.status(409).json({ error: `'${item}' is computed automatically and can't be ticked manually` });
    return;
  }
  if (!allowedItems.includes(item)) {
    res.status(400).json({ error: `Invalid input`, details: { item: [`Must be one of: ${allowedItems.join(", ")}`] } });
    return;
  }

  const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };
  const currentChecklist = (task.checklist as Record<string, string> | null) ?? {};

  const updated = await withAudit(
    {
      ...actor,
      action: "UPDATE_CHECKLIST",
      entity: "Task",
      entityId: task.id,
      before: { checklist: currentChecklist },
      after: (result: { checklist: Prisma.JsonValue }) => ({ checklist: result.checklist }),
    },
    async () => {
      // "Provision all" fires one PATCH per checklist item in parallel — a
      // plain read-then-write here (read task.checklist, merge one key,
      // write the whole object back) loses updates: multiple requests can
      // all read the same pre-update snapshot before any write lands, so
      // whichever write commits last silently clobbers the others (only
      // one item ends up persisted instead of all four). Merging via
      // Postgres's jsonb `||` in a single UPDATE keeps each item's write
      // atomic and race-safe regardless of arrival order.
      const rows = await prisma.$queryRaw<{ checklist: Record<string, string> }[]>`
        UPDATE "Task"
        SET checklist = COALESCE(checklist, '{}'::jsonb) || jsonb_build_object(${item}::text, ${status}::text)
        WHERE id = ${task.id}
        RETURNING checklist
      `;
      return { ...task, checklist: rows[0].checklist as Prisma.InputJsonValue };
    }
  );

  res.json({ task: updated });
});

// Manual reminder trigger for DELAY_FOLLOWUP tasks — Day 6's SLA sweep will
// fire these on a schedule (day 1/3/5); this is the human-triggered
// fallback for now, and what actually implements the day-3 auto-escalation.
router.post("/:id/remind", authenticate, requireRole(...PERMISSION_MATRIX.task.remind), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { id } = parsedParams.data;

  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (task.type !== "DELAY_FOLLOWUP") {
    res.status(409).json({ error: "Only DELAY_FOLLOWUP tasks support reminders" });
    return;
  }
  if (task.completedAt) {
    res.status(409).json({ error: "Task is already completed" });
    return;
  }

  const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };
  const newCount = task.delayReminderCount + 1;

  const updatedTask = await withAudit(
    {
      ...actor,
      action: "REMIND",
      entity: "Task",
      entityId: task.id,
      before: { delayReminderCount: task.delayReminderCount },
      after: { delayReminderCount: newCount },
    },
    () => prisma.task.update({ where: { id: task.id }, data: { delayReminderCount: newCount } })
  );

  let escalationTask = null;
  if (newCount >= 3 && task.internshipId) {
    const existingEscalation = await prisma.task.findFirst({
      where: { internshipId: task.internshipId, type: "DELAY_ESCALATION" },
    });
    escalationTask = existingEscalation
      ? existingEscalation
      : await withAudit(
          {
            ...actor,
            action: "CREATE",
            entity: "Task",
            entityId: (created) => created.id,
            after: { type: "DELAY_ESCALATION", internshipId: task.internshipId, escalationTier: 2 },
          },
          () =>
            prisma.task.create({
              data: {
                internshipId: task.internshipId!,
                type: "DELAY_ESCALATION",
                assigneeRole: "PROGRAM_OWNER",
                escalationTier: 2,
                dueAt: new Date(),
              },
            })
        );
  }

  res.json({ task: updatedTask, escalationTask });
});

export default router;
