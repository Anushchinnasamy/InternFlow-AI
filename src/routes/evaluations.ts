import { Router } from "express";
import { z } from "zod";
import { EvaluationDecision } from "@prisma/client";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX } from "../middleware/rbac";
import { withAudit } from "../lib/withAudit";
import { prisma } from "../lib/prisma";

const router = Router();

const rubricSchema = z.object({
  communication: z.number().int().min(1).max(5),
  technical: z.number().int().min(1).max(5),
  experience: z.number().int().min(1).max(5),
  culturalFit: z.number().int().min(1).max(5),
});

router.patch("/:id/rubric", authenticate, requireRole(...PERMISSION_MATRIX.evaluation.rubric), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  const parsedBody = rubricSchema.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
    return;
  }
  const { id } = parsedParams.data;
  const { communication, technical, experience, culturalFit } = parsedBody.data;

  const evaluation = await prisma.evaluation.findUnique({ where: { id } });
  if (!evaluation) {
    res.status(404).json({ error: "Evaluation not found" });
    return;
  }

  const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

  // Human-entered, independent of matchScore — this never touches
  // recommendation/strengths/weaknesses/aiSummary, only the rubric columns.
  const updated = await withAudit(
    {
      ...actor,
      action: "UPDATE",
      entity: "Evaluation",
      entityId: evaluation.id,
      before: {
        rubricCommunication: evaluation.rubricCommunication,
        rubricTechnical: evaluation.rubricTechnical,
        rubricExperience: evaluation.rubricExperience,
        rubricCulturalFit: evaluation.rubricCulturalFit,
      },
      after: {
        rubricCommunication: communication,
        rubricTechnical: technical,
        rubricExperience: experience,
        rubricCulturalFit: culturalFit,
      },
    },
    () =>
      prisma.evaluation.update({
        where: { id },
        data: {
          rubricCommunication: communication,
          rubricTechnical: technical,
          rubricExperience: experience,
          rubricCulturalFit: culturalFit,
        },
      })
  );

  res.json({ evaluation: updated });
});

const decideSchema = z.object({ decision: z.nativeEnum(EvaluationDecision) });

router.post("/:id/decide", authenticate, requireRole(...PERMISSION_MATRIX.evaluation.decide), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  const parsedBody = decideSchema.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
    return;
  }
  const { id } = parsedParams.data;
  const { decision } = parsedBody.data;

  const evaluation = await prisma.evaluation.findUnique({ where: { id } });
  if (!evaluation) {
    res.status(404).json({ error: "Evaluation not found" });
    return;
  }
  if (evaluation.decision) {
    res.status(409).json({ error: "This evaluation has already been decided", decision: evaluation.decision });
    return;
  }

  const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };
  const decidedAt = new Date();

  // The only field that actually moves a candidate forward. Deliberately a
  // separate column from `recommendation` (the AI's advisory read, set
  // once at evaluate-time and never touched again) — this write can never
  // silently overwrite it, in either direction.
  const updated = await withAudit(
    {
      ...actor,
      action: "DECIDE",
      entity: "Evaluation",
      entityId: evaluation.id,
      before: { decision: null, decidedBy: null, decidedAt: null },
      after: { decision, decidedBy: req.user!.userId, decidedAt },
    },
    () =>
      prisma.evaluation.update({
        where: { id },
        data: { decision, decidedBy: req.user!.userId, decidedAt },
      })
  );

  res.json({ evaluation: updated });
});

export default router;
