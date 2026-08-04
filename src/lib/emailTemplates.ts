// Day 6 email template catalogue — T01 through T24, matching the spec's
// lifecycle-event list 1:1 in order.
//
// TODO: move to a DB-backed config table per FR-37 once a template-editing
// UI exists. Hardcoded here for now, same as every other "no admin UI yet"
// piece of this backend.
//
// {{mergeField}} placeholders are substituted by renderTemplate() below —
// an unmatched placeholder is left as-is rather than silently blanked, so a
// caller that forgot a merge field notices it in the rendered output.

export interface EmailTemplate {
  subject: string;
  body: string;
}

export const EMAIL_TEMPLATES = {
  T01_REFERRAL_RECEIVED: {
    subject: "We've received your referral for {{candidateName}}",
    body:
      "Hi {{referrerName}},\n\nThanks for referring {{candidateName}} for the \"{{projectTitle}}\" internship. " +
      "Your referral has been submitted and is now awaiting mentor confirmation.\n\n— Intern Flow",
  },
  T02_MENTOR_CONFIRM_REQUEST: {
    subject: "Action needed: confirm mentorship for {{candidateName}}",
    body:
      "Hi {{mentorName}},\n\n{{referrerName}} has referred {{candidateName}} for the \"{{projectTitle}}\" internship " +
      "and named you as mentor. Please confirm or decline within 2 business days.\n\n— Intern Flow",
  },
  T03_HR_PENDING_REMINDER: {
    subject: "Reminder: referral for {{candidateName}} awaiting HR review",
    body: "Hi {{hrName}},\n\nThe referral for {{candidateName}} has been in HR review since {{createdAt}} and is nearing its SLA. Please review.\n\n— Intern Flow",
  },
  T04_REFERRAL_APPROVED: {
    subject: "Your referral for {{candidateName}} was approved",
    body: "Hi {{referrerName}},\n\nGood news — HR has approved your referral for {{candidateName}}. The joining process is now underway.\n\n— Intern Flow",
  },
  T05_CONGRATULATIONS: {
    subject: "Congratulations, {{candidateName}}!",
    body:
      "Hi {{candidateName}},\n\nCongratulations — your internship for \"{{projectTitle}}\" has been approved. " +
      "You'll receive a joining form shortly to complete the next steps.\n\n— Intern Flow",
  },
  T06_JOINING_FORM_ISSUED: {
    subject: "Please complete your joining form",
    body: "Hi {{candidateName}},\n\nPlease complete your joining form to continue onboarding for \"{{projectTitle}}\". Log in to Intern Flow to get started.\n\n— Intern Flow",
  },
  T07_JOINING_FORM_REMINDER: {
    subject: "Reminder: your joining form is still incomplete",
    body: "Hi {{candidateName}},\n\nYour joining form for \"{{projectTitle}}\" is still incomplete. Please finish it as soon as possible to avoid delaying your start date.\n\n— Intern Flow",
  },
  T08_RETURNED_FOR_CORRECTION: {
    subject: "Action needed: corrections requested on your submission",
    body:
      "Hi {{recipientName}},\n\n{{reviewerRole}} has requested corrections to the following field(s): {{correctionFields}}.\n" +
      "Reason: {{reason}}\n\nPlease update and resubmit.\n\n— Intern Flow",
  },
  T09_NDA_FOR_SIGNATURE: {
    subject: "Please sign your NDA — action required",
    body:
      "Hi {{candidateName}},\n\nYour Non-Disclosure Agreement for \"{{projectTitle}}\" is ready to sign. " +
      "It must be signed at least 1 day before your start date ({{startDate}}). Please sign it as soon as possible.\n\n— Intern Flow",
  },
  T10_NDA_SIGNED_CONFIRMATION: {
    subject: "Your NDA has been signed",
    body: "Hi {{candidateName}},\n\nWe've received your signed NDA for \"{{projectTitle}}\" (signed {{signedAt}}). No further action is needed on this step.\n\n— Intern Flow",
  },
  // FR-13: link only — never the OTP/password itself, per the non-negotiable
  // "never plain-text in email body" rule.
  T11_CREDENTIAL_DELIVERY_NOTICE: {
    subject: "Your account credentials are ready",
    body:
      "Hi {{candidateName}},\n\nYour system access has been provisioned. Retrieve your login credentials securely here:\n" +
      "{{redeemLink}}\n\nThis link is single-use and expires in 24 hours.\n\n— Intern Flow",
  },
  T12_SITE_ACCESS_NOTIFICATION: {
    subject: "Your site access badge is ready",
    body: "Hi {{candidateName}},\n\nYour site access badge ({{badgeNumber}}) has been issued for zones: {{accessZones}}. Please collect it before your start date.\n\n— Intern Flow",
  },
  T13_MENTOR_DOSSIER_NOTICE: {
    subject: "Intern dossier available for {{candidateName}}",
    body: "Hi {{mentorName}},\n\n{{candidateName}} is ready to start on \"{{projectTitle}}\" ({{startDate}}). Their intern dossier is now available in Intern Flow.\n\n— Intern Flow",
  },
  T14_MUTUAL_CONNECT_PROMPT: {
    subject: "Time to connect before {{startDate}}",
    body: "Hi {{recipientName}},\n\n{{startDate}} is approaching — please reach out to {{otherPartyName}} to introduce yourselves ahead of the start date.\n\n— Intern Flow",
  },
  T15_START_CONFIRMATION: {
    subject: "{{candidateName}}'s internship has started",
    body: "Hi {{recipientName}},\n\nThis confirms {{candidateName}}'s internship on \"{{projectTitle}}\" officially started on {{actualStart}}.\n\n— Intern Flow",
  },
  T16_DELAY_NOTIFICATION: {
    subject: "Internship start delayed for {{candidateName}}",
    body: "Hi {{recipientName}},\n\n{{candidateName}}'s internship start ({{startDate}}) has passed without a start confirmation. Status has been marked DELAYED pending follow-up.\n\n— Intern Flow",
  },
  T17_CHECKIN_PROMPT: {
    subject: "Time for a check-in with {{candidateName}}",
    body: "Hi {{mentorName}},\n\nIt's a good time for a periodic check-in with {{candidateName}} on \"{{projectTitle}}\". Please log any notes in Intern Flow.\n\n— Intern Flow",
  },
  T18_EXTENSION_OUTCOME: {
    subject: "Extension request {{outcome}} for {{candidateName}}",
    body: "Hi {{recipientName}},\n\nThe extension request for {{candidateName}} (new end date requested: {{requestedEndDate}}) was {{outcome}}.\n\n— Intern Flow",
  },
  T19_CLOSURE_REMINDER: {
    subject: "{{candidateName}}'s internship ends {{actualEnd}}",
    body: "Hi {{recipientName}},\n\n{{candidateName}}'s internship on \"{{projectTitle}}\" ends on {{actualEnd}}. Please plan closure steps (final check-in, handover, closure sign-off).\n\n— Intern Flow",
  },
  T20_CERTIFICATE_REQUEST_AVAILABLE: {
    subject: "You can now request your completion certificate",
    body: "Hi {{candidateName}},\n\nYour internship on \"{{projectTitle}}\" is now marked complete. Once your mentor confirms completion, you can request your certificate in Intern Flow.\n\n— Intern Flow",
  },
  T21_CERTIFICATE_ISSUED: {
    subject: "Your internship certificate is ready",
    body: "Hi {{candidateName}},\n\nYour completion certificate ({{referenceNumber}}) for \"{{projectTitle}}\" has been issued. You can download it from Intern Flow.\n\n— Intern Flow",
  },
  T22_REJECTION_DECLINE: {
    subject: "Update on {{candidateName}}'s referral",
    body: "Hi {{recipientName}},\n\nThe referral for {{candidateName}} was {{decisionWord}}.\nReason: {{reason}}\n\n— Intern Flow",
  },
  T23_SLA_BREACH_ESCALATION: {
    subject: "[SLA Tier {{escalationTier}}] {{taskType}} overdue for {{candidateName}}",
    body:
      "A {{taskType}} task for {{candidateName}} has breached its SLA (due {{dueAt}}).\n" +
      "Risk note: {{riskNote}}\nRecommended action: {{recommendedAction}}\n\n— Intern Flow SLA Sweep",
  },
  T24_WEEKLY_DIGEST: {
    subject: "Intern Flow weekly digest — {{weekOf}}",
    body:
      "Hi {{recipientName}},\n\nThis week: {{openTaskCount}} open tasks ({{tier1Count}} tier-1, {{tier2Count}} tier-2, " +
      "{{tier3Count}} tier-3), {{upcomingClosuresCount}} internships closing in the next 7 days.\n\n— Intern Flow",
  },
} as const satisfies Record<string, EmailTemplate>;

export type EmailTemplateId = keyof typeof EMAIL_TEMPLATES;

export function renderTemplate(templateId: string, mergeData: Record<string, unknown>): EmailTemplate {
  const template = (EMAIL_TEMPLATES as Record<string, EmailTemplate>)[templateId];
  if (!template) {
    throw new Error(`Unknown email template: ${templateId}`);
  }
  const substitute = (text: string) =>
    text.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
      mergeData[key] !== undefined && mergeData[key] !== null ? String(mergeData[key]) : match
    );
  return { subject: substitute(template.subject), body: substitute(template.body) };
}
