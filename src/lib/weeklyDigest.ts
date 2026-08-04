// T24 weekly digest — a separate node-cron schedule from the SLA sweep
// (src/index.ts) since a once-a-week summary doesn't belong on a
// every-few-minutes cadence. Exported standalone for manual/verification runs.

import { Role } from "@prisma/client";
import { prisma } from "./prisma";
import { sendTemplatedEmail } from "./notifications";

export interface WeeklyDigestResult {
  recipientCount: number;
  openTaskCount: number;
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
  upcomingClosuresCount: number;
}

export async function runWeeklyDigest(): Promise<WeeklyDigestResult> {
  const now = new Date();
  const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 3600 * 1000);

  const [openTaskCount, tier1Count, tier2Count, tier3Count, upcomingClosuresCount, recipients] = await Promise.all([
    prisma.task.count({ where: { completedAt: null } }),
    prisma.task.count({ where: { completedAt: null, escalationTier: 1 } }),
    prisma.task.count({ where: { completedAt: null, escalationTier: 2 } }),
    prisma.task.count({ where: { completedAt: null, escalationTier: 3 } }),
    prisma.internship.count({
      where: { status: "ACTIVE", actualEnd: { gte: now, lte: sevenDaysOut } },
    }),
    prisma.user.findMany({ where: { role: { in: [Role.HR, Role.PROGRAM_OWNER] }, active: true } }),
  ]);

  const weekOf = now.toISOString().slice(0, 10);
  await Promise.all(
    recipients.map((u) =>
      sendTemplatedEmail({
        to: u.email,
        templateId: "T24_WEEKLY_DIGEST",
        mergeData: {
          recipientName: u.name,
          weekOf,
          openTaskCount,
          tier1Count,
          tier2Count,
          tier3Count,
          upcomingClosuresCount,
        },
      })
    )
  );

  return { recipientCount: recipients.length, openTaskCount, tier1Count, tier2Count, tier3Count, upcomingClosuresCount };
}
