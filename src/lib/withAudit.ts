// Every create/update/delete/approve against a business-entity table MUST
// go through this wrapper. It is the only path allowed to follow a Prisma
// mutation with an AuditEvent write. Do not call `prisma.<model>.create /
// update / delete` directly from a route or service for anything other
// than the AuditEvent and AiAction tables themselves — wrap it here so the
// audit trail can never be silently skipped.

import { Prisma, Role } from "@prisma/client";
import { prisma } from "./prisma";

function toJsonInput(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

export interface AuditParams<T> {
  actorId: string | null;
  role: Role | null;
  action: string;
  entity: string;
  // For updates/deletes the id is known upfront. For creates it doesn't
  // exist until after the mutation runs, so a function receiving the
  // mutation's result is accepted too.
  entityId: string | ((result: T) => string);
  before?: unknown;
  // Same reasoning as entityId above: some mutations (e.g. an atomic
  // server-side JSON merge) only know the true post-write state once the
  // mutation has run, not before — a caller-supplied fixed value would be
  // stale/wrong in that case.
  after?: unknown | ((result: T) => unknown);
  ip?: string | null;
}

export async function withAudit<T>(params: AuditParams<T>, mutation: () => Promise<T>): Promise<T> {
  const result = await mutation();

  const entityId = typeof params.entityId === "function" ? params.entityId(result) : params.entityId;
  const after = typeof params.after === "function" ? (params.after as (result: T) => unknown)(result) : params.after;

  await prisma.auditEvent.create({
    data: {
      actorId: params.actorId,
      role: params.role,
      action: params.action,
      entity: params.entity,
      entityId,
      before: toJsonInput(params.before),
      after: toJsonInput(after),
      ip: params.ip ?? null,
    },
  });

  return result;
}
