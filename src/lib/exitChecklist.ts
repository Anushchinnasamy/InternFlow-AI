import { Internship } from "@prisma/client";

// Frontend Day F5 Closure page's Exit Checklist. assetReturn/
// emailVpnDeprovision/repositoryRevoke/exitInterviewScheduled are ticked
// manually via PATCH /tasks/:id/checklist; finalFeedbackSubmitted and
// certificateRequestRaised are never manually ticked (tasks.ts rejects it) —
// they're derived here from real Internship state both at task-creation time
// (POST /internships/:id/close) and at read time (GET /internships), so a
// checklist that was created before mentor-confirm-completion or a
// certificate request still shows the right value once those happen,
// without a second write.
export const EXIT_CHECKLIST_MANUAL_ITEMS = ["assetReturn", "emailVpnDeprovision", "repositoryRevoke", "exitInterviewScheduled"] as const;

export function buildExitChecklist(
  internship: Pick<Internship, "mentorCompletionConfirmedAt" | "certificateRequestedAt">,
  persisted?: unknown
): Record<string, string> {
  const base: Record<string, string> = { ...((persisted as Record<string, string> | null) ?? {}) };
  for (const item of EXIT_CHECKLIST_MANUAL_ITEMS) {
    if (!base[item]) base[item] = "pending";
  }
  base.finalFeedbackSubmitted = internship.mentorCompletionConfirmedAt ? "provisioned" : "pending";
  base.certificateRequestRaised = internship.certificateRequestedAt ? "provisioned" : "pending";
  return base;
}
