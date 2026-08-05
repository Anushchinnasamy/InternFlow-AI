// GET /dashboard/ai-narrative — one LLM call turning the aggregate numbers
// behind /dashboard/stage-counts and /dashboard/sla-breaches into a short
// narrative for the dashboard. Only computeDashboardAggregates()'s output
// (stage names + counts + averages) is ever sent to the model — no
// Candidate or JoiningRecord table is queried here, so PII cannot reach it.
import { z } from "zod/v3";
import { AiActionType } from "@prisma/client";
import { AI_MODEL } from "./geminiClient";
import { generateStructured } from "./geminiStructured";
import { logAiAction } from "./logAiAction";
import { computeDashboardAggregates } from "./dashboardAggregates";

const NarrativeSchema = z.object({
  // One explanation per bottleneck stage, in the same order as the
  // "Top bottleneck stages" list given in the prompt — index-matched rather
  // than name-matched so a paraphrased stage name from the model can't
  // silently drop an explanation.
  bottleneckExplanations: z.array(z.string()),
  insights: z.array(z.string()),
  recommendations: z.array(z.string()),
});

export interface DashboardNarrativeOutput {
  bottlenecks: Array<{ stage: string; candidateCount: number; avgDwellDays: number | null; explanation: string }>;
  insights: string[];
  recommendations: string[];
}

export async function dashboardNarrative(actorId?: string | null): Promise<DashboardNarrativeOutput> {
  const aggregates = await computeDashboardAggregates();
  const bottleneckStageNames = aggregates.bottlenecks.map((b) => b.stage);

  const narrative = await generateStructured(
    NarrativeSchema,
    "You are summarizing operational data for an internship program dashboard, for a " +
      "PROGRAM_OWNER/HR audience. You are given only aggregate counts and stage names — no " +
      "candidate names or personal data of any kind. For each stage listed in 'Top bottleneck " +
      "stages' below, write exactly one 1-sentence explanation (in the same order) of why that " +
      "kind of stage commonly runs slow, grounded in what the stage name implies (e.g. document " +
      "turnaround, an external dependency, an approval queue). Return an empty array if there are " +
      "no bottleneck stages. Then write 3-4 short 'AI Insights' bullets (e.g. how many cases may " +
      "miss SLA soon) and 2-3 short 'AI Recommendations' bullets. Do not invent numbers not " +
      "implied by the data below.\n\n" +
      `Internship stage counts:\n${JSON.stringify(aggregates.stageCounts, null, 2)}\n\n` +
      `Currently breached tasks by stage:\n${JSON.stringify(aggregates.breachCountsByStage, null, 2)}\n\n` +
      `Average days-to-complete by stage (last ${90} days):\n${JSON.stringify(aggregates.avgDwellDaysByStage, null, 2)}\n\n` +
      `Top bottleneck stages (in order): ${bottleneckStageNames.join(", ") || "none"}`
  );

  const bottlenecks = aggregates.bottlenecks.map((b, i) => ({
    ...b,
    explanation: narrative.bottleneckExplanations[i] ?? "",
  }));

  const output = { bottlenecks, insights: narrative.insights, recommendations: narrative.recommendations };

  await logAiAction({
    type: AiActionType.SLA_RISK_PREDICTION,
    entity: "Dashboard",
    input: { aggregates },
    output,
    modelUsed: AI_MODEL,
    actorId,
  });

  return output;
}
