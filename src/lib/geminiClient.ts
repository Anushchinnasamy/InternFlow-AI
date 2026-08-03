import { GoogleGenAI } from "@google/genai";

const AI_API_KEY = process.env.AI_API_KEY;
if (!AI_API_KEY) {
  throw new Error("AI_API_KEY is not set");
}

export const gemini = new GoogleGenAI({ apiKey: AI_API_KEY });

// Default: current stable Gemini flash tier — fast/cheap enough for
// extraction-style tasks. Overridable via AI_MODEL.
export const AI_MODEL = process.env.AI_MODEL ?? "gemini-3.6-flash";
