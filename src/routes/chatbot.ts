import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX } from "../middleware/rbac";
import { prisma } from "../lib/prisma";
import { withAudit } from "../lib/withAudit";
import { chatbotAnswer } from "../lib/ai";

const router = Router();

const askSchema = z.object({ question: z.string().min(1).max(1000) });

router.post("/ask", authenticate, requireRole(...PERMISSION_MATRIX.chatbot.ask), async (req, res) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const { question } = parsed.data;

  const result = await chatbotAnswer({ question, actorId: req.user!.userId });

  // Ungrounded means the knowledge base genuinely doesn't cover it — hand
  // it to a human instead of leaving the asker with "I don't know."
  let escalationTask = null;
  if (!result.grounded) {
    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };
    escalationTask = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "Task",
        entityId: (created) => created.id,
        after: { type: "CHATBOT_ESCALATION", question },
      },
      () =>
        prisma.task.create({
          data: {
            type: "CHATBOT_ESCALATION",
            assigneeRole: "HR",
            dueAt: new Date(Date.now() + 24 * 3600 * 1000),
            payload: { question, askedBy: req.user!.userId },
          },
        })
    );
  }

  res.json({ answer: result.answer, grounded: result.grounded, escalationTask });
});

export default router;
