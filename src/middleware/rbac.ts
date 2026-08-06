// Single source of truth for role-based access control.
// Every route that mutates or reads protected data must be wrapped in
// `requireRole(...)` — role checks must never be written inline in a
// handler body. `authenticate` must run before this middleware so
// `req.user` is populated.

import { Request, Response, NextFunction } from "express";
import { Role } from "@prisma/client";

export const ALL_ROLES: Role[] = [
  Role.REFERRER,
  Role.CANDIDATE,
  Role.MENTOR,
  Role.HR,
  Role.PROGRAM_OWNER,
  Role.ADMIN_SECURITY,
  Role.IT_ADMIN,
  Role.LEGAL,
  Role.SYSADMIN,
];

// Forward-looking permission matrix: resource -> action -> roles allowed.
// Day 1 has no business routes for these resources yet (they land in later
// build-plan days), but the matrix is defined now so every future route
// reads its allowed roles from here rather than inventing a new list inline.
export const PERMISSION_MATRIX = {
  candidate: {
    create: [Role.REFERRER, Role.HR],
    parseResume: [Role.REFERRER, Role.HR],
    // Frontend Day F3. Side-effect-free duplicate/missing-info/validation
    // preview for Referral Intake's live side panels — same role set as
    // create, since it's a preview of the same action.
    precheck: [Role.REFERRER, Role.HR],
    // Frontend Day F3. Ad-hoc match-score analysis (no persisted Candidate
    // yet) for the Resume Analyzer — same role set as parseResume, since
    // it's the same page. Distinct from `evaluate` below, which is the
    // official, persisted-record path and stays HR-only.
    evaluateAdhoc: [Role.REFERRER, Role.HR],
    // Day 7 Candidate 360 — RBAC-scoped in-handler (MENTOR to own interns,
    // REFERRER to own referrals; HR/PROGRAM_OWNER see everything).
    search: [Role.HR, Role.PROGRAM_OWNER, Role.MENTOR, Role.REFERRER],
    view360: [Role.HR, Role.PROGRAM_OWNER, Role.MENTOR, Role.REFERRER],
    // Match-scoring add-on
    evaluate: [Role.HR],
    // MENTOR is scoped in-handler to their own candidates (same pattern as
    // view360 above), not a blanket allow.
    evaluationsRead: [Role.HR, Role.PROGRAM_OWNER, Role.MENTOR],
  },
  referral: {
    create: [Role.REFERRER, Role.HR],
    override: [Role.REFERRER, Role.HR],
    mentorConfirm: [Role.MENTOR],
    hrReview: [Role.HR],
    review: [Role.MENTOR, Role.HR],
    approve: [Role.HR, Role.PROGRAM_OWNER],
  },
  internship: {
    read: ALL_ROLES,
    updateStatus: [Role.HR, Role.PROGRAM_OWNER, Role.MENTOR, Role.SYSADMIN],
    provisionAccess: [Role.IT_ADMIN, Role.ADMIN_SECURITY, Role.SYSADMIN],
    nonWorkerId: [Role.HR],
    confirmationLetter: [Role.HR],
    // Day 5
    adProvision: [Role.IT_ADMIN],
    siteAccess: [Role.ADMIN_SECURITY],
    // readyCheck reuses provisionAccess's role set — it's the "is
    // provisioning finished" checkpoint for the same IT/security/sysadmin
    // group that does the provisioning itself.
    readyCheck: [Role.IT_ADMIN, Role.ADMIN_SECURITY, Role.SYSADMIN],
    credentialsIssue: [Role.IT_ADMIN],
    credentialsReissue: [Role.IT_ADMIN],
    dossier: [Role.MENTOR],
    mutualConnect: [Role.HR, Role.PROGRAM_OWNER, Role.SYSADMIN, Role.MENTOR],
    startConfirm: [Role.MENTOR],
    markDelayed: [Role.MENTOR, Role.HR],
    extend: [Role.MENTOR],
    reassignMentor: [Role.PROGRAM_OWNER, Role.HR],
    // Ownership (own internship / own referral) is checked in-handler for
    // CANDIDATE and REFERRER; HR can withdraw any internship.
    withdraw: [Role.CANDIDATE, Role.REFERRER, Role.HR],
    // Frontend Day F4 — HR-only, mirrors document.signNda's audience being
    // the other side of the same NDA gate.
    ndaExpire: [Role.HR],
    // Day 6 closure workflow
    close: [Role.HR, Role.MENTOR],
    adDeactivate: [Role.IT_ADMIN],
    nonWorkerIdDeactivate: [Role.HR],
    badgeReturn: [Role.ADMIN_SECURITY],
    // Same "is closure finished" checkpoint pattern as Day 5's readyCheck.
    closeCheck: [Role.HR, Role.IT_ADMIN, Role.ADMIN_SECURITY, Role.PROGRAM_OWNER, Role.SYSADMIN],
    // Day 6 certificate workflow
    mentorConfirmCompletion: [Role.MENTOR],
    certificateRequest: [Role.CANDIDATE],
    certificateRequestApprove: [Role.HR],
  },
  joiningRecord: {
    create: [Role.CANDIDATE],
    update: [Role.CANDIDATE],
    submit: [Role.CANDIDATE],
    uploadAttachment: [Role.CANDIDATE],
    // Broader than plain "read" — every role can fetch a joining record, but
    // PII (govtIdNumber, dob) is masked for everyone except HR/LEGAL; see
    // src/lib/pii.ts. CANDIDATE is further restricted to their own record.
    read: ALL_ROLES,
    verify: [Role.HR],
    unlock: [Role.HR],
  },
  document: {
    upload: [Role.CANDIDATE, Role.HR, Role.LEGAL],
    // Day 4 spec: NDA signing is CANDIDATE-only (the candidate is the one
    // being asked to consent) — Legal reads/countersigns nothing here.
    signNda: [Role.CANDIDATE],
    // ALL_ROLES-style read: HR/Legal/ProgramOwner/Sysadmin can read every
    // internship's documents; CANDIDATE is further restricted in-handler to
    // their own internship's documents. MENTOR is deliberately excluded.
    read: [Role.HR, Role.LEGAL, Role.PROGRAM_OWNER, Role.SYSADMIN, Role.CANDIDATE],
  },
  task: {
    complete: [Role.IT_ADMIN, Role.HR, Role.ADMIN_SECURITY],
    // Manual reminder trigger for DELAY_FOLLOWUP tasks — Day 6's SLA sweep
    // will fire these automatically; this is the human-triggered fallback.
    remind: [Role.MENTOR, Role.HR, Role.PROGRAM_OWNER, Role.SYSADMIN],
    // Frontend Day F4 — Access Provisioning's 4 sub-track pills (AD_PROVISION
    // tasks, assigneeRole IT_ADMIN). Frontend Day F5 generalized this to also
    // cover EXIT_CHECKLIST tasks (assigneeRole HR) — the broad matrix grant
    // here is just "which roles can ever be a checklist task's assignee";
    // the actual per-task authorization is `caller.role === task.assigneeRole`,
    // checked in-handler in src/routes/tasks.ts (same "matrix gate + instance
    // ownership check" pattern as internship.close's mentor-ownership check).
    updateChecklist: [Role.IT_ADMIN, Role.HR],
  },
  extension: {
    decide: [Role.HR, Role.PROGRAM_OWNER],
  },
  certificate: {
    // Day 6 spec: certificate generation is HR-only (narrower than the Day 1
    // forward-looking scaffold, which also allowed PROGRAM_OWNER).
    issue: [Role.HR],
    // Frontend Day F5
    revoke: [Role.HR],
    list: [Role.HR, Role.PROGRAM_OWNER],
  },
  auditEvent: {
    read: [Role.ADMIN_SECURITY, Role.SYSADMIN],
  },
  // Frontend Day F5 Admin page. Separate from auditEvent.read (Day 1's
  // unfiltered ADMIN_SECURITY/SYSADMIN feed) — this is the paginated,
  // filterable compliance view, and its own user-management actions.
  admin: {
    usersManage: [Role.SYSADMIN],
    auditLog: [Role.SYSADMIN, Role.PROGRAM_OWNER, Role.LEGAL],
  },
  chatbot: {
    ask: [Role.REFERRER, Role.CANDIDATE, Role.MENTOR],
  },
  dashboard: {
    stageCounts: [Role.PROGRAM_OWNER, Role.HR],
    // Each role sees only tasks assigned to its own role, except
    // PROGRAM_OWNER which sees everything — scoping is enforced in-handler.
    slaBreaches: [Role.PROGRAM_OWNER, Role.HR, Role.IT_ADMIN, Role.ADMIN_SECURITY],
    cycleTime: [Role.PROGRAM_OWNER, Role.HR],
    completionRatio: [Role.PROGRAM_OWNER, Role.HR],
    emailHealth: [Role.PROGRAM_OWNER, Role.HR],
    // Frontend Day F2. Same role set as stageCounts — the narrative is built
    // from that same data, just LLM-summarized.
    aiNarrative: [Role.PROGRAM_OWNER, Role.HR],
    // Frontend Day F2 Dashboard's "Duplicate Candidate Alerts" widget.
    // Narrower than aiAction.read below (DUPLICATE_DETECTION rows only, not
    // every AI action type) so it can be handed to the same roles as
    // stageCounts without widening the general admin AI-action audit view.
    duplicateAlerts: [Role.PROGRAM_OWNER, Role.HR],
    // Frontend Day F2 SLA Monitoring's "AI Risk Predictions" table. Same
    // reasoning as duplicateAlerts — matches slaBreaches's role set exactly,
    // scoped to SLA_RISK_PREDICTION rows only.
    slaRiskPredictions: [Role.PROGRAM_OWNER, Role.HR, Role.IT_ADMIN, Role.ADMIN_SECURITY],
    // Frontend Day F2 Dashboard's "Recent Activities" feed. Same data as
    // GET /admin/audit-events (auditEvent.read, ADMIN_SECURITY/SYSADMIN
    // only) but scoped to stageCounts's role set instead, since Dashboard
    // itself is PROGRAM_OWNER/HR.
    recentActivity: [Role.PROGRAM_OWNER, Role.HR],
    // Frontend Day F2 Dashboard's "Upcoming Internship Closures" widget.
    // Same query shape as the weekly digest's internal count
    // (src/lib/weeklyDigest.ts), just listed instead of counted and with a
    // 30-day window instead of 7.
    upcomingClosures: [Role.PROGRAM_OWNER, Role.HR],
  },
  aiAction: {
    read: [Role.ADMIN_SECURITY, Role.SYSADMIN, Role.PROGRAM_OWNER],
  },
  // Frontend Day F2 AI Copilot (/copilot/analyze) — separate from
  // chatbot.ask's FAQ-only, KB-grounded bot. See src/lib/copilotAnalyze.ts.
  copilot: {
    analyze: [Role.HR, Role.PROGRAM_OWNER, Role.MENTOR, Role.IT_ADMIN, Role.ADMIN_SECURITY],
  },
  user: {
    // Frontend Day F3. Referral Intake needs to pick an actual MENTOR-role
    // user by name to get the `mentorId` FK — there was no user-lookup
    // endpoint of any kind before this. Same role set as candidate.create,
    // since it's the same form.
    listByRole: [Role.REFERRER, Role.HR],
  },
  evaluation: {
    // Rubric scoring and the final decision are both HR-only — same
    // reasoning as certificate.issue: one accountable role for the action
    // that actually matters, not a broad committee.
    rubric: [Role.HR],
    decide: [Role.HR],
  },
} as const;

/**
 * Middleware factory. Usage: router.get("/path", authenticate, requireRole(Role.HR, Role.SYSADMIN), handler)
 */
export function requireRole(...allowedRoles: Role[]) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({ error: "Forbidden: role not permitted for this action" });
      return;
    }
    next();
  };
}
