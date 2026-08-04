// Per CLAUDE.md rule 6 — the email provider is never called inline from a
// route. Every send goes through this interface so swapping providers is a
// config change, not a rewrite of every caller.

import { randomUUID } from "crypto";
import { Resend } from "resend";
import { renderTemplate } from "../emailTemplates";

export interface EmailSendResult {
  providerId: string;
  status: "sent" | "failed";
}

export interface EmailAdapter {
  send(to: string, templateId: string, mergeData: Record<string, unknown>): Promise<EmailSendResult>;
  // Day 6 EMAIL_DRAFT: an AI-drafted (or human-edited) subject/body doesn't
  // come from the fixed template catalogue, so it can't go through
  // renderTemplate() — this is the one path that sends arbitrary content,
  // used only by POST /notifications/draft/:id/approve-and-send.
  sendRaw(to: string, subject: string, body: string): Promise<EmailSendResult>;
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "Intern Flow <onboarding@resend.dev>";

export class ResendEmailAdapter implements EmailAdapter {
  private client: Resend;

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(to: string, templateId: string, mergeData: Record<string, unknown>): Promise<EmailSendResult> {
    const { subject, body } = renderTemplate(templateId, mergeData);
    return this.sendRaw(to, subject, body);
  }

  async sendRaw(to: string, subject: string, body: string): Promise<EmailSendResult> {
    try {
      const result = await this.client.emails.send({ from: RESEND_FROM_EMAIL, to, subject, text: body });
      if (result.error || !result.data) {
        return { providerId: `resend-failed-${randomUUID()}`, status: "failed" };
      }
      return { providerId: result.data.id, status: "sent" };
    } catch {
      return { providerId: `resend-error-${randomUUID()}`, status: "failed" };
    }
  }
}

// Mock implementation — no real provider key configured in this environment
// (same situation as Day 4/5's ESignAdapter/ADAdapter). Logs to console and
// fabricates a tracking id so NotificationLog persistence and the delivery
// webhook still work end-to-end without a live email account.
export class ManualEmailAdapter implements EmailAdapter {
  async send(to: string, templateId: string, mergeData: Record<string, unknown>): Promise<EmailSendResult> {
    const { subject, body } = renderTemplate(templateId, mergeData);
    return this.sendRaw(to, subject, body, templateId);
  }

  async sendRaw(to: string, subject: string, body: string, templateId = "AD_HOC"): Promise<EmailSendResult> {
    const providerId = `manual-email-${randomUUID()}`;
    console.log(`[ManualEmailAdapter] -> ${to} | ${templateId} | ${subject}\n${body}\n(providerId=${providerId})`);
    return { providerId, status: "sent" };
  }
}

export const emailAdapter: EmailAdapter = RESEND_API_KEY ? new ResendEmailAdapter(RESEND_API_KEY) : new ManualEmailAdapter();
