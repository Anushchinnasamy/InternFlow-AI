import { Router } from "express";
import { Role } from "@prisma/client";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX } from "../middleware/rbac";
import { prisma } from "../lib/prisma";
import { businessDaysBetween } from "../lib/businessDays";
import { dashboardNarrative } from "../lib/dashboardNarrative";
import { listDuplicateAlerts, listSlaRiskPredictions } from "../lib/dashboardAggregates";

const router = Router();

router.get("/stage-counts", authenticate, requireRole(...PERMISSION_MATRIX.dashboard.stageCounts), async (_req, res) => {
  const grouped = await prisma.internship.groupBy({ by: ["status"], _count: { status: true } });
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count.status]));
  res.json({ counts });
});

router.get(
  "/sla-breaches",
  authenticate,
  requireRole(...PERMISSION_MATRIX.dashboard.slaBreaches),
  async (req, res) => {
    const role = req.user!.role;
    // PROGRAM_OWNER sees every breached task; every other allowed role sees
    // only tasks assigned to its own role.
    const tasks = await prisma.task.findMany({
      where: {
        slaBreached: true,
        completedAt: null,
        ...(role === Role.PROGRAM_OWNER ? {} : { assigneeRole: role }),
      },
      orderBy: { dueAt: "asc" },
    });

    const groupedByStageAndOwner: Record<string, Record<string, number>> = {};
    for (const task of tasks) {
      groupedByStageAndOwner[task.type] ??= {};
      groupedByStageAndOwner[task.type][task.assigneeRole] = (groupedByStageAndOwner[task.type][task.assigneeRole] ?? 0) + 1;
    }

    res.json({ tasks, groupedByStageAndOwner });
  }
);

router.get("/cycle-time", authenticate, requireRole(...PERMISSION_MATRIX.dashboard.cycleTime), async (_req, res) => {
  const windowDays = 90;
  const windowStart = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

  const readyEvents = await prisma.auditEvent.findMany({
    where: { entity: "Internship", action: "TRANSITION", createdAt: { gte: windowStart } },
  });
  const toReadyEvents = readyEvents.filter((e) => (e.after as { status?: string } | null)?.status === "READY_TO_START");

  const internships = await prisma.internship.findMany({
    where: { id: { in: toReadyEvents.map((e) => e.entityId) } },
    include: { referral: true },
  });
  const internshipById = new Map(internships.map((i) => [i.id, i]));

  const durations = toReadyEvents
    .map((event) => {
      const internship = internshipById.get(event.entityId);
      return internship ? businessDaysBetween(internship.referral.createdAt, event.createdAt) : null;
    })
    .filter((d): d is number => d !== null);

  const averageBusinessDays = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

  res.json({ averageBusinessDays, sampleSize: durations.length, windowDays });
});

router.get(
  "/completion-ratio",
  authenticate,
  requireRole(...PERMISSION_MATRIX.dashboard.completionRatio),
  async (_req, res) => {
    const windowMonths = 12;
    const windowStart = new Date(Date.now() - windowMonths * 30 * 24 * 3600 * 1000);

    // "ever reached ACTIVE" — actualStart is only ever set by start-confirm.
    const [reachedActiveCount, completedOrClosedCount] = await Promise.all([
      prisma.internship.count({ where: { actualStart: { gte: windowStart } } }),
      prisma.internship.count({
        where: { actualStart: { gte: windowStart }, status: { in: ["COMPLETED", "CLOSED"] } },
      }),
    ]);

    const completionRatio = reachedActiveCount > 0 ? completedOrClosedCount / reachedActiveCount : null;

    res.json({ completionRatio, completedOrClosedCount, reachedActiveCount, windowMonths });
  }
);

// Bonus (cheap to add): override rate per AiActionType — evidence that AI
// output here is assistive (human reviewed, sometimes corrected) rather
// than autonomous.
router.get("/ai-metrics", authenticate, requireRole(...PERMISSION_MATRIX.aiAction.read), async (_req, res) => {
  const [totals, overridden] = await Promise.all([
    prisma.aiAction.groupBy({ by: ["type"], _count: { type: true } }),
    prisma.aiAction.groupBy({ by: ["type"], where: { humanOverride: true }, _count: { type: true } }),
  ]);
  const overriddenByType = Object.fromEntries(overridden.map((o) => [o.type, o._count.type]));

  const metrics = totals.map((t) => {
    const overriddenCount = overriddenByType[t.type] ?? 0;
    return {
      type: t.type,
      total: t._count.type,
      overridden: overriddenCount,
      overrideRate: t._count.type > 0 ? overriddenCount / t._count.type : 0,
    };
  });

  res.json({ metrics });
});

router.get("/email-health", authenticate, requireRole(...PERMISSION_MATRIX.dashboard.emailHealth), async (_req, res) => {
  const windowDays = 30;
  const windowStart = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

  const [totalCount, bouncedOrFailedCount] = await Promise.all([
    prisma.notificationLog.count({ where: { sentAt: { gte: windowStart } } }),
    prisma.notificationLog.count({ where: { sentAt: { gte: windowStart }, status: { in: ["bounced", "failed"] } } }),
  ]);

  const bounceFailureRate = totalCount > 0 ? bouncedOrFailedCount / totalCount : 0;

  // Target per spec: <=1% bounce/failure rate.
  res.json({ bounceFailureRate, bouncedOrFailedCount, totalCount, windowDays, targetMax: 0.01 });
});

// Frontend Day F2 — one LLM call over the same aggregates behind
// stage-counts/sla-breaches above. See src/lib/dashboardNarrative.ts for the
// guarantee that no PII ever enters the LLM input here.
router.get(
  "/ai-narrative",
  authenticate,
  requireRole(...PERMISSION_MATRIX.dashboard.aiNarrative),
  async (req, res) => {
    const result = await dashboardNarrative(req.user!.userId);
    res.json(result);
  }
);

router.get(
  "/duplicate-alerts",
  authenticate,
  requireRole(...PERMISSION_MATRIX.dashboard.duplicateAlerts),
  async (_req, res) => {
    const alerts = await listDuplicateAlerts();
    res.json({ alerts });
  }
);

router.get(
  "/sla-risk-predictions",
  authenticate,
  requireRole(...PERMISSION_MATRIX.dashboard.slaRiskPredictions),
  async (_req, res) => {
    const predictions = await listSlaRiskPredictions();
    res.json({ predictions });
  }
);

router.get(
  "/recent-activity",
  authenticate,
  requireRole(...PERMISSION_MATRIX.dashboard.recentActivity),
  async (_req, res) => {
    const events = await prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { actor: { select: { name: true, role: true } } },
    });
    res.json({ events });
  }
);

router.get(
  "/upcoming-closures",
  authenticate,
  requireRole(...PERMISSION_MATRIX.dashboard.upcomingClosures),
  async (_req, res) => {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

    const internships = await prisma.internship.findMany({
      where: { status: "ACTIVE", actualEnd: { gte: now, lte: windowEnd } },
      orderBy: { actualEnd: "asc" },
      include: { referral: { include: { candidate: true } } },
    });

    const closures = internships.map((i) => ({
      internshipId: i.id,
      candidateName: i.referral.candidate.fullName,
      projectTitle: i.referral.projectTitle,
      actualEnd: i.actualEnd,
    }));

    res.json({ closures });
  }
);

export default router;
