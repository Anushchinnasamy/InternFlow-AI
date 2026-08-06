import { Router } from "express";
import { z } from "zod";
import { Prisma, Role } from "@prisma/client";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX } from "../middleware/rbac";
import { withAudit } from "../lib/withAudit";
import { prisma } from "../lib/prisma";
import { duplicateDetection, matchScore, missingInfoCheck, smartValidation, resumeParse } from "../lib/ai";
import { canViewUnmaskedPii, maskJoiningRecord } from "../lib/pii";
import { findCandidateForUser, findActiveInternshipForCandidate } from "../lib/candidateContext";

const router = Router();

// Frontend Day F4 — self-scoped, like GET /me and GET /notifications/mine.
// A CANDIDATE has no other way to fetch their own profile/internship
// status: PERMISSION_MATRIX.candidate.view360 deliberately excludes
// CANDIDATE (it's the HR/mentor/referrer-facing dossier), and there was no
// "get my own record" endpoint at all before this. Needed for the
// Onboarding page's read-only Personal Details fields and progress
// tracker when the candidate is viewing their own form.
router.get("/me", authenticate, async (req, res) => {
  const candidate = await findCandidateForUser(req.user!.userId);
  if (!candidate) {
    res.json({ candidate: null, internship: null });
    return;
  }
  const internship = await findActiveInternshipForCandidate(candidate.id);
  res.json({ candidate, internship });
});

const createCandidateSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1),
  dob: z.coerce.date(),
  nationality: z.string().min(1),
  city: z.string().min(1),
  qualification: z.string().min(1),
  institution: z.string().min(1),
  skills: z.array(z.string()),
  linkedinUrl: z.string().url().optional(),
  confirmDuplicate: z.boolean().optional(),
});

router.post("/", authenticate, requireRole(...PERMISSION_MATRIX.candidate.create), async (req, res) => {
  const parsed = createCandidateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { confirmDuplicate, ...candidateInput } = parsed.data;

  const duplicateCheck = await duplicateDetection({
    email: candidateInput.email,
    phone: candidateInput.phone,
    fullName: candidateInput.fullName,
    dob: candidateInput.dob,
    actorId: req.user!.userId,
  });

  if (duplicateCheck.isDuplicate) {
    res.status(409).json({
      error: "A candidate with this email or phone already exists",
      existingCandidateId: duplicateCheck.duplicateCandidateId,
    });
    return;
  }

  if (duplicateCheck.possibleDuplicate && !confirmDuplicate) {
    res.status(200).json({
      status: "needs_confirmation",
      message: "Possible duplicate candidate found. Resubmit with confirmDuplicate: true to proceed.",
      matches: duplicateCheck.matches,
    });
    return;
  }

  const candidate = await withAudit(
    {
      actorId: req.user!.userId,
      role: req.user!.role,
      action: "CREATE",
      entity: "Candidate",
      entityId: (created) => created.id,
      after: candidateInput,
      ip: req.ip ?? null,
    },
    () => prisma.candidate.create({ data: candidateInput })
  );

  res.status(201).json({ candidate });
});

const precheckSchema = z.object({
  fullName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  dob: z.coerce.date().optional(),
  qualification: z.string().optional(),
  institution: z.string().optional(),
  skills: z.array(z.string()).optional(),
});

// Side-effect-free preview for Referral Intake's live "AI Duplicate Check"
// and "AI Eligibility Validation" side panels — runs the same
// duplicateDetection/missingInfoCheck/smartValidation functions POST /
// and the resume-parse pipeline use, but never creates a Candidate row.
// Debounce-friendly on the frontend since duplicateDetection/
// missingInfoCheck/smartValidation are all rule-engine (no LLM cost).
router.post("/precheck", authenticate, requireRole(...PERMISSION_MATRIX.candidate.precheck), async (req, res) => {
  const parsed = precheckSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { fullName, email, phone, dob, qualification, institution, skills } = parsed.data;
  const actorId = req.user!.userId;

  const duplicate =
    fullName && email && phone && dob
      ? await duplicateDetection({ email, phone, fullName, dob, actorId })
      : null;

  const educationEntries = [qualification, institution].filter((v): v is string => !!v);
  const missingInfo = await missingInfoCheck({
    parsed: {
      name: fullName ?? null,
      email: email ?? null,
      phone: phone ?? null,
      education: educationEntries,
      skills: skills ?? [],
    },
    actorId,
  });
  const validation = await smartValidation({ educationEntries, dob, actorId });

  res.json({ duplicate, missingInfo, validation });
});

