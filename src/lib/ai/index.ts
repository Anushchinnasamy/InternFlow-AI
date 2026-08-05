// All 10 AI actions are real (RESUME_PARSE, FORM_PREFILL, CONFIDENCE_SCORE,
// EMAIL_DRAFT, SLA_RISK_PREDICTION, CHATBOT_ANSWER, MATCH_SCORE via Google
// Gemini structured outputs; DUPLICATE_DETECTION, MISSING_INFO_CHECK,
// SMART_VALIDATION via rule-based logic):
//
//   1. resumeParse          -> RESUME_PARSE          [real, LLM]
//   2. formPrefill          -> FORM_PREFILL          [real, LLM]
//   3. confidenceScore      -> CONFIDENCE_SCORE      [real, LLM]
//   4. duplicateDetection   -> DUPLICATE_DETECTION   [real, rule-engine]
//   5. missingInfoCheck     -> MISSING_INFO_CHECK    [real, rule-engine]
//   6. smartValidation      -> SMART_VALIDATION      [real, rule-engine]
//   7. emailDraft           -> EMAIL_DRAFT           [real, LLM — Day 6]
//   8. slaRiskPrediction    -> SLA_RISK_PREDICTION   [real, LLM — Day 6]
//   9. chatbotAnswer        -> CHATBOT_ANSWER        [real, LLM — Day 7]
//  10. matchScore           -> MATCH_SCORE           [real, LLM — post-Day-7 add-on]
//
// Every function still calls logAiAction() no matter which category it's
// in — that hook is what lets HR see and override every AI decision later.

// Schemas passed to generateStructured() need the "zod/v3" compatibility
// import — see the comment in geminiStructured.ts.
import { z } from "zod/v3";
import { AiActionType } from "@prisma/client";
import { AI_MODEL } from "../geminiClient";
import { generateStructured } from "../geminiStructured";
import { logAiAction } from "../logAiAction";
import { prisma } from "../prisma";
import { nameSimilarity } from "../similarity";
import { KNOWLEDGE_BASE } from "../knowledgeBase";

const RULE_ENGINE = "rule-engine";

// ---------------------------------------------------------------------------
// 1-3: real LLM-backed actions
// ---------------------------------------------------------------------------

const ResumeParseSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  education: z.array(z.string()),
  skills: z.array(z.string()),
});
export type ResumeParseOutput = z.infer<typeof ResumeParseSchema>;

export async function resumeParse(input: {
  resumeText: string;
  entityId?: string;
  actorId?: string | null;
}): Promise<ResumeParseOutput> {
  const output = await generateStructured(
    ResumeParseSchema,
    "Extract structured fields from this resume text. Use null for scalar fields that " +
      "are not present, and an empty array for list fields with no entries. Do not fabricate " +
      "information that isn't in the text.\n\nResume text:\n" +
      input.resumeText
  );

  await logAiAction({
    type: AiActionType.RESUME_PARSE,
    entity: "Candidate",
    entityId: input.entityId,
    input: { resumeText: input.resumeText.slice(0, 5000) },
    output,
    modelUsed: AI_MODEL,
    actorId: input.actorId,
  });

  return output;
}

const FormPrefillSchema = z.object({
  fullName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  qualification: z.string().nullable(),
  institution: z.string().nullable(),
  skills: z.array(z.string()),
});
export type FormPrefillOutput = z.infer<typeof FormPrefillSchema>;

// Returns the created AiAction's id (like emailDraft below) — Referral
// Intake needs it to call PATCH /referrals/:id/override when a user edits
// an AI-prefilled field, once the referral exists to override against.
export async function formPrefill(input: {
  parsed: ResumeParseOutput;
  entityId?: string;
  actorId?: string | null;
}): Promise<FormPrefillOutput & { aiActionId: string }> {
  const output = await generateStructured(
    FormPrefillSchema,
    "Map these parsed resume fields onto a candidate intake form. `education` entries may " +
      "combine a qualification, institution, and year in one string (e.g. " +
      '"B.Tech Computer Science, XYZ University, 2022") — split the most recent/highest entry ' +
      "into `qualification` and `institution`. Deduplicate skills. Use null where a value " +
      "can't be determined.\n\nParsed resume fields:\n" +
      JSON.stringify(input.parsed, null, 2)
  );

  const created = await logAiAction({
    type: AiActionType.FORM_PREFILL,
    entity: "Referral",
    entityId: input.entityId,
    input: input.parsed,
    output,
    modelUsed: AI_MODEL,
    actorId: input.actorId,
  });

  return { ...output, aiActionId: created.id };
}

