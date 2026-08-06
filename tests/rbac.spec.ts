// Day 7 RBAC hardening: iterates every protected endpoint built across
// Days 1-6 against all 9 role tokens. For each (route, role) pair it
// asserts:
//   - a role NOT in the route's allowed list ALWAYS gets exactly 403
//   - a role IN the route's allowed list NEVER gets 403 (or 401)
//
// It deliberately does not assert a literal 200/201 for allowed roles.
// Doing that would require building a fully valid business-state fixture
// for every one of these ~55 endpoints (a specific internship in exactly
// the right status, with the right documents/tasks/approvals already in
// place) — effectively the entire Day 4-6 verification fixture graph
// reproduced inside a test file. What this suite actually verifies is the
// thing CLAUDE.md rule 2 cares about: the RBAC gate itself. An allowed
// role reaching business logic and getting a 400/404/409 there is a
// correctly-functioning gate; only a 401/403 for an allowed role is a gate
// bug. All test requests use placeholder ids and empty bodies, which also
// keeps this suite from ever triggering a real AI call (every AI-calling
// handler validates input via Zod, or checks req.file, before touching
// lib/ai — an empty body/no file 400s first).
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { Role } from "@prisma/client";
import { app } from "../src/app";

const ALL_ROLES = Object.values(Role);
const PASSWORD = "Password123!";

const SEED_EMAIL: Record<Role, string> = {
  REFERRER: "referrer@internflow.dev",
  CANDIDATE: "candidate@internflow.dev",
  MENTOR: "mentor@internflow.dev",
  HR: "hr@internflow.dev",
  PROGRAM_OWNER: "programowner@internflow.dev",
  ADMIN_SECURITY: "adminsecurity@internflow.dev",
  IT_ADMIN: "itadmin@internflow.dev",
  LEGAL: "legal@internflow.dev",
  SYSADMIN: "sysadmin@internflow.dev",
};

interface RouteCase {
  method: "get" | "post" | "patch";
  path: string;
  allowed: Role[];
}

