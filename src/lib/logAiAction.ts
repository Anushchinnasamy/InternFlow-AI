// Every one of the 9 AI actions (see AiActionType) must call this after
// running, even while the underlying logic is a hardcoded stub. AI output
// is always advisory — nothing here writes to a business table directly;
// callers decide whether/how a human applies the result.

import { AiActionType, Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export interface LogAiActionParams {
  type: AiActionType;
  entity: string;
  entityId?: string | null;
  input?: unknown;
  output: unknown;
  confidence?: number | null;
  modelUsed: string;
  // Who triggered this call — null for system-triggered actions (e.g. the
  // SLA sweep's slaRiskPrediction), same convention as AuditEvent's
  // actorId. Powers the Resume Analyzer's "History" tab
  // (GET /ai-actions?mine=true).
  actorId?: string | null;
}

export async function logAiAction(params: LogAiActionParams) {
  return prisma.aiAction.create({
    data: {
      type: params.type,
      entity: params.entity,
      entityId: params.entityId ?? null,
      input:
        params.input === undefined
          ? undefined
          : params.input === null
            ? Prisma.JsonNull
            : (params.input as Prisma.InputJsonValue),
      output: params.output as Prisma.InputJsonValue,
      confidence: params.confidence ?? null,
      modelUsed: params.modelUsed,
      actorId: params.actorId ?? null,
    },
  });
}