const ConfidenceScoreSchema = z.object({
  name: z.number(),
  email: z.number(),
  phone: z.number(),
  education: z.number(),
  skills: z.number(),
});
export type ConfidenceScoreOutput = z.infer<typeof ConfidenceScoreSchema>;

export async function confidenceScore(input: {
  resumeText: string;
  parsed: ResumeParseOutput;
  entityId?: string;
  actorId?: string | null;
}): Promise<ConfidenceScoreOutput> {
  const scores = await generateStructured(
    ConfidenceScoreSchema,
    "For each of these 5 extracted fields (name, email, phone, education, skills), give a " +
      "confidence score from 0 to 1 for how clearly and unambiguously that field was stated in " +
      "the source resume text. A field that is null or empty because it was genuinely absent " +
      "from the text should score low (e.g. 0.1), not high.\n\nSource resume text:\n" +
      input.resumeText +
      "\n\nExtracted fields:\n" +
      JSON.stringify(input.parsed, null, 2)
  );

  const clamped = Object.fromEntries(
    Object.entries(scores).map(([k, v]) => [k, Math.max(0, Math.min(1, v))])
  ) as ConfidenceScoreOutput;
  const average = Object.values(clamped).reduce((sum, v) => sum + v, 0) / Object.values(clamped).length;

  await logAiAction({
    type: AiActionType.CONFIDENCE_SCORE,
    entity: "Candidate",
    entityId: input.entityId,
    input: input.parsed,
    output: clamped,
    confidence: average,
    modelUsed: AI_MODEL,
    actorId: input.actorId,
  });

  return clamped;
}

// ---------------------------------------------------------------------------
// 4-6: real rule-engine actions
// ---------------------------------------------------------------------------

export interface DuplicateMatch {
  candidateId: string;
  fullName: string;
  similarity: number;
}
export interface DuplicateDetectionOutput {
  isDuplicate: boolean;
  duplicateCandidateId: string | null;
  possibleDuplicate: boolean;
  matches: DuplicateMatch[];
}

const FUZZY_NAME_SIMILARITY_THRESHOLD = 0.82;

export async function duplicateDetection(input: {
  email: string;
  phone: string;
  fullName: string;
  dob: Date;
  entityId?: string;
  actorId?: string | null;
}): Promise<DuplicateDetectionOutput> {
  const exactMatch = await prisma.candidate.findFirst({
    where: { OR: [{ email: input.email }, { phone: input.phone }] },
  });

  let output: DuplicateDetectionOutput;

  if (exactMatch) {
    output = {
      isDuplicate: true,
      duplicateCandidateId: exactMatch.id,
      possibleDuplicate: false,
      matches: [{ candidateId: exactMatch.id, fullName: exactMatch.fullName, similarity: 1 }],
    };
  } else {
    const sameDob = await prisma.candidate.findMany({ where: { dob: input.dob } });
    const matches: DuplicateMatch[] = sameDob
      .map((c) => ({ candidateId: c.id, fullName: c.fullName, similarity: nameSimilarity(c.fullName, input.fullName) }))
      .filter((m) => m.similarity >= FUZZY_NAME_SIMILARITY_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity);

    output = {
      isDuplicate: false,
      duplicateCandidateId: null,
      possibleDuplicate: matches.length > 0,
      matches,
    };
  }

  await logAiAction({
    type: AiActionType.DUPLICATE_DETECTION,
    entity: "Candidate",
    entityId: input.entityId,
    input: { email: input.email, phone: input.phone, fullName: input.fullName, dob: input.dob },
    output,
    modelUsed: RULE_ENGINE,
    actorId: input.actorId,
  });

  return output;
}

export interface MissingInfoOutput {
  missingFields: string[];
}

const CORE_FIELDS = ["name", "email", "phone", "education", "skills"] as const;
const LOW_CONFIDENCE_THRESHOLD = 0.5;

