# Intern Flow

Backend for managing the full lifecycle of an unpaid internship — referral through closure and certificate — with server-side RBAC, a full audit trail, an NDA hard gate, and 9 AI-assisted actions (all advisory, all logged, all human-reviewable).

Node.js + TypeScript + Express + Prisma + PostgreSQL. See `CLAUDE.md` for the full non-negotiable rules this codebase is built against (NDA gate, RBAC, audit-everything, PII masking, single state machine, adapter pattern for external systems).

## The 17-step workflow, and which day built what

```
DRAFT → SUBMITTED → MENTOR_REVIEW → HR_REVIEW → APPROVED → JOINING_PENDING →
JOINING_SUBMITTED → VERIFIED → ID_ISSUED → NDA_PENDING → NDA_SIGNED →
ACCESS_PROVISIONED → READY_TO_START → ACTIVE → (EXTENDED) → COMPLETED → CLOSED
```

Every status change goes through the single `transition()` function (`src/lib/transition.ts`), which validates the edge against this graph and audits it. Terminal off-ramps (`REJECTED`, `WITHDRAWN`, `EXPIRED`, `CANCELLED`) are reachable from any non-terminal state; `DELAYED` branches off `READY_TO_START` for no-shows.

| Day | What it built |
|---|---|
| 1 | Auth, JWT, RBAC middleware + permission matrix, audit trail (`withAudit`), Prisma schema, AI-action scaffolding |
| 2 | Referral intake, resume-parsing AI pipeline (`RESUME_PARSE`/`FORM_PREFILL`/`CONFIDENCE_SCORE`), duplicate detection — `SUBMITTED → MENTOR_REVIEW` |
| 3 | HR review, joining form, joining-form AI checks — `MENTOR_REVIEW → HR_REVIEW → APPROVED → JOINING_PENDING → JOINING_SUBMITTED → VERIFIED` |
| 4 | Non-Worker ID, NDA e-sign + the hard gate (rule 1), confirmation letter — `ID_ISSUED → NDA_PENDING → NDA_SIGNED` |
| 5 | AD provisioning, site access/badge, credential delivery, mentor dossier, mutual-connect, start confirmation, and the lifecycle exception paths (delay, extend, reassign, withdraw) — `ACCESS_PROVISIONED → READY_TO_START → ACTIVE` |
| 6 | Closure workflow, certificates, the real email engine (24 templates, bounce webhook), the SLA sweep + 3-tier escalation — `COMPLETED → CLOSED`, plus `EMAIL_DRAFT`/`SLA_RISK_PREDICTION` |
| 7 | Chatbot (`CHATBOT_ANSWER`, the last AI action), dashboards, Candidate 360, RBAC test suite + audit hardening, deploy artifacts |
| 8 | Frontend Day F5 support: generalized the checklist endpoint's RBAC (task-instance `assigneeRole` check, not a hardcoded role), an auto-populated exit checklist on closure, certificate revoke/list/download, admin user management + a paginated/filterable audit log, and self-service profile/password endpoints |

## Stack

Express + Prisma + PostgreSQL, JWT auth (jsonwebtoken + bcrypt), Zod validation everywhere. AI: Google Gemini (`@google/genai`) via structured-output calls. Email: Resend, with a console-logging fallback adapter when no key is configured. PDFs: `pdf-lib`. Scheduled jobs: `node-cron`.

External systems (AD, e-sign, email, non-worker-ID) are all behind adapter interfaces in `src/lib/adapters/` with manual/mock implementations — swapping in a real provider is a config change, not a rewrite.

## Local setup

```bash
npm install
cp .env.example .env   # fill in the values below
npx prisma migrate dev
npm run prisma:seed
npm run dev
```

`npm run prisma:seed` creates one user per role, all sharing the password `Password123!` — see `prisma/seed.ts` for the exact emails.

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgresql://USER:PASSWORD@HOST:5432/internflow?schema=public` |
| `JWT_SECRET` | yes | any random string in dev; a real secret in production |
| `JWT_EXPIRES_IN` | no | defaults to `8h` |
| `PORT` | no | defaults to `4000` |
| `AI_API_KEY` | yes | Google Gemini API key |
| `AI_MODEL` | no | defaults to `gemini-3.6-flash` |
| `UPLOAD_DIR` | no | defaults to `./uploads` (local disk stand-in for S3/Blob) |
| `RESEND_API_KEY` | no | unset falls back to a console-logging mock email adapter |
| `RESEND_FROM_EMAIL` | no | defaults to `Intern Flow <onboarding@resend.dev>` |

## Running with Docker

```bash
AI_API_KEY=your-key docker compose up --build
```

This starts Postgres and the app, running `prisma migrate deploy` automatically before the server starts. The app is on `http://localhost:4000`. Set `JWT_SECRET`, `RESEND_API_KEY`, etc. as additional env vars the same way if you need real values rather than the compose defaults.

> The Dockerfile/compose file are written and structurally reviewed but not build-verified in this environment (no running Docker daemon here) — worth a `docker compose up --build` smoke test before relying on them.

## Tests

```bash
npm test
```

Two spec files:
- `tests/rbac.spec.ts` — every `requireRole`-guarded endpoint across Days 1-8 (~65 routes) against all 9 role tokens, asserting the RBAC gate itself: a disallowed role always gets exactly 403, an allowed role never gets 401/403. It does not assert full 200-success paths for every route, which would require reproducing the entire multi-day fixture graph (a specific internship in exactly the right status with the right approvals already in place) inside the test file — see the comment at the top of the spec file for the reasoning. Requires the seeded dev DB (`npm run prisma:seed`) and hits it over real HTTP via `supertest`, not mocks.
- `tests/exitChecklist.spec.ts` — pure-function unit tests for the exit checklist's auto-flip logic (`src/lib/exitChecklist.ts`), no DB needed.

## Deploying (Render / Railway)

1. Push this repo to GitHub.
2. Create a new Web Service (Render) or Project (Railway) from the repo.
3. Add a managed PostgreSQL instance (both platforms offer one); use its connection string as `DATABASE_URL`.
4. Set the environment variables from the table above (`JWT_SECRET`, `AI_API_KEY`, and `RESEND_API_KEY` at minimum for real functionality).
5. Build command: `npm ci && npx prisma generate && npm run build`. Start command: `npx prisma migrate deploy && npm start`.
6. After deploy, smoke-test with `GET /health` — see below.

## Post-deploy smoke test

```bash
curl https://<your-deployed-url>/health
```

Expect `{"status":"ok","dbConnected":true,"roles":[...9 roles...],"aiActionTypes":[...9 types...]}`. If `dbConnected` is false or the arrays are short, something in the environment/migration step didn't complete.
