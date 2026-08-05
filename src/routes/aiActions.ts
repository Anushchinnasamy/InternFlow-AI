import { Router } from "express";
import { z } from "zod";
import { AiActionType } from "@prisma/client";
import { authenticate } from "../middleware/authenticate";
import { prisma } from "../lib/prisma";

const router = Router();

const AI_ACTION_TYPE_VALUES = Object.values(AiActionType) as [AiActionType, ...AiActionType[]];

const querySchema = z.object({
  type: z
    .string()
    .optional()
    .transform((value) => value?.split(",").map((t) => t.trim()).filter(Boolean)),
  mine: z.string().optional(),
});

// Self-scoped history for the Resume Analyzer's "History" tab — any
// authenticated role, but always filtered to the caller's own actorId.
// There is no "see everyone's" mode here: that's GET /admin/ai-actions
// (ADMIN_SECURITY/SYSADMIN/PROGRAM_OWNER only), a different, broader
// audit surface this endpoint doesn't touch or widen.
router.get("/", authenticate, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const requestedTypes = parsed.data.type;
  if (requestedTypes) {
    const invalid = requestedTypes.filter((t) => !AI_ACTION_TYPE_VALUES.includes(t as AiActionType));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Unknown AiActionType(s): ${invalid.join(", ")}` });
      return;
    }
  }

  const actions = await prisma.aiAction.findMany({
    where: {
      actorId: req.user!.userId,
      ...(requestedTypes ? { type: { in: requestedTypes as AiActionType[] } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const candidateIds = [...new Set(actions.filter((a) => a.entity === "Candidate" && a.entityId).map((a) => a.entityId as string))];
  const candidates = candidateIds.length
    ? await prisma.candidate.findMany({ where: { id: { in: candidateIds } }, select: { id: true, fullName: true } })
    : [];
  const candidateNameById = new Map(candidates.map((c) => [c.id, c.fullName]));

  const enriched = actions.map((a) => ({
    ...a,
    candidateName: a.entity === "Candidate" && a.entityId ? (candidateNameById.get(a.entityId) ?? null) : null,
  }));

  res.json({ actions: enriched });
});

export default router;
