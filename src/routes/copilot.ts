import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX } from "../middleware/rbac";
import { copilotAnalyze } from "../lib/copilotAnalyze";

const router = Router();

const analyzeSchema = z.object({ question: z.string().min(1).max(1000) });

// Separate from /chatbot/ask — see src/lib/copilotAnalyze.ts for the
// aggregate-data/candidate-name visibility rules.
router.post("/analyze", authenticate, requireRole(...PERMISSION_MATRIX.copilot.analyze), async (req, res) => {
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const result = await copilotAnalyze({
    question: parsed.data.question,
    callerRole: req.user!.role,
    actorId: req.user!.userId,
  });
  res.json(result);
});

export default router;
