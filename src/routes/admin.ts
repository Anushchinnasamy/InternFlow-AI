import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX, ALL_ROLES } from "../middleware/rbac";
import { withAudit } from "../lib/withAudit";

const router = Router();

const SALT_ROUNDS = 12;

router.get(
  "/audit-events",
  authenticate,
  requireRole(...PERMISSION_MATRIX.auditEvent.read),
  async (_req, res) => {
    const events = await prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ events });
  }
);

router.get(
  "/ai-actions",
  authenticate,
  requireRole(...PERMISSION_MATRIX.aiAction.read),
  async (_req, res) => {
    const actions = await prisma.aiAction.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ actions });
  }
);

// Demonstration-only route: SYSADMIN can toggle a user's `active` flag.
// Shows requireRole blocking a wrong role AND withAudit-backed mutation
// on a business entity in the same place.
router.patch(
  "/users/:id/active",
  authenticate,
  requireRole(Role.SYSADMIN),
  async (req, res) => {
    const { active } = req.body as { active?: boolean };
    if (typeof active !== "boolean") {
      res.status(400).json({ error: "'active' boolean is required" });
      return;
    }

    const target = await prisma.user.findUnique({ where: { id: req.params.id as string } });
    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const updated = await withAudit(
      {
        actorId: req.user!.userId,
        role: req.user!.role,
        action: "UPDATE_USER_ACTIVE",
        entity: "User",
        entityId: target.id,
        before: { active: target.active },
        after: { active },
        ip: req.ip ?? null,
      },
      () => prisma.user.update({ where: { id: target.id }, data: { active } })
    );

    const { passwordHash: _passwordHash, ...publicUser } = updated;
    res.json({ user: publicUser });
  }
);

// Frontend Day F5 Admin page — Users tab. SYSADMIN-only, same audience as
// the /:id/active demo route above but covering role changes too, per the
// build plan's explicit "PATCH /admin/users/:id (change role, toggle
// active)" scope (kept alongside rather than replacing the older route,
// which nothing else references).
router.get("/users", authenticate, requireRole(...PERMISSION_MATRIX.admin.usersManage), async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "desc" } });
  res.json({ users: users.map(({ passwordHash: _passwordHash, ...u }) => u) });
});

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  role: z.enum(ALL_ROLES as [Role, ...Role[]]),
  department: z.string().optional(),
  site: z.string().optional(),
});

router.post("/users", authenticate, requireRole(...PERMISSION_MATRIX.admin.usersManage), async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
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
      actorId: req.user!.userId,
      role: req.user!.role,
      action: "ADMIN_CREATE_USER",
      entity: "User",
      entityId: (created) => created.id,
      after: { email, name, role, department, site },
      ip: req.ip ?? null,
    },
    () => prisma.user.create({ data: { email, name, role, department, site, passwordHash } })
  );

  const { passwordHash: _passwordHash, ...publicUser } = user;
  res.status(201).json({ user: publicUser });
});

const updateUserSchema = z
  .object({
    role: z.enum(ALL_ROLES as [Role, ...Role[]]).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.active !== undefined, { message: "At least one of role or active is required" });

// Deactivating a user here never deletes anything — `active: false` just
// blocks future logins (see auth.ts's login check); their historical
// AuditEvent rows (actorId still points at them) are untouched, same
// "nothing gets hard-deleted" principle as certificate revocation.
router.patch("/users/:id", authenticate, requireRole(...PERMISSION_MATRIX.admin.usersManage), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  const parsedBody = updateUserSchema.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
    return;
  }
  const { id } = parsedParams.data;

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const updated = await withAudit(
    {
      actorId: req.user!.userId,
      role: req.user!.role,
      action: "ADMIN_UPDATE_USER",
      entity: "User",
      entityId: target.id,
      before: { role: target.role, active: target.active },
      after: parsedBody.data,
      ip: req.ip ?? null,
    },
    () => prisma.user.update({ where: { id: target.id }, data: parsedBody.data })
  );

  const { passwordHash: _passwordHash, ...publicUser } = updated;
  res.json({ user: publicUser });
});

// Frontend Day F5 Admin page — Audit Logs tab. Distinct from GET
// /admin/audit-events above (Day 1's unfiltered ADMIN_SECURITY/SYSADMIN
// feed): this is the compliance-facing view — paginated and filterable by
// entity/actor/date range, and available to LEGAL and PROGRAM_OWNER too,
// per the build plan calling it "the only place in the system that exposes
// the raw audit trail directly."
const auditLogQuerySchema = z.object({
  entity: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).optional(),
});

router.get("/audit-logs", authenticate, requireRole(...PERMISSION_MATRIX.admin.auditLog), async (req, res) => {
  const parsed = auditLogQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { entity, actorId, from, to } = parsed.data;
  const page = parsed.data.page ?? 1;
  const pageSize = 50;

  const where: Prisma.AuditEventWhereInput = {
    ...(entity ? { entity } : {}),
    ...(actorId ? { actorId } : {}),
    ...(from || to
      ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
      : {}),
  };

  const [events, total] = await Promise.all([
    prisma.auditEvent.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.auditEvent.count({ where }),
  ]);

  res.json({ events, total, page, pageSize });
});

export default router;