export async function missingInfoCheck(input: {
  parsed: ResumeParseOutput;
  confidence?: ConfidenceScoreOutput;
  entityId?: string;
  actorId?: string | null;
}): Promise<MissingInfoOutput> {
  const missingFields: string[] = [];

  for (const field of CORE_FIELDS) {
    const value = input.parsed[field];
    const isEmpty = Array.isArray(value) ? value.length === 0 : value === null || value === "";
    const isLowConfidence = input.confidence ? input.confidence[field] < LOW_CONFIDENCE_THRESHOLD : false;
    if (isEmpty || isLowConfidence) {
      missingFields.push(field);
    }
  }

  const output: MissingInfoOutput = { missingFields };

  await logAiAction({
    type: AiActionType.MISSING_INFO_CHECK,
    entity: "Candidate",
    entityId: input.entityId,
    input: { parsed: input.parsed, confidence: input.confidence },
    output,
    modelUsed: RULE_ENGINE,
    actorId: input.actorId,
  });

  return output;
}

export interface SmartValidationOutput {
  hints: string[];
}

const YEAR_PATTERN = /\b(19|20)\d{2}\b/g;
const MIN_EDUCATION_AGE = 15;

export async function smartValidation(input: {
  educationEntries?: string[];
  dob?: Date;
  entityId?: string;
  actorId?: string | null;
}): Promise<SmartValidationOutput> {
  const hints: string[] = [];
  const currentYear = new Date().getFullYear();
  const years = (input.educationEntries ?? [])
    .flatMap((entry) => [...entry.matchAll(YEAR_PATTERN)].map((m) => parseInt(m[0], 10)));

  for (const year of years) {
    if (year > currentYear) {
      hints.push(`Education entry references year ${year}, which is in the future.`);
    }
    if (input.dob) {
      const ageAtYear = year - input.dob.getFullYear();
      if (ageAtYear < MIN_EDUCATION_AGE) {
        hints.push(`Education entry references year ${year}, before the candidate would have turned ${MIN_EDUCATION_AGE}.`);
      }
    }
  }

  const output: SmartValidationOutput = { hints };

  await logAiAction({
    type: AiActionType.SMART_VALIDATION,
    entity: "Candidate",
    entityId: input.entityId,
    input: { educationEntries: input.educationEntries, dob: input.dob },
    output,
    modelUsed: RULE_ENGINE,
    actorId: input.actorId,
  });

  return output;
}

// ---------------------------------------------------------------------------
// Day 3: same MISSING_INFO_CHECK / SMART_VALIDATION action types, new
// call-sites for joining-form data instead of resume data.
// ---------------------------------------------------------------------------

