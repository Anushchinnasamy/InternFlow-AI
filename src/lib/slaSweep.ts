// Compliance-critical background sweep (CLAUDE.md-style: this is the SLA
// clock enforcement for every Task row, not just a dashboard nicety). Run on
// a node-cron schedule in src/index.ts every few minutes; runSlaSweep() is
// also exported standalone so it can be triggered manually (ops tooling,
// verification, tests) without waiting for the schedule.

import { Prisma, Role, Task } from "@prisma/client";
import { prisma } from "./prisma";
import { slaRiskPrediction } from "./ai";
import { sendTemplatedEmail } from "./notifications";
import { loadInternshipPacket } from "./internshipContext";
import { addBusinessDays } from "./businessDays";
import { withAudit } from "./withAudit";

// System-triggered, no human actor — same actorId:null/role:null pattern as
// the email-status webhook (src/routes/webhooks.ts).
const SYSTEM_ACTOR = { actorId: null, role: null, ip: null };

// Task types whose SLA breach is a compliance issue, not just an ops delay —
// these skip the normal Tier1 -> Tier2 -> Tier3 climb and escalate straight
// to Tier3 the moment they breach.
const COMPLIANCE_CRITICAL_TASK_TYPES = new Set(["NDA_SIGN", "AD_DEACTIVATE", "BADGE_RETURN"]);

// A task's status graph off-ramp — once the internship/referral it belongs
// to is dead, its open tasks are dead too and must stop generating
// escalations forever.
const TERMINAL_STATUSES = new Set(["REJECTED", "WITHDRAWN", "EXPIRED", "CANCELLED", "CLOSED"]);

// CANDIDATE/MENTOR/REFERRER are per-internship individuals, not a shared
// functional team — notifying "everyone who ever held this role" (which is
// what a role-wide broadcast would do) is wrong for these. HR/PROGRAM_OWNER/
// ADMIN_SECURITY/IT_ADMIN/LEGAL/SYSADMIN genuinely are "whoever's on duty"
// roles and get the broadcast.
const INDIVIDUAL_ROLES = new Set<Role>([Role.CANDIDATE, Role.MENTOR, Role.REFERRER]);

type TaskPayload = Record<string, unknown>;

function readPayload(task: Task): TaskPayload {
  return (task.payload as TaskPayload | null) ?? {};
}

function elapsedPercent(task: Task): number {
  const total = task.dueAt.getTime() - task.createdAt.getTime();
  if (total <= 0) return 100;
  const elapsed = Date.now() - task.createdAt.getTime();
  return Math.max(0, Math.min(100, (elapsed / total) * 100));
}

/** Whole business days between `since` and now (0 if since is today/future). */
function businessDaysSince(since: Date, now: Date): number {
  let count = 0;
  let cursor = new Date(since);
  while (cursor < now) {
    cursor = addBusinessDays(cursor, 1);
    if (cursor <= now) count++;
  }
  return count;
}

async function resolveIndividualRecipient(
  task: Task,
  role: Role
): Promise<{ email: string; name: string } | null> {
  if (task.internshipId) {
    const internship = await prisma.internship.findUnique({
      where: { id: task.internshipId },
      include: { referral: { include: { candidate: true, referrer: true } }, mentor: true },
    });
    if (!internship) return null;
    if (role === Role.CANDIDATE) return { email: internship.referral.candidate.email, name: internship.referral.candidate.fullName };
    if (role === Role.MENTOR) return { email: internship.mentor.email, name: internship.mentor.name };
    if (role === Role.REFERRER) return { email: internship.referral.referrer.email, name: internship.referral.referrer.name };
  } else if (task.referralId) {
    const referral = await prisma.referral.findUnique({
      where: { id: task.referralId },
      include: { candidate: true, referrer: true, mentor: true },
    });
    if (!referral) return null;
    if (role === Role.CANDIDATE) return { email: referral.candidate.email, name: referral.candidate.fullName };
    if (role === Role.MENTOR) return { email: referral.mentor.email, name: referral.mentor.name };
    if (role === Role.REFERRER) return { email: referral.referrer.email, name: referral.referrer.name };
  }
  return null;
}

/**
 * Tier1 "notify task owner": for an individual role (CANDIDATE/MENTOR/
 * REFERRER) this resolves the ONE person tied to this specific task's
 * internship/referral — never a role-wide broadcast, which would email
 * every candidate/mentor who has ever existed. For a functional-team role
 * (HR/PROGRAM_OWNER/ADMIN_SECURITY/IT_ADMIN/LEGAL/SYSADMIN) it broadcasts to
 * everyone holding that role, which is genuinely correct there.
 *
 * "Owner's manager" from the spec isn't wired — User.managerId exists but is
 * unset for every seed user, so there's nothing meaningful to notify yet;
 * this is a known gap, not a decision to skip it forever.
 */
