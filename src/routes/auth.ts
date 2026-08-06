import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { signToken } from "../lib/jwt";
import { withAudit } from "../lib/withAudit";
import { authenticate } from "../middleware/authenticate";

const router = Router();

const SALT_ROUNDS = 12;

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  role: z.nativeEnum(Role),
  department: z.string().optional(),
  site: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function toPublicUser(user: {
  id: string;
  email: string;
  name: string;
  role: Role;
  department: string | null;
  site: string | null;
  active: boolean;
  createdAt: Date;
  preferences?: unknown;
}) {
  const { id, email, name, role, department, site, active, createdAt, preferences } = user;
  return { id, email, name, role, department, site, active, createdAt, preferences: preferences ?? null };
}

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { email, password, name, role, department, site } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await withAudit(
    {
      actorId: null,
      role,
      action: "REGISTER",
      entity: "User",
      entityId: (created) => created.id,
      after: { email, name, role, department, site },
      ip: req.ip ?? null,
    },
    () => prisma.user.create({ data: { email, name, role, department, site, passwordHash } })
  );

  // A candidate has a Candidate profile row (created by a referrer during
  // intake, Day 2) before they ever have a login. Link the two the first
  // time they register, by matching email — this is the only way a
  // CANDIDATE-role token can later resolve "my own" joining form / record.
  if (role === Role.CANDIDATE) {
    const unlinkedCandidate = await prisma.candidate.findFirst({ where: { email, userId: null } });
    if (unlinkedCandidate) {
      await withAudit(
        {
          actorId: user.id,
          role,
          action: "LINK_CANDIDATE_PROFILE",
          entity: "Candidate",
          entityId: unlinkedCandidate.id,
          before: { userId: null },
          after: { userId: user.id },
          ip: req.ip ?? null,
        },
        () => prisma.candidate.update({ where: { id: unlinkedCandidate.id }, data: { userId: user.id } })
      );
    }
  }

  const token = signToken({ userId: user.id, role: user.role });
  res.status(201).json({ token, user: toPublicUser(user) });
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = signToken({ userId: user.id, role: user.role });
  res.json({ token, user: toPublicUser(user) });
});

// Frontend Day F5 Settings page — Profile tab. Deliberately excludes role
// and email: role is admin-controlled (see PATCH /admin/users/:id) and email
// is fixed, per the build plan. `timezone` isn't its own column — it's
// folded into the `preferences` JSON blob (see schema.prisma) so adding
// another client preference later doesn't need another migration.
const updateMeSchema = z
  .object({
    name: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
  })
  .refine((v) => v.name !== undefined || v.timezone !== undefined, { message: "At least one of name or timezone is required" });

router.patch("/me", authenticate, async (req, res) => {
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { name, timezone } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const currentPreferences = (user.preferences as Record<string, unknown> | null) ?? {};
  const updatedPreferences = timezone !== undefined ? { ...currentPreferences, timezone } : currentPreferences;

  const updated = await withAudit(
    {
      actorId: user.id,
      role: req.user!.role,
      action: "UPDATE_PROFILE",
      entity: "User",
      entityId: user.id,
      before: { name: user.name, preferences: currentPreferences },
      after: { name: name ?? user.name, preferences: updatedPreferences },
      ip: req.ip ?? null,
    },
    () =>
      prisma.user.update({
        where: { id: user.id },
        data: { ...(name !== undefined ? { name } : {}), preferences: updatedPreferences as Prisma.InputJsonValue },
      })
  );

  res.json({ user: toPublicUser(updated) });
});

// Frontend Day F5 Settings page — Security tab.
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

router.post("/change-password", authenticate, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { currentPassword, newPassword } = parsed.data;

  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    // 403, not 401: this request IS authenticated (a valid JWT got it past
    // `authenticate` above) — it's the separately-supplied current-password
    // proof that's wrong. The frontend's shared api.ts client treats any 401
    // as "session expired" and force-logs the user out globally (see
    // registerUnauthorizedHandler in lib/api.ts) — a 401 here would silently
    // boot the user out of their own change-password attempt instead of
    // showing them the "wrong password" message.
    res.status(403).json({ error: "Current password is incorrect" });
    return;
  }

  const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  // Deliberately no before/after payload — password hashes never belong in
  // the audit trail even hashed, unlike every other withAudit call in this
  // codebase which logs a real before/after diff.
  await withAudit(
    { actorId: user.id, role: req.user!.role, action: "CHANGE_PASSWORD", entity: "User", entityId: user.id, ip: req.ip ?? null },
    () => prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } })
  );

  res.json({ success: true });
});

export default router;