router.get("/search", authenticate, requireRole(...PERMISSION_MATRIX.candidate.search), async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.status(400).json({ error: "Query parameter 'q' is required" });
    return;
  }

  const role = req.user!.role;

  // MENTOR/REFERRER are scoped to their own interns/referrals; HR and
  // PROGRAM_OWNER search across every candidate.
  let scopeFilter: Prisma.CandidateWhereInput = {};
  if (role === Role.MENTOR) {
    scopeFilter = { referrals: { some: { internship: { mentorId: req.user!.userId } } } };
  } else if (role === Role.REFERRER) {
    scopeFilter = { referrals: { some: { referrerId: req.user!.userId } } };
  }

  const textFilter: Prisma.CandidateWhereInput = {
    OR: [
      { fullName: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { phone: { contains: q } },
      { referrals: { some: { id: q } } },
      { referrals: { some: { internship: { nonWorkerId: { contains: q, mode: "insensitive" } } } } },
    ],
  };

  const candidates = await prisma.candidate.findMany({
    where: { AND: [textFilter, scopeFilter] },
    take: 25,
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      skills: true,
      referrals: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          projectTitle: true,
          status: true,
          internship: { select: { id: true, nonWorkerId: true, status: true, mentorId: true } },
        },
      },
      // Match % and Recommendation columns on the frontend's candidate
      // list — folded into this response so rendering the list doesn't
      // need a second round-trip per row.
      evaluations: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { matchScore: true, recommendation: true, decision: true },
      },
    },
  });

  res.json({
    results: candidates.map(({ evaluations, ...candidate }) => ({
      ...candidate,
      latestEvaluation: evaluations[0] ?? null,
    })),
  });
});

