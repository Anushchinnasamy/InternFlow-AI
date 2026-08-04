// Per CLAUDE.md rule 6 — Active Directory is never called inline from a
// route. Everything that needs to provision or deactivate an AD account
// goes through this interface, so swapping the manual mock for a real
// Graph API adapter later is a config change, not a rewrite of every caller.

import { randomUUID } from "crypto";

export interface ADCandidateRef {
  fullName: string;
  email: string;
}

export interface ADAdapter {
  provision(candidate: ADCandidateRef, nonWorkerId: string): Promise<{ accountRef: string }>;
  deactivate(accountRef: string): Promise<void>;
}

// Mock implementation: there is no real directory behind this yet.
// provision() fabricates a tracking ref and relies on the AD_PROVISION task
// (completed via POST /internships/:id/ad-provision) for the human step a
// real Graph API call would otherwise perform. deactivate() is a no-op
// stand-in — Day 6 wires it into the closure/deactivation flow.
export class ManualADAdapter implements ADAdapter {
  async provision(candidate: ADCandidateRef, nonWorkerId: string): Promise<{ accountRef: string }> {
    void candidate;
    return { accountRef: `manual-ad-${nonWorkerId}-${randomUUID()}` };
  }

  async deactivate(_accountRef: string): Promise<void> {
    return;
  }
}

export const adAdapter: ADAdapter = new ManualADAdapter();
