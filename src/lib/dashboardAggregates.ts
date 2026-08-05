// Shared aggregate queries behind /dashboard/ai-narrative, /dashboard/
// duplicate-alerts, /dashboard/sla-risk-predictions, and /copilot/analyze —
// factored out so all four read the same numbers rather than each
// re-deriving its own version. Aggregate-only: computeDashboardAggregates()
// never touches Candidate or JoiningRecord, so there is no path for PII
// (govtIdNumber, dob) to reach anything built on top of it.

import { AiActionType } from "@prisma/client";
import { prisma } from "./prisma";

const DWELL_WINDOW_DAYS = 90;
const MAX_BOTTLENECKS = 5;

export interface DashboardAggregates {
  stageCounts: Record<string, number>;
  breachCountsByStage: Record<string, number>;
  avgDwellDaysByStage: Record<string, number>;
  bottlenecks: Array<{ stage: string; candidateCount: number; avgDwellDays: number | null }>;
}

export async function computeDashboardAggregates(): Promise<DashboardAggregates> {
  const windowStart = new Date(Date.now() - DWELL_WINDOW_DAYS * 24 * 3600 * 1000);

  const [stageGroups, breachedTasks, completedTasks] = await Promise.all([
    prisma.internship.groupBy({ by: ["status"], _count: { status: true } }),
    prisma.task.findMany({ where: { slaBreached: true, completedAt: null } }),
    prisma.task.findMany({
      where: { completedAt: { gte: windowStart } },
      select: { type: true, createdAt: true, completedAt: true },
    }),
  ]);

  const stageCounts = Object.fromEntries(stageGroups.map((g) => [g.status, g._count.status]));

  const breachCountsByStage: Record<string, number> = {};
  for (const task of breachedTasks) {
    breachCountsByStage[task.type] = (breachCountsByStage[task.type] ?? 0) + 1;
  }

  const dwellSums: Record<string, { totalDays: number; count: number }> = {};
  for (const task of completedTasks) {
    if (!task.completedAt) continue;
    const days = (task.completedAt.getTime() - task.createdAt.getTime()) / (24 * 3600 * 1000);
    dwellSums[task.type] ??= { totalDays: 0, count: 0 };
    dwellSums[task.type].totalDays += days;
    dwellSums[task.type].count += 1;
  }
  const avgDwellDaysByStage = Object.fromEntries(
    Object.entries(dwellSums).map(([type, { totalDays, count }]) => [type, totalDays / count])
  );

  const bottlenecks = Object.entries(breachCountsByStage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_BOTTLENECKS)
    .map(([stage, candidateCount]) => ({
      stage,
      candidateCount,
      avgDwellDays: avgDwellDaysByStage[stage] ?? null,
    }));

  return { stageCounts, breachCountsByStage, avgDwellDaysByStage, bottlenecks };
}

// HR/PROGRAM_OWNER-only enrichment (callers must check role before calling
// this) — names of candidates currently behind on a breached task.
export interface BreachedCandidate {
  stage: string;
  candidateName: string;
  dueAt: Date;
}

export async function listBreachedCandidates(limit = 20): Promise<BreachedCandidate[]> {
  const tasks = await prisma.task.findMany({
    where: { slaBreached: true, completedAt: null, internshipId: { not: null } },
    orderBy: { dueAt: "asc" },
    take: limit,
    include: { internship: { include: { referral: { include: { candidate: true } } } } },
  });

  return tasks
    .filter((t) => t.internship)
    .map((t) => ({ stage: t.type, candidateName: t.internship!.referral.candidate.fullName, dueAt: t.dueAt }));
}

// Dashboard's "Duplicate Candidate Alerts" — possible (not yet resolved)
// fuzzy matches from DUPLICATE_DETECTION, most recent first.
export interface DuplicateAlert {
  aiActionId: string;
  entityId: string | null;
  candidateName: string | null;
  matchedName: string | null;
  matchedCandidateId: string | null;
  similarity: number | null;
  reviewed: boolean;
  createdAt: Date;
}

interface DuplicateDetectionOutputShape {
  isDuplicate: boolean;
  possibleDuplicate: boolean;
  matches: Array<{ candidateId: string; fullName: string; similarity: number }>;
}
interface DuplicateDetectionInputShape {
  fullName?: string;
}

export async function listDuplicateAlerts(limit = 50): Promise<DuplicateAlert[]> {
  const actions = await prisma.aiAction.findMany({
    where: { type: AiActionType.DUPLICATE_DETECTION, humanOverride: false },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  const alerts: DuplicateAlert[] = [];
  for (const a of actions) {
    const output = a.output as unknown as DuplicateDetectionOutputShape;
    const input = a.input as unknown as DuplicateDetectionInputShape | null;
    if (output.isDuplicate || !output.possibleDuplicate || output.matches.length === 0) continue;
    const bestMatch = output.matches[0];
    alerts.push({
      aiActionId: a.id,
      entityId: a.entityId,
      candidateName: input?.fullName ?? null,
      matchedName: bestMatch.fullName,
      matchedCandidateId: bestMatch.candidateId,
      similarity: bestMatch.similarity,
      reviewed: a.humanOverride,
      createdAt: a.createdAt,
    });
  }
  return alerts;
}

// SLA Monitoring's "AI Risk Predictions" table — SLA_RISK_PREDICTION rows
// joined back to their Task for candidate name and stage.
export interface SlaRiskPredictionRow {
  aiActionId: string;
  taskId: string | null;
  stage: string | null;
  candidateName: string | null;
  elapsedPercent: number | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  riskNote: string | null;
  recommendedAction: string | null;
  createdAt: Date;
}

function bucketRisk(elapsedPercent: number | null): "LOW" | "MEDIUM" | "HIGH" {
  if (elapsedPercent === null) return "LOW";
  if (elapsedPercent >= 100) return "HIGH";
  if (elapsedPercent >= 85) return "MEDIUM";
  return "LOW";
}

export async function listSlaRiskPredictions(limit = 50): Promise<SlaRiskPredictionRow[]> {
  const actions = await prisma.aiAction.findMany({
    where: { type: AiActionType.SLA_RISK_PREDICTION, entity: "Task" },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  if (actions.length === 0) return [];

  const taskIds = [...new Set(actions.map((a) => a.entityId).filter((id): id is string => !!id))];
  const tasks = await prisma.task.findMany({
    where: { id: { in: taskIds } },
    include: { internship: { include: { referral: { include: { candidate: true } } } } },
  });
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  return actions.map((a) => {
    const task = a.entityId ? taskById.get(a.entityId) : undefined;
    const output = a.output as unknown as { riskNote?: string; recommendedAction?: string };
    return {
      aiActionId: a.id,
      taskId: a.entityId,
      stage: task?.type ?? null,
      candidateName: task?.internship?.referral.candidate.fullName ?? null,
      elapsedPercent: a.confidence !== null ? a.confidence * 100 : null,
      riskLevel: bucketRisk(a.confidence !== null ? a.confidence * 100 : null),
      riskNote: output.riskNote ?? null,
      recommendedAction: output.recommendedAction ?? null,
      createdAt: a.createdAt,
    };
  });
}
