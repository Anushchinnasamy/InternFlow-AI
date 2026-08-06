// Pure-function unit tests for the exit checklist's auto-flip logic — no DB,
// no fixtures, since buildExitChecklist() only ever touches the two fields
// it's given plus whatever checklist JSON was already persisted.
import { describe, it, expect } from "vitest";
import { buildExitChecklist } from "../src/lib/exitChecklist";

const NEITHER = { mentorCompletionConfirmedAt: null, certificateRequestedAt: null };
const BOTH = { mentorCompletionConfirmedAt: new Date(), certificateRequestedAt: new Date() };

describe("buildExitChecklist", () => {
  it("initializes all 4 manual items to pending and both auto items to pending when neither trigger has fired", () => {
    const result = buildExitChecklist(NEITHER);
    expect(result).toEqual({
      assetReturn: "pending",
      emailVpnDeprovision: "pending",
      repositoryRevoke: "pending",
      exitInterviewScheduled: "pending",
      finalFeedbackSubmitted: "pending",
      certificateRequestRaised: "pending",
    });
  });

  it("flips both auto items to provisioned once both triggers have fired, at creation time (no persisted checklist yet)", () => {
    const result = buildExitChecklist(BOTH);
    expect(result.finalFeedbackSubmitted).toBe("provisioned");
    expect(result.certificateRequestRaised).toBe("provisioned");
  });

  it("re-derives the auto items at read time even when the persisted checklist still says pending", () => {
    // Simulates a task created before mentor-confirm-completion / the
    // certificate request happened — the stored JSON still has "pending"
    // for both, but the internship's real state has since moved on.
    const persisted = {
      assetReturn: "pending",
      emailVpnDeprovision: "pending",
      repositoryRevoke: "pending",
      exitInterviewScheduled: "pending",
      finalFeedbackSubmitted: "pending",
      certificateRequestRaised: "pending",
    };
    const result = buildExitChecklist(BOTH, persisted);
    expect(result.finalFeedbackSubmitted).toBe("provisioned");
    expect(result.certificateRequestRaised).toBe("provisioned");
  });

  it("preserves a manually-ticked item from the persisted checklist rather than resetting it to pending", () => {
    const persisted = { assetReturn: "provisioned" };
    const result = buildExitChecklist(NEITHER, persisted);
    expect(result.assetReturn).toBe("provisioned");
    expect(result.emailVpnDeprovision).toBe("pending");
  });

  it("never lets the auto items be overridden by a manually-set value in the persisted checklist", () => {
    // Not reachable through the real API (tasks.ts rejects a manual write
    // to these two items), but the derivation itself must still win if
    // stale/bad data ever ends up in the column.
    const persisted = { finalFeedbackSubmitted: "provisioned", certificateRequestRaised: "provisioned" };
    const result = buildExitChecklist(NEITHER, persisted);
    expect(result.finalFeedbackSubmitted).toBe("pending");
    expect(result.certificateRequestRaised).toBe("pending");
  });
});
