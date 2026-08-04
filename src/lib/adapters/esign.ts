// Per CLAUDE.md rule 6 — external e-sign providers (DocuSign, Adobe Sign,
// ...) are never called inline from a route. Everything that needs to send
// a document out for signature goes through this interface, so swapping the
// manual mock for a real provider later is a config change, not a rewrite
// of every caller.

import { randomUUID } from "crypto";

export interface EsignDocumentRef {
  documentId: string;
  internshipId: string;
  sha256: string;
}

export type EsignStatus = "pending" | "signed" | "declined";

export interface ESignAdapter {
  issue(document: EsignDocumentRef, signerEmail: string): Promise<{ providerRef: string }>;
  checkStatus(providerRef: string): Promise<EsignStatus>;
}

// Mock implementation: there is no real provider behind this yet, so
// issue() just fabricates a tracking ref for the document handed to it.
// checkStatus() exists to satisfy the interface (a real adapter would poll
// the provider's API) but is unused for now — signing happens synchronously
// via POST /internships/:id/nda/sign instead of an async provider callback.
export class ManualESignAdapter implements ESignAdapter {
  async issue(document: EsignDocumentRef, signerEmail: string): Promise<{ providerRef: string }> {
    void signerEmail;
    return { providerRef: `manual-${document.documentId}-${randomUUID()}` };
  }

  async checkStatus(_providerRef: string): Promise<EsignStatus> {
    return "pending";
  }
}

export const esignAdapter: ESignAdapter = new ManualESignAdapter();