router.get("/:id/360", authenticate, requireRole(...PERMISSION_MATRIX.candidate.view360), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { id } = parsedParams.data;

  const candidate = await prisma.candidate.findUnique({
    where: { id },
    include: {
      referrals: {
        include: { internship: true, referrer: true, mentor: true },
        orderBy: { createdAt: "desc" },
      },
      joiningRecord: true,
    },
  });
  if (!candidate) {
    res.status(404).json({ error: "Candidate not found" });
    return;
  }

  const role = req.user!.role;
  if (role === Role.MENTOR) {
    const isMentor = candidate.referrals.some((r) => r.internship?.mentorId === req.user!.userId);
    if (!isMentor) {
      res.status(403).json({ error: "You are not the mentor for this candidate" });
      return;
    }
  } else if (role === Role.REFERRER) {
    const isReferrer = candidate.referrals.some((r) => r.referrerId === req.user!.userId);
    if (!isReferrer) {
      res.status(403).json({ error: "You did not refer this candidate" });
      return;
    }
  }
  // HR / PROGRAM_OWNER: unrestricted, per PERMISSION_MATRIX.candidate.view360.

  const internshipIds = candidate.referrals.map((r) => r.internship?.id).filter((x): x is string => !!x);
  const referralIds = candidate.referrals.map((r) => r.id);

  const [documents, tasks, statusHistory] = await Promise.all([
    prisma.document.findMany({ where: { internshipId: { in: internshipIds } }, orderBy: { createdAt: "desc" } }),
    prisma.task.findMany({ where: { internshipId: { in: internshipIds } }, orderBy: { createdAt: "desc" } }),
    // Internship status history — every status change goes through
    // transition(), which always writes an AuditEvent (rule 5 + rule 3), so
    // this is a complete history, not a best-effort log scrape.
    prisma.auditEvent.findMany({
      where: { entity: "Internship", entityId: { in: internshipIds }, action: "TRANSITION" },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // AI touchpoints ("show your work") are HR/PROGRAM_OWNER only — same
  // audience as PERMISSION_MATRIX.aiAction.read elsewhere, since this is the
  // same sensitive-review surface just scoped to one candidate.
  const aiActions =
    role === Role.HR || role === Role.PROGRAM_OWNER
      ? await prisma.aiAction.findMany({
          where: {
            OR: [
              { entity: "Candidate", entityId: candidate.id },
              { entity: "Referral", entityId: { in: referralIds } },
              { entity: "Internship", entityId: { in: internshipIds } },
              ...(candidate.joiningRecord ? [{ entity: "JoiningRecord", entityId: candidate.joiningRecord.id }] : []),
            ],
          },
          orderBy: { createdAt: "desc" },
        })
      : [];

  // Reuse the Day 3 masking function and its exact reveal contract (same
  // ?reveal=true + PII_REVEAL audit event as GET /joining-forms/:id) rather
  // than duplicating the govtIdNumber/dob rules here. MENTOR/REFERRER are
  // never in PII_UNMASKED_ROLES so this always comes back masked for them
  // regardless of the reveal flag.
  const reveal = req.query.reveal === "true";
  if (reveal && canViewUnmaskedPii(role) && candidate.joiningRecord) {
    await prisma.auditEvent.create({
      data: {
        actorId: req.user!.userId,
        role,
        action: "PII_REVEAL",
        entity: "JoiningRecord",
        entityId: candidate.joiningRecord.id,
        ip: req.ip ?? null,
      },
    });
  }
  const maskedJoiningRecord = candidate.joiningRecord ? maskJoiningRecord(candidate.joiningRecord, role, reveal) : null;

  res.json({
    candidate: {
      id: candidate.id,
      fullName: candidate.fullName,
      email: candidate.email,
      phone: candidate.phone,
      city: candidate.city,
      nationality: candidate.nationality,
      qualification: candidate.qualification,
      institution: candidate.institution,
      skills: candidate.skills,
    },
    referrals: candidate.referrals.map((r) => ({
      id: r.id,
      projectTitle: r.projectTitle,
      status: r.status,
      referrerName: r.referrer.name,
      mentorName: r.mentor.name,
      internship: r.internship
        ? {
            id: r.internship.id,
            status: r.internship.status,
            nonWorkerId: r.internship.nonWorkerId,
            actualStart: r.internship.actualStart,
            actualEnd: r.internship.actualEnd,
          }
        : null,
    })),
    joiningRecord: maskedJoiningRecord,
    statusHistory,
    documents,
    tasks,
    aiActions,
  });
});

const evaluateAdhocSchema = z.object({
  resumeText: z.string().min(1),
  jobDescription: z.string().min(1),
});

// Ad-hoc Resume Analyzer run — no persisted Candidate record required.
// candidateProfile is the raw resume text itself rather than the
// structured fields /:id/evaluate below builds from a saved Candidate row;
// matchScore's prompt reasons over whatever profile shape it's given, and
// raw text is strictly more information than the structured subset used
// elsewhere. Distinct role set (see PERMISSION_MATRIX.candidate.evaluateAdhoc)
// from the persisted-record path, which stays HR-only.
router.post(
  "/evaluate-adhoc",
  authenticate,
  requireRole(...PERMISSION_MATRIX.candidate.evaluateAdhoc),
  async (req, res) => {
    const parsed = evaluateAdhocSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      return;
    }
    const { resumeText, jobDescription } = parsed.data;
    const actorId = req.user!.userId;

    // Runs RESUME_PARSE first (per spec: "calls RESUME_PARSE ... then
    // MATCH_SCORE") so the Resume Analyzer's History tab has both action
    // types regardless of whether the input came from pasted text or an
    // uploaded file — the parsed fields themselves aren't otherwise used
    // here, matchScore reasons directly over the raw resumeText.
    await resumeParse({ resumeText, actorId });

    const result = await matchScore({
      candidateProfile: { resumeText },
      jobDescription,
      actorId,
    });

    res.status(201).json({ evaluation: result });
  }
);

const evaluateSchema = z.object({ jobDescription: z.string().min(1) });

router.post(
  "/:id/evaluate",
  authenticate,
  requireRole(...PERMISSION_MATRIX.candidate.evaluate),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const parsedBody = evaluateSchema.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
      return;
    }
    const { id } = parsedParams.data;
    const { jobDescription } = parsedBody.data;

    const candidate = await prisma.candidate.findUnique({ where: { id } });
    if (!candidate) {
      res.status(404).json({ error: "Candidate not found" });
      return;
    }

    // The Day 2 resume-parse pipeline feeds directly into these fields at
    // candidate creation — this *is* the persisted "parsed resume" data.
    // Resume parsing itself happens before the candidate record exists
    // (purely to prefill this form), so there's no separate durable
    // RESUME_PARSE record tied to this candidate to look up instead.
    const candidateProfile = {
      fullName: candidate.fullName,
      qualification: candidate.qualification,
      institution: candidate.institution,
      skills: candidate.skills,
      city: candidate.city,
      nationality: candidate.nationality,
    };

    const result = await matchScore({ candidateId: id, candidateProfile, jobDescription, actorId: req.user!.userId });

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    const evaluation = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "Evaluation",
        entityId: (created) => created.id,
        after: { candidateId: id, matchScore: result.matchScore, recommendation: result.recommendation },
      },
      () =>
        prisma.evaluation.create({
          data: {
            candidateId: id,
            jobDescription,
            matchScore: result.matchScore,
            recommendation: result.recommendation,
            strengths: result.strengths,
            weaknesses: result.weaknesses,
            aiSummary: result.aiSummary,
          },
        })
    );

    res.status(201).json({ evaluation });
  }
);

router.get(
  "/:id/evaluations",
  authenticate,
  requireRole(...PERMISSION_MATRIX.candidate.evaluationsRead),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const candidate = await prisma.candidate.findUnique({ where: { id } });
    if (!candidate) {
      res.status(404).json({ error: "Candidate not found" });
      return;
    }

    const role = req.user!.role;
    if (role === Role.MENTOR) {
      const isMentor = await prisma.referral.findFirst({
        where: { candidateId: id, internship: { mentorId: req.user!.userId } },
      });
      if (!isMentor) {
        res.status(403).json({ error: "You are not the mentor for this candidate" });
        return;
      }
    }
    // HR / PROGRAM_OWNER: unrestricted, per PERMISSION_MATRIX.candidate.evaluationsRead.

    const evaluations = await prisma.evaluation.findMany({
      where: { candidateId: id },
      orderBy: { createdAt: "desc" },
    });

    res.json({ evaluations });
  }
);

export default router;
