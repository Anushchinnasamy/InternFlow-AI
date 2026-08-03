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

export async function generateStructured<Schema extends z.ZodType>(
  schema: Schema,
  prompt: string
): Promise<z.infer<Schema>> {
  const response = await gemini.models.generateContent({
    model: AI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: zodToJsonSchema(schema),
    },
  });

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
