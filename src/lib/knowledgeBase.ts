// Day 7 chatbot knowledge base. Small enough to pass as full context on
// every call — no vector DB / retrieval step needed. This is the ONLY
// context the chatbot ever sees: the CHATBOT_ANSWER prompt in lib/ai/index.ts
// is grounded exclusively in this text and is given no Prisma access to
// Candidate/JoiningRecord, so "the bot doesn't know your government ID" is a
// structural guarantee, not just an instruction it could be talked out of.
//
// TODO: move to a DB-backed config table (same as email templates, FR-37)
// once a content-editing UI exists for HR/Legal to keep this current.
export const KNOWLEDGE_BASE = `
# Intern Flow FAQ

## What is Intern Flow?
Intern Flow is the internal system that manages the full lifecycle of an
unpaid internship: referral, mentor confirmation, HR approval, joining
paperwork, Non-Worker ID issuance, NDA signature, IT/site access
provisioning, the internship itself, and closure with a completion
certificate. Every step is tracked, every status change is auditable, and
nothing about pay or employment is implied — internships coordinated through
this system are unpaid and create no employment relationship.

## How do I submit a referral?
A Referrer (or HR, on a candidate's behalf) submits a referral with the
candidate's details, the proposed mentor, the project title and overview,
the proposed start/end dates, the site, and the department. Submitting a
referral requires three consents: unpaid consent, in-person readiness, and
location alignment — all three must be affirmed or the referral cannot be
submitted. Once submitted, the referral goes to the named mentor for
confirmation.

## What does "unpaid consent" mean?
It's the referrer and candidate's explicit acknowledgment that the
internship is unpaid — no salary, wages, or employee benefits are provided,
and no employment relationship is created by participating. A referral
cannot be submitted without this being affirmed.

## When does the NDA need to be signed?
The Non-Disclosure Agreement must be signed at least 1 full day before the
internship's start date. This is enforced by the system itself: the
internship cannot move past the NDA-signed stage if the signature comes in
less than a day before the start date, no matter who tries to advance it.

## How long does each stage take?
These are the target service-level timelines:
- Mentor confirmation: 2 business days
- HR screening/review: 3 business days
- Joining form completion: 5 calendar days
- Non-Worker ID issuance: 1 business day
- NDA signature: must be at least 1 day before the start date
- AD (system access) provisioning: 2 business days
- AD deactivation after the internship ends: within 24 hours

## Who do I contact at each stage?
- Referral submitted, awaiting mentor confirmation: the named Mentor
- Referral in HR review: HR
- Joining form issued/incomplete: the Candidate (with HR available to help)
- Non-Worker ID / NDA / access provisioning: HR and IT Admin
- Site access / badge: Admin Security
- During the internship (check-ins, extensions, delays): the Mentor
- Closure and certificate requests: HR
- Anything about pay, employment status, or a decision you disagree with:
  Program Owner

## How do I confirm a referral (as a Mentor)?
Go to the Candidates page — a "Pending Your Confirmation" section lists every
referral naming you as mentor that's still awaiting your decision. Each row
has a Confirm and a Decline button. Confirming moves the referral into HR
review immediately. Declining requires a short reason, which is shared with
the referrer.

## Can I extend an internship?
Yes — the Mentor can request an extension with a new proposed end date and a
justification. An extension only takes effect once BOTH HR and the Program
Owner have separately approved it; one approval alone is not enough.

## What happens if I can't start on time?
If the start date passes without a start confirmation, the internship is
marked delayed and HR follows up. This does not automatically cancel
anything — talk to your mentor or HR as soon as possible.

## How do I get my completion certificate?
After the internship is marked complete, your mentor records a completion
confirmation. Once that's in place, you can request your certificate; HR
reviews and approves the request, and the certificate is then generated and
emailed to you with a unique reference number.
`.trim();