// One entry per requireRole(...)-guarded endpoint across Days 1-7.
// GET /me and POST /webhooks/email-status are intentionally excluded — the
// first is open to every authenticated role by design (view your own
// profile), the second is an unauthenticated provider webhook.
const ROUTES: RouteCase[] = [
  // candidates.ts
  { method: "post", path: "/candidates", allowed: [Role.REFERRER, Role.HR] },
  { method: "get", path: "/candidates/search?q=x", allowed: [Role.HR, Role.PROGRAM_OWNER, Role.MENTOR, Role.REFERRER] },
  { method: "get", path: "/candidates/:id/360", allowed: [Role.HR, Role.PROGRAM_OWNER, Role.MENTOR, Role.REFERRER] },
  { method: "post", path: "/candidates/:id/evaluate", allowed: [Role.HR] },
  { method: "get", path: "/candidates/:id/evaluations", allowed: [Role.HR, Role.PROGRAM_OWNER, Role.MENTOR] },

  // evaluations.ts
  { method: "patch", path: "/evaluations/:id/rubric", allowed: [Role.HR] },
  { method: "post", path: "/evaluations/:id/decide", allowed: [Role.HR] },

  // chatbot.ts
  { method: "post", path: "/chatbot/ask", allowed: [Role.REFERRER, Role.CANDIDATE, Role.MENTOR] },

  // credentials.ts
  { method: "get", path: "/credentials/redeem/:token", allowed: [Role.CANDIDATE] },

  // dashboard.ts
  { method: "get", path: "/dashboard/stage-counts", allowed: [Role.PROGRAM_OWNER, Role.HR] },
  { method: "get", path: "/dashboard/sla-breaches", allowed: [Role.PROGRAM_OWNER, Role.HR, Role.IT_ADMIN, Role.ADMIN_SECURITY] },
  { method: "get", path: "/dashboard/cycle-time", allowed: [Role.PROGRAM_OWNER, Role.HR] },
  { method: "get", path: "/dashboard/completion-ratio", allowed: [Role.PROGRAM_OWNER, Role.HR] },
  { method: "get", path: "/dashboard/ai-metrics", allowed: [Role.ADMIN_SECURITY, Role.SYSADMIN, Role.PROGRAM_OWNER] },
  { method: "get", path: "/dashboard/email-health", allowed: [Role.PROGRAM_OWNER, Role.HR] },

  // extensions.ts
  { method: "post", path: "/extensions/:taskId/decide", allowed: [Role.HR, Role.PROGRAM_OWNER] },

  // internships.ts
  { method: "post", path: "/internships/:id/non-worker-id", allowed: [Role.HR] },
  { method: "post", path: "/internships/:id/nda/sign", allowed: [Role.CANDIDATE] },
  { method: "post", path: "/internships/:id/confirmation-letter", allowed: [Role.HR] },
  { method: "get", path: "/internships/:id/documents", allowed: [Role.HR, Role.LEGAL, Role.PROGRAM_OWNER, Role.SYSADMIN, Role.CANDIDATE] },
  { method: "post", path: "/internships/:id/ad-provision", allowed: [Role.IT_ADMIN] },
  { method: "post", path: "/internships/:id/site-access", allowed: [Role.ADMIN_SECURITY] },
  { method: "post", path: "/internships/:id/ready-check", allowed: [Role.IT_ADMIN, Role.ADMIN_SECURITY, Role.SYSADMIN] },
  { method: "post", path: "/internships/:id/mutual-connect", allowed: [Role.HR, Role.PROGRAM_OWNER, Role.SYSADMIN, Role.MENTOR] },
  { method: "get", path: "/internships/:id/dossier", allowed: [Role.MENTOR] },
  { method: "post", path: "/internships/:id/credentials/issue", allowed: [Role.IT_ADMIN] },
  { method: "post", path: "/internships/:id/credentials/reissue", allowed: [Role.IT_ADMIN] },
  { method: "post", path: "/internships/:id/start-confirm", allowed: [Role.MENTOR] },
  { method: "post", path: "/internships/:id/mark-delayed", allowed: [Role.MENTOR, Role.HR] },
  { method: "post", path: "/internships/:id/extend", allowed: [Role.MENTOR] },
  { method: "post", path: "/internships/:id/reassign-mentor", allowed: [Role.PROGRAM_OWNER, Role.HR] },
  { method: "post", path: "/internships/:id/withdraw", allowed: [Role.CANDIDATE, Role.REFERRER, Role.HR] },
  { method: "post", path: "/internships/:id/close", allowed: [Role.HR, Role.MENTOR] },
  { method: "post", path: "/internships/:id/ad-deactivate", allowed: [Role.IT_ADMIN] },
  { method: "post", path: "/internships/:id/non-worker-id-deactivate", allowed: [Role.HR] },
  { method: "post", path: "/internships/:id/badge-return", allowed: [Role.ADMIN_SECURITY] },
  { method: "post", path: "/internships/:id/close-check", allowed: [Role.HR, Role.IT_ADMIN, Role.ADMIN_SECURITY, Role.PROGRAM_OWNER, Role.SYSADMIN] },
  { method: "post", path: "/internships/:id/mentor-confirm-completion", allowed: [Role.MENTOR] },
  { method: "post", path: "/internships/:id/certificate-request", allowed: [Role.CANDIDATE] },
  { method: "post", path: "/internships/:id/certificate-request/approve", allowed: [Role.HR] },
  { method: "post", path: "/internships/:id/certificate/generate", allowed: [Role.HR] },

  // joiningForms.ts
  { method: "post", path: "/joining-forms", allowed: [Role.CANDIDATE] },
  { method: "patch", path: "/joining-forms/:id", allowed: [Role.CANDIDATE] },
  { method: "post", path: "/joining-forms/:id/attachments", allowed: [Role.CANDIDATE] },
  { method: "get", path: "/joining-forms/:id", allowed: ALL_ROLES },
  { method: "post", path: "/joining-forms/:id/submit", allowed: [Role.CANDIDATE] },
  { method: "post", path: "/joining-forms/:id/verify", allowed: [Role.HR] },
  { method: "post", path: "/joining-forms/:id/unlock", allowed: [Role.HR] },

  // notifications.ts
  { method: "post", path: "/notifications/draft", allowed: [Role.HR, Role.PROGRAM_OWNER] },
  { method: "post", path: "/notifications/draft/:id/approve-and-send", allowed: [Role.HR, Role.PROGRAM_OWNER] },

  // referrals.ts
  { method: "post", path: "/referrals", allowed: [Role.REFERRER, Role.HR] },
  { method: "post", path: "/referrals/:id/hr-review", allowed: [Role.HR] },
  { method: "patch", path: "/referrals/:id/override", allowed: [Role.REFERRER, Role.HR] },
  { method: "post", path: "/referrals/:id/mentor-confirm", allowed: [Role.MENTOR] },
  { method: "get", path: "/referrals/pending-confirmation", allowed: [Role.MENTOR] },

  // resumeParse.ts (mounted at /ai)
  { method: "post", path: "/ai/resume-parse", allowed: [Role.REFERRER, Role.HR] },

  // tasks.ts
  { method: "post", path: "/tasks/:id/remind", allowed: [Role.MENTOR, Role.HR, Role.PROGRAM_OWNER, Role.SYSADMIN] },
  // Frontend Day F5 — generalized from IT_ADMIN-only. The matrix gate below
  // is deliberately broader than any single task's real assigneeRole (it's
  // "which roles can ever be a checklist assignee"); the actual per-task
  // check (`caller.role === task.assigneeRole`) only runs once a real task
  // is found, so it's outside what this 404-tolerant sweep can exercise.
  { method: "patch", path: "/tasks/:id/checklist", allowed: [Role.IT_ADMIN, Role.HR] },

  // certificates.ts — Frontend Day F5
  { method: "get", path: "/certificates?status=issued", allowed: [Role.HR, Role.PROGRAM_OWNER] },
  { method: "get", path: "/certificates/:id/download", allowed: [Role.HR, Role.PROGRAM_OWNER] },
  { method: "post", path: "/certificates/:id/revoke", allowed: [Role.HR] },

  // admin.ts
  { method: "get", path: "/admin/audit-events", allowed: [Role.ADMIN_SECURITY, Role.SYSADMIN] },
  { method: "get", path: "/admin/ai-actions", allowed: [Role.ADMIN_SECURITY, Role.SYSADMIN, Role.PROGRAM_OWNER] },
  { method: "patch", path: "/admin/users/:id/active", allowed: [Role.SYSADMIN] },
  // Frontend Day F5
  { method: "get", path: "/admin/users", allowed: [Role.SYSADMIN] },
  { method: "post", path: "/admin/users", allowed: [Role.SYSADMIN] },
  { method: "patch", path: "/admin/users/:id", allowed: [Role.SYSADMIN] },
  { method: "get", path: "/admin/audit-logs", allowed: [Role.SYSADMIN, Role.PROGRAM_OWNER, Role.LEGAL] },

  // auth.ts — Frontend Day F5. No requireRole at all (any authenticated
  // user acts on their own record), so every role belongs in `allowed`.
  { method: "patch", path: "/auth/me", allowed: ALL_ROLES },
  { method: "post", path: "/auth/change-password", allowed: ALL_ROLES },
];

