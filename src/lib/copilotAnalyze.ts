// POST /copilot/analyze — separate from chatbot.ts's /chatbot/ask (FAQ-only,
// KB-grounded, zero DB access; that guarantee is untouched by this file).
// This path is allowed to pull aggregate, non-PII operational data into the
// LLM context. Candidate names are added only for HR/PROGRAM_OWNER callers
// (who already have that access via candidate search/dashboard endpoints);
// every other allowed role gets counts/stage/role only, never a name.
import { z } from "zod/v3";
import { AiActionType, Role } from "@prisma/client";
import { AI_MODEL } from "./geminiClient";
import { generateStructured } from "./geminiStructured";
import { logAiAction } from "./logAiAction";
import { computeDashboardAggregates, listBreachedCandidates } from "./dashboardAggregates";

const AnalyzeSchema = z.object({ answer: z.string() });

const RISK_KEYWORDS = ["risk", "sla", "breach", "overdue", "at risk", "at-risk", "miss", "delay", "slip"];

function isRiskQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  return RISK_KEYWORDS.some((keyword) => lower.includes(keyword));
}

const NAME_VISIBLE_ROLES = new Set<Role>([Role.HR, Role.PROGRAM_OWNER]);

export interface CopilotAnalyzeOutput {
  answer: string;
  variant: "risk" | "operational";
}

export async function copilotAnalyze(input: {
  question: string;
  callerRole: Role;
  actorId?: string | null;
}): Promise<CopilotAnalyzeOutput> {
  const aggregates = await computeDashboardAggregates();
  const includeNames = NAME_VISIBLE_ROLES.has(input.callerRole);
  const breachedCandidates = includeNames ? await listBreachedCandidates() : [];

  const contextLines = [
    `Internship stage counts:\n${JSON.stringify(aggregates.stageCounts, null, 2)}`,
    `Currently breached tasks by stage:\n${JSON.stringify(aggregates.breachCountsByStage, null, 2)}`,
    `Average days-to-complete by stage (last 90 days):\n${JSON.stringify(aggregates.avgDwellDaysByStage, null, 2)}`,
  ];
  contextLines.push(
    includeNames
      ? `Candidates currently behind on an SLA (name, stage, due date):\n${JSON.stringify(breachedCandidates, null, 2)}`
      : "Candidate names are not available to you for this question — answer with counts, stage, and role only, never a name."
  );

  const result = await generateStructured(
    AnalyzeSchema,
    "You are Intern Flow's operational copilot for HR/Program Owner/Mentor/IT Admin/Admin Security " +
      "staff. Answer the question below using ONLY the aggregate operational data provided — never " +
      "fabricate numbers, names, or dates not present in it. If the data doesn't cover the question, " +
      "say so plainly. Keep the answer concise and actionable.\n\n" +
      contextLines.join("\n\n") +
      `\n\nQuestion: ${input.question}`
  );

  const risk = isRiskQuestion(input.question);
  const output = risk ? { answer: result.answer } : { answer: result.answer, variant: "operational" as const };

  await logAiAction({
    type: risk ? AiActionType.SLA_RISK_PREDICTION : AiActionType.CHATBOT_ANSWER,
    entity: "Copilot",
    input: { question: input.question, aggregates, namesIncluded: includeNames },
    output,
    modelUsed: AI_MODEL,
    actorId: input.actorId,
  });

  return { answer: result.answer, variant: risk ? "risk" : "operational" };
}