async function notifyRole(task: Task, role: Role, templateId: string, mergeData: Record<string, unknown>) {
  if (INDIVIDUAL_ROLES.has(role)) {
    const recipient = await resolveIndividualRecipient(task, role);
    if (!recipient) return;
    await sendTemplatedEmail({
      to: recipient.email,
      templateId,
      mergeData: { ...mergeData, recipientName: recipient.name },
      internshipId: task.internshipId,
    });
    return;
  }

  const users = await prisma.user.findMany({ where: { role, active: true } });
  await Promise.all(
    users.map((u) =>
      sendTemplatedEmail({ to: u.email, templateId, mergeData: { ...mergeData, recipientName: u.name }, internshipId: task.internshipId })
    )
  );
}

async function isLinkedToLiveEntity(task: Task): Promise<boolean> {
  if (task.internshipId) {
    const internship = await prisma.internship.findUnique({ where: { id: task.internshipId }, select: { status: true } });
    return !!internship && !TERMINAL_STATUSES.has(internship.status);
  }
  if (task.referralId) {
    const referral = await prisma.referral.findUnique({ where: { id: task.referralId }, select: { status: true } });
    return !!referral && !TERMINAL_STATUSES.has(referral.status);
  }
  return true;
}

async function resolveCandidateName(internshipId: string | null): Promise<string> {
  if (!internshipId) return "";
  const packet = await loadInternshipPacket(internshipId);
  return packet?.internship.referral.candidate.fullName ?? "";
}

async function isComplianceCritical(task: Task): Promise<boolean> {
  if (!COMPLIANCE_CRITICAL_TASK_TYPES.has(task.type)) return false;
  if (task.type === "AD_DEACTIVATE" || task.type === "BADGE_RETURN") return true;
  // NDA_SIGN: only compliance-critical once we're AT OR PAST the internship's
  // actual start date, not merely past the task's own dueAt (which is
  // startDate - 1 day and would otherwise breach — and escalate — a full day
  // early relative to this specific rule).
  if (task.type === "NDA_SIGN" && task.internshipId) {
    const packet = await loadInternshipPacket(task.internshipId);
    return !!packet && new Date() >= packet.startDate;
  }
  return false;
}

async function processOpenTask(task: Task, now: Date, counters: { riskPredictions: number; breachesFlagged: number; escalations: number }) {
  const payload = readPayload(task);

  // >=75% elapsed, AI risk prediction once per task.
  const percent = elapsedPercent(task);
  if (percent >= 75 && !payload.slaRiskFlaggedAt) {
    const candidateName = await resolveCandidateName(task.internshipId);
    const prediction = await slaRiskPrediction({
      taskId: task.id,
      taskType: task.type,
      elapsedPercent: percent,
      candidateName: candidateName || null,
    });
    counters.riskPredictions++;
    payload.slaRiskFlaggedAt = now.toISOString();
    payload.riskNote = prediction.riskNote;
    payload.recommendedAction = prediction.recommendedAction;
    await withAudit(
      {
        ...SYSTEM_ACTOR,
        action: "SLA_RISK_FLAGGED",
        entity: "Task",
        entityId: task.id,
        before: { slaRiskFlaggedAt: null },
        after: { slaRiskFlaggedAt: payload.slaRiskFlaggedAt, riskNote: payload.riskNote },
      },
      () => prisma.task.update({ where: { id: task.id }, data: { payload: payload as Prisma.InputJsonValue } })
    );
  }

  if (task.dueAt >= now) return; // not overdue yet — nothing further to do

  if (!task.slaBreached) {
    task = await withAudit(
      {
        ...SYSTEM_ACTOR,
        action: "SLA_BREACH_FLAGGED",
        entity: "Task",
        entityId: task.id,
        before: { slaBreached: false },
        after: { slaBreached: true },
      },
      () => prisma.task.update({ where: { id: task.id }, data: { slaBreached: true } })
    );
    counters.breachesFlagged++;
  }

  const complianceCritical = await isComplianceCritical(task);
  let targetTier: 1 | 2 | 3;
  if (complianceCritical) {
    targetTier = 3;
  } else {
    const daysPastBreach = businessDaysSince(task.dueAt, now);
    const tier2ByDelayReminders = task.type === "DELAY_FOLLOWUP" && task.delayReminderCount >= 3;
    if (daysPastBreach >= 3) targetTier = 3;
    else if (daysPastBreach >= 1 || tier2ByDelayReminders) targetTier = 2;
    else targetTier = 1;
  }

  const today = now.toISOString().slice(0, 10);
  const lastNotifiedDate = payload.lastEscalationNotifiedDate as string | undefined;
  const tierChanged = targetTier > task.escalationTier;
  // Tier1's "daily repeat" and re-notifying on every sweep run within the
  // same day would be spam — gate every tier to "once per calendar day
  // unless the tier just changed."
  const dueForNotification = tierChanged || lastNotifiedDate !== today;
  if (!dueForNotification) return;

  const candidateName = await resolveCandidateName(task.internshipId);
  const mergeData = {
    taskType: task.type,
    candidateName,
    dueAt: task.dueAt.toISOString().slice(0, 10),
    escalationTier: targetTier,
    riskNote: (payload.riskNote as string) ?? "",
    recommendedAction: (payload.recommendedAction as string) ?? "",
  };

  if (targetTier === 1) {
    await notifyRole(task, task.assigneeRole, "T23_SLA_BREACH_ESCALATION", mergeData);
  } else if (targetTier === 2) {
    await notifyRole(task, Role.PROGRAM_OWNER, "T23_SLA_BREACH_ESCALATION", mergeData);
    await notifyRole(task, task.assigneeRole, "T23_SLA_BREACH_ESCALATION", mergeData);
  } else {
    await notifyRole(task, Role.PROGRAM_OWNER, "T23_SLA_BREACH_ESCALATION", mergeData);
    await notifyRole(task, Role.HR, "T23_SLA_BREACH_ESCALATION", mergeData);
    await notifyRole(task, Role.LEGAL, "T23_SLA_BREACH_ESCALATION", mergeData);
  }
  counters.escalations++;

  payload.lastEscalationNotifiedDate = today;
  const newTier = Math.max(task.escalationTier, targetTier);
  await withAudit(
    {
      ...SYSTEM_ACTOR,
      action: "SLA_ESCALATION",
      entity: "Task",
      entityId: task.id,
      before: { escalationTier: task.escalationTier },
      after: { escalationTier: newTier },
    },
    () =>
      prisma.task.update({
        where: { id: task.id },
        data: { escalationTier: newTier, payload: payload as Prisma.InputJsonValue },
      })
  );
}