function resolvePath(path: string): string {
  return path.replace(/:id\b/g, "does-not-exist").replace(/:taskId\b/g, "does-not-exist").replace(/:token\b/g, "does-not-exist");
}

describe("RBAC sweep — every Day 1-7 endpoint x every role", () => {
  const tokens = {} as Record<Role, string>;

  beforeAll(async () => {
    for (const role of ALL_ROLES) {
      const res = await request(app).post("/auth/login").send({ email: SEED_EMAIL[role], password: PASSWORD });
      if (res.status !== 200) {
        throw new Error(
          `Could not log in seed user for ${role} (${SEED_EMAIL[role]}): ${res.status} ${JSON.stringify(res.body)}. ` +
            `Run "npm run prisma:seed" first.`
        );
      }
      tokens[role] = res.body.token;
    }
  });

  for (const route of ROUTES) {
    describe(`${route.method.toUpperCase()} ${route.path}`, () => {
      for (const role of ALL_ROLES) {
        const shouldBeAllowed = route.allowed.includes(role);
        it(`${role}: ${shouldBeAllowed ? "must not get 403" : "must get exactly 403"}`, async () => {
          const req = request(app)
            [route.method](resolvePath(route.path))
            .set("Authorization", `Bearer ${tokens[role]}`);
          const res = route.method === "get" ? await req : await req.send({});

          if (shouldBeAllowed) {
            expect(res.status).not.toBe(401);
            expect(res.status).not.toBe(403);
          } else {
            expect(res.status).toBe(403);
          }
        });
      }
    });
  }

  it("rejects an unauthenticated request on a sample protected route", async () => {
    const res = await request(app).get("/dashboard/stage-counts");
    expect(res.status).toBe(401);
  });
});
