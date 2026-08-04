// The one place that turns "send this template" into both an EmailAdapter
// call and a NotificationLog row — every call site uses this instead of
// duplicating adapter-call + log-write, same reasoning as withAudit()
// existing so no mutation path can forget the audit trail.

import { emailAdapter } from "./adapters/email";
import { prisma } from "./prisma";

export interface SendTemplatedEmailParams {
  to: string;
  templateId: string;
  mergeData: Record<string, unknown>;
  internshipId?: string | null;
}

export async function sendTemplatedEmail(params: SendTemplatedEmailParams) {
  const { to, templateId, mergeData, internshipId } = params;
  const result = await emailAdapter.send(to, templateId, mergeData);
  return prisma.notificationLog.create({
    data: {
      templateId,
      recipient: to,
      status: result.status,
      providerId: result.providerId,
      internshipId: internshipId ?? null,
    },
  });
}