const JoiningFormMissingInfoSchema = z.object({
  missingFields: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type JoiningFormMissingInfoOutput = z.infer<typeof JoiningFormMissingInfoSchema>;

interface EducationEntryLike {
  institution?: unknown;
  qualification?: unknown;
  startYear?: unknown;
  endYear?: unknown;
}

export async function joiningFormMissingInfoCheck(input: {
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  govtIdType: string | null;
  govtIdProvided: boolean;
  educationHistory: EducationEntryLike[];
  employmentHistory: unknown[] | null;
  entityId?: string;
  actorId?: string | null;
}): Promise<JoiningFormMissingInfoOutput> {
  // Deliberately excludes govtIdNumber and dob — a presence/format check
  // doesn't need the LLM to see the actual government ID or date of birth.
  const redacted = {
    address: input.address,
    emergencyContactName: input.emergencyContactName,
    emergencyContactPhone: input.emergencyContactPhone,
    govtIdType: input.govtIdType,
    govtIdProvided: input.govtIdProvided,
    educationHistory: input.educationHistory,
    employmentHistory: input.employmentHistory,
  };

  const output = await generateStructured(
    JoiningFormMissingInfoSchema,
    "Review this joining-form submission for gaps the basic presence checks might miss — " +
      "e.g. an institution/employer name that looks truncated, a placeholder like 'N/A' or " +
      "'asdf', a single-character entry, or an address that's clearly incomplete. List any " +
      "top-level field names with such issues in `missingFields`, and a short human-readable " +
      "explanation for each in `warnings`. If everything looks fine, return empty arrays for " +
      "both — do not invent problems.\n\nJoining form data:\n" +
      JSON.stringify(redacted, null, 2)
  );

  await logAiAction({
    type: AiActionType.MISSING_INFO_CHECK,
    entity: "JoiningRecord",
    entityId: input.entityId,
    input: redacted,
    output,
    modelUsed: AI_MODEL,
    actorId: input.actorId,
  });

  return output;
}

export interface JoiningFormSmartValidationOutput {
  hints: string[];
}

export async function joiningFormSmartValidation(input: {
  joiningDob: Date | null;
  candidateDob: Date;
  emergencyContactPhone: string | null;
  candidatePhone: string;
  educationHistory: EducationEntryLike[];
  entityId?: string;
  actorId?: string | null;
}): Promise<JoiningFormSmartValidationOutput> {
  const hints: string[] = [];
  const currentYear = new Date().getFullYear();

  if (input.joiningDob) {
    const sameDay = input.joiningDob.toISOString().slice(0, 10) === input.candidateDob.toISOString().slice(0, 10);
    if (!sameDay) {
      hints.push("Joining form date of birth does not match the candidate's DOB on file from referral intake.");
    }
  }

  for (const entry of input.educationHistory) {
    const endYear = Number(entry.endYear);
    if (Number.isFinite(endYear) && endYear > currentYear) {
      hints.push(`Education entry references end year ${endYear}, which is in the future.`);
    }
  }

  if (input.emergencyContactPhone && input.emergencyContactPhone === input.candidatePhone) {
    hints.push("Emergency contact phone number is the same as the candidate's own phone number.");
  }

  const output: JoiningFormSmartValidationOutput = { hints };

  await logAiAction({
    type: AiActionType.SMART_VALIDATION,
    entity: "JoiningRecord",
    entityId: input.entityId,
    input: {
      joiningDob: input.joiningDob,
      candidateDob: input.candidateDob,
      emergencyContactPhone: input.emergencyContactPhone,
      educationHistory: input.educationHistory,
    },
    output,
    modelUsed: RULE_ENGINE,
    actorId: input.actorId,
  });

  return output;
}

// ---------------------------------------------------------------------------
// 7-8: Day 6, real LLM-backed actions
// ---------------------------------------------------------------------------

const EmailDraftSchema = z.object({
  subject: z.string(),
  body: z.string(),
});
export type EmailDraftOutput = z.infer<typeof EmailDraftSchema>;

// EMAIL_DRAFT is advisory only (CLAUDE.md AiAction comment) — this function
// never sends anything. POST /notifications/draft/:id/approve-and-send is
// the only path from a draft to an actual EmailAdapter.send() call. It
// needs the created AiAction's id back (unlike every other AI action here)
// so that later approve-and-send call can look the draft back up.
export async function emailDraft(input: {
  to: string;
  context: string;
  templateHint?: string;
  entityId?: string;
  internshipId?: string;
  actorId?: string | null;
}): Promise<EmailDraftOutput & { aiActionId: string }> {
  const output = await generateStructured(
    EmailDraftSchema,
    "Draft a professional, concise email for an internship-program audience (HR/Program Owner writing " +
      "to a candidate, mentor, or referrer) based on this context:\n\n" +
      input.context +
      (input.templateHint ? `\n\nIt serves a similar purpose to the "${input.templateHint}" template.` : "") +
      "\n\nWrite a subject line and a plain-text body (no markdown). A human will review and may edit " +
      "this before it's ever sent — do not fabricate specifics (names, dates) not present in the context."
  );

  const created = await logAiAction({
    type: AiActionType.EMAIL_DRAFT,
    entity: "Notification",
    entityId: input.entityId,
    input: { to: input.to, context: input.context, templateHint: input.templateHint, internshipId: input.internshipId },
    output,
    modelUsed: AI_MODEL,
    actorId: input.actorId,
  });

  return { ...output, aiActionId: created.id };
}

const SlaRiskSchema = z.object({
  riskNote: z.string(),
  recommendedAction: z.string(),
});
export type SlaRiskOutput = z.infer<typeof SlaRiskSchema>;

// Called by the SLA sweep (src/lib/slaSweep.ts) once a task crosses 75%
// elapsed. Advisory only — the sweep's own tier-escalation logic (not this
// function) is what actually notifies anyone.
export async function slaRiskPrediction(input: {
  taskId: string;
  taskType: string;
  elapsedPercent: number;
  candidateName?: string | null;
}): Promise<SlaRiskOutput> {
  const output = await generateStructured(
    SlaRiskSchema,
    `A "${input.taskType}" task is ${Math.round(input.elapsedPercent)}% of the way through its SLA window` +
      (input.candidateName ? ` (for candidate ${input.candidateName})` : "") +
      ". In 1-2 sentences, give a short risk note on why this kind of task commonly slips, and a short " +
      "recommended action the assignee should take right now to avoid breaching the SLA."
  );

  await logAiAction({
    type: AiActionType.SLA_RISK_PREDICTION,
    entity: "Task",
    entityId: input.taskId,
    input: { taskType: input.taskType, elapsedPercent: input.elapsedPercent },
    output,
    confidence: Math.min(1, input.elapsedPercent / 100),
    modelUsed: AI_MODEL,
  });

  return output;
}

// ---------------------------------------------------------------------------
// 9: Day 7, real
// ---------------------------------------------------------------------------

const ChatbotAnswerSchema = z.object({
  answer: z.string(),
  grounded: z.boolean(),
});
export type ChatbotAnswerOutput = z.infer<typeof ChatbotAnswerSchema>;

// Structural guarantee, not just a prompt instruction: this function is
// never given a Prisma client or any candidate/joining-record data — the
// only context it can possibly answer from is KNOWLEDGE_BASE. There is no
// query path here to leak PII through even if a prompt tried to talk it
// into one.
export async function chatbotAnswer(input: {
  entityId?: string;
  question: string;
  actorId?: string | null;
}): Promise<ChatbotAnswerOutput> {
  const output = await generateStructured(
    ChatbotAnswerSchema,
    "You are Intern Flow's FAQ assistant. Answer ONLY using the knowledge base below — never use outside " +
      "knowledge and never guess. You have no access to any candidate's personal data (name, ID, contact " +
      "info, application status) — if asked about a specific person or record, that is not in your " +
      "knowledge base either, so treat it the same as any other out-of-scope question. If the question " +
      "cannot be answered from the knowledge base, set grounded to false and say plainly in the answer " +
      "that you don't have that information, rather than guessing.\n\n" +
      `Knowledge base:\n${KNOWLEDGE_BASE}\n\nQuestion: ${input.question}`
  );

  await logAiAction({
    type: AiActionType.CHATBOT_ANSWER,
    entity: "Chatbot",
    entityId: input.entityId,
    input: { question: input.question },
    output,
    modelUsed: AI_MODEL,
    actorId: input.actorId,
  });

  return output;
}

// ---------------------------------------------------------------------------
// 10: match-scoring add-on, real — the 10th AI action
// ---------------------------------------------------------------------------

const MatchScoreSchema = z.object({
  matchScore: z.number().min(0).max(100),
  recommendation: z.enum(["HIRE", "MAYBE", "REJECT"]),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  aiSummary: z.string(),
});
export type MatchScoreOutput = z.infer<typeof MatchScoreSchema>;

// Advisory only, like every other action here — this never decides
// anything by itself. POST /evaluations/:id/decide is the one human-only
// path that actually moves a candidate forward, and it writes to a
// different column (Evaluation.decision) than what this function returns
// (Evaluation.recommendation), so overriding one can never silently
// overwrite the other.
export async function matchScore(input: {
  // Optional — absent for an ad-hoc Resume Analyzer run that isn't tied to
  // a persisted Candidate record (see POST /candidates/evaluate-adhoc).
  candidateId?: string;
  candidateProfile: Record<string, unknown>;
  jobDescription: string;
  actorId?: string | null;
}): Promise<MatchScoreOutput> {
  const output = await generateStructured(
    MatchScoreSchema,
    "Compare this candidate's profile against the job description below. Score the match from " +
      "0 to 100, give a recommendation (HIRE for a strong match, MAYBE for a partial or uncertain " +
      "match, REJECT for a poor match), list 2-5 concrete strengths and 2-5 concrete weaknesses or " +
      "gaps grounded in the profile, and a short 1-2 sentence summary. Do not fabricate experience, " +
      "skills, or qualifications the profile doesn't actually contain.\n\n" +
      `Candidate profile:\n${JSON.stringify(input.candidateProfile, null, 2)}\n\n` +
      `Job description:\n${input.jobDescription}`
  );

  const clampedScore = Math.max(0, Math.min(100, Math.round(output.matchScore)));

  await logAiAction({
    type: AiActionType.MATCH_SCORE,
    entity: "Candidate",
    entityId: input.candidateId ?? null,
    input: { candidateProfile: input.candidateProfile, jobDescription: input.jobDescription },
    output: { ...output, matchScore: clampedScore },
    confidence: clampedScore / 100,
    modelUsed: AI_MODEL,
    actorId: input.actorId,
  });

  return { ...output, matchScore: clampedScore };
}
