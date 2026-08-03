# Intern Flow — Project Context

Workflow app automating unpaid internship lifecycle: referral → mentor confirm → HR approve → joining form → Non-Worker ID → NDA (e-sign, hard gate) → AD provisioning → start → lifecycle (delay/extend/reassign) → closure → deactivation → certificate.

## Stack
Standalone backend: Node.js + TypeScript + Express + Prisma + PostgreSQL, JWT auth (jsonwebtoken + bcrypt), Zod validation. Frontend is a separate concern, added later as a client of this API rather than a Next.js monolith. (Originally scoped as Next.js App Router + NextAuth; changed Day 1 since the build started as a standalone backend with no frontend yet — see `AuditEvent`/`AiAction` scaffolding below for what's already in place.) Tailwind + shadcn/ui, Resend for email, React-PDF for documents, Vercel Blob/S3 for storage remain the plan for whatever frontend consumes this API.

## Non-negotiable rules (do not weaken these under time pressure)
1. **NDA gate**: internship status can never reach `READY_TO_START` unless a `Document` of type `NDA` exists with `signedAt` at least 1 day before `startDate`. Enforce in a server-side transition function, not just UI.
2. **RBAC is server-side only.** Every API route/server action checks the caller's role against the permission matrix before touching data. Never rely on hiding UI elements.
3. **Audit everything.** Every create/update/delete/approve writes an `AuditEvent` row (actor, role, action, entity, before, after, timestamp). No update path bypasses this — wrap mutations in a shared `withAudit()` helper.
4. **PII masking.** Government ID fields and full DOB render masked (`****1234`) to all roles except HR/Legal; unmasking writes an audit event.
5. **State machine only.** Internship/Referral status changes go through one `transition(entity, fromState, toState, actor)` function that validates the transition is legal per the state graph. No direct `status = X` writes elsewhere in the codebase.
6. **Adapters, not integrations.** AD, e-sign, and HR-identity are behind interfaces (`ADAdapter`, `ESignAdapter`, `NonWorkerIdAdapter`) with a manual/mock implementation now. Never hardcode a real API call inline — always through the adapter so swapping providers later is a config change.

## Roles
Referrer, Candidate, Mentor, HR, ProgramOwner, AdminSecurity, ITAdmin, Legal, SysAdmin. Permission matrix lives in `src/middleware/rbac.ts` — one file, one source of truth (`requireRole(...)` factory + `PERMISSION_MATRIX`).

## Status model (Internship)
DRAFT → SUBMITTED → MENTOR_REVIEW → HR_REVIEW → APPROVED → JOINING_PENDING → JOINING_SUBMITTED → VERIFIED → ID_ISSUED → NDA_PENDING → NDA_SIGNED → ACCESS_PROVISIONED → READY_TO_START → ACTIVE → EXTENDED → COMPLETED → CLOSED
Terminal off-ramps: REJECTED, WITHDRAWN, EXPIRED, CANCELLED

## SLA clocks (business days unless noted)
Mentor confirm: 2d · HR screening: 3d · Joining form: 5 calendar days · Non-Worker ID: **1 day** · NDA: **signed ≥1 day before start** · AD provisioning: 2d · **AD deactivation: ≤24h post-end**

## Conventions
- One Prisma schema, migrations only (never edit prod DB by hand).
- Express routes under `src/routes/`, one router per resource, mounted in `src/index.ts`.
- Every route validates input with Zod.
- Commit at the end of each build-plan day with a message matching that day's scope.

## AI provider
Google Gemini (`@google/genai`), not OpenAI/Anthropic — the user only had a Gemini key available when Day 2 (real resume-parsing AI actions) was built. Client + model default live in `src/lib/geminiClient.ts` (`AI_API_KEY`, `AI_MODEL` env vars); structured-output helper in `src/lib/geminiStructured.ts`. Schemas passed to it must import `z` from `"zod/v3"`, not the app's usual `"zod"` (v4) — `zod-to-json-schema`'s types are still written against the v3 shape; mixing them is a type error, not a runtime one. Confirmed working model on this key: `gemini-3.6-flash` (default). `gemini-2.0-flash` returned a zero-quota 429 and `gemini-2.5-flash` a 404 ("no longer available to new users") on this same key — if AI calls start failing, check the model ID against current availability before assuming the code broke.

## Do not build yet (see cut list in build plan)
Live AD API calls, licensed e-sign API, bulk upload, formal accessibility/pen-test — all stubbed behind adapters or deferred. (AI resume parsing/chatbot: resume parsing landed Day 2; chatbot is still Day 3+.)