/**
 * T19 closure reminders: the two CLOSURE_REMINDER tasks (actualEnd-7d,
 * actualEnd-2d) created at start-confirm are "checked by the sweep" per
 * spec — sending is what completes them, since they're notifications, not
 * an action a human checks off.
 */
async function sendDueClosureReminders(now: Date): Promise<number> {
  const dueTasks = await prisma.task.findMany({
    where: { type: "CLOSURE_REMINDER", completedAt: null, dueAt: { lte: now } },
  });

  let sent = 0;
  for (const task of dueTasks) {
    if (!task.internshipId) continue;
    const packet = await loadInternshipPacket(task.internshipId);
    if (!packet) continue;
    const { mentor, referral } = packet.internship;
    const mergeData = {
      candidateName: referral.candidate.fullName,
      projectTitle: referral.projectTitle,
      actualEnd: packet.endDate.toISOString().slice(0, 10),
    };
    await Promise.all([
      sendTemplatedEmail({
        to: mentor.email,
        templateId: "T19_CLOSURE_REMINDER",
        mergeData: { ...mergeData, recipientName: mentor.name },
        internshipId: task.internshipId,
      }),
      notifyRole(task, Role.HR, "T19_CLOSURE_REMINDER", mergeData),
    ]);
    await withAudit(
      {
        ...SYSTEM_ACTOR,
        action: "COMPLETE",
        entity: "Task",
        entityId: task.id,
        before: { completedAt: null },
        after: { completedAt: now },
      },
      () => prisma.task.update({ where: { id: task.id }, data: { completedAt: now } })
    );
    sent++;
  }
  return sent;
}

export interface SlaSweepResult {
  scanned: number;
  riskPredictions: number;
  breachesFlagged: number;
  escalations: number;
  closureRemindersSent: number;
}

export async function runSlaSweep(): Promise<SlaSweepResult> {
  const now = new Date();
  const openTasks = await prisma.task.findMany({ where: { completedAt: null } });
  const counters = { riskPredictions: 0, breachesFlagged: 0, escalations: 0 };

  for (const task of openTasks) {
    // CLOSURE_REMINDER is handled separately below (it's a scheduled
    // notification, not an SLA-breach task) — skip it here.
    if (task.type === "CLOSURE_REMINDER") continue;
    // A task whose internship/referral already reached a terminal state
    // (withdrawn, rejected, closed, ...) is dead — it must not keep
    // generating escalations forever just because nobody marked it complete.
    if (!(await isLinkedToLiveEntity(task))) continue;
    await processOpenTask(task, now, counters);
  }

  const closureRemindersSent = await sendDueClosureReminders(now);

  return { scanned: openTasks.length, closureRemindersSent, ...counters };
}
