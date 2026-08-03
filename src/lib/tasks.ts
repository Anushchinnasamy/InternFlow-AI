import { Role } from "@prisma/client";
import { prisma } from "./prisma";
import { withAudit } from "./withAudit";

/** Marks a Task complete, flipping slaBreached at write time if it's overdue. */
export async function completeTask(
  taskId: string,
  actor: { actorId: string; role: Role; ip?: string | null }
) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return null;

  const now = new Date();
  const slaBreached = now > task.dueAt;

  return withAudit(
    {
      actorId: actor.actorId,
      role: actor.role,
      action: "COMPLETE",
      entity: "Task",
      entityId: task.id,
      before: { completedAt: task.completedAt, slaBreached: task.slaBreached },
      after: { completedAt: now, slaBreached },
      ip: actor.ip ?? null,
    },
    () => prisma.task.update({ where: { id: task.id }, data: { completedAt: now, slaBreached } })
  );
}
