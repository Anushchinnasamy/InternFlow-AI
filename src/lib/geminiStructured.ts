// Schemas passed here must be built with the "zod/v3" compatibility import
// (not the app's usual "zod" v4 import) — zod-to-json-schema's types are
// still written against the v3 ZodType shape.
import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";
import { FinishReason } from "@google/genai";
import { gemini, AI_MODEL } from "./geminiClient";

const NON_SUCCESS_FINISH_REASONS = new Set<FinishReason>([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.LANGUAGE,
  FinishReason.OTHER,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
]);

// Thrown for anything that goes wrong talking to the AI provider itself
// (quota exhaustion, rate limiting, transient outage) — deliberately
// carries a clean, safe-to-display message. Found in manual testing: the
// raw @google/genai SDK error's .message on a 429 IS the provider's full
// JSON error body (quota metrics, retry hints, doc links), and app.ts's
// generic error handler was dumping err.message straight into the API
// response with zero sanitization — every AI-calling endpoint leaked this,
// not just one. See app.ts's specific handling of this class.
export class AiProviderError extends Error {
  constructor(message: string, public readonly cause: unknown) {
    super(message);
    this.name = "AiProviderError";
  }
}

export async function generateStructured<Schema extends z.ZodType>(
  schema: Schema,
  prompt: string
): Promise<z.infer<Schema>> {
  let response: Awaited<ReturnType<typeof gemini.models.generateContent>>;
  try {
    response = await gemini.models.generateContent({
      model: AI_MODEL,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: zodToJsonSchema(schema),
      },
    });
  } catch (err) {
    // The raw error is logged server-side (see app.ts) for real debugging —
    // it just never reaches the client verbatim.
    throw new AiProviderError("The AI service is temporarily unavailable (busy or rate-limited). Please try again shortly.", err);
  }

  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason && NON_SUCCESS_FINISH_REASONS.has(finishReason)) {
    throw new Error(`Model declined to respond (finishReason: ${finishReason})`);
  }

  const text = response.text;
  if (!text) {
    throw new Error("Model returned no output");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Model output was not valid JSON");
  }

  return schema.parse(raw);
}
