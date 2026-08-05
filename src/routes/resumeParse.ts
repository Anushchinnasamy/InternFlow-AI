import { Router, type Request, type Response } from "express";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX } from "../middleware/rbac";
import { resumeParse, confidenceScore, formPrefill, missingInfoCheck, smartValidation } from "../lib/ai";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

async function extractPdfText(req: Request, res: Response): Promise<string | null> {
  if (!req.file) {
    res.status(400).json({ error: "A 'resume' PDF file is required" });
    return null;
  }
  if (req.file.mimetype !== "application/pdf") {
    res.status(400).json({ error: "Only PDF files are accepted" });
    return null;
  }

  let resumeText: string;
  const parser = new PDFParse({ data: req.file.buffer });
  try {
    const textResult = await parser.getText();
    resumeText = textResult.text;
  } catch {
    res.status(400).json({ error: "Could not extract text from the uploaded PDF" });
    return null;
  } finally {
    await parser.destroy();
  }

  if (!resumeText.trim()) {
    res.status(400).json({ error: "No extractable text found in the uploaded PDF" });
    return null;
  }

  return resumeText;
}

// Runs the full Day 2 resume-intake AI pipeline: extract text from an
// uploaded PDF, parse structured fields, score per-field confidence, prefill
// the intake form, then flag gaps/implausible values. Every step logs its
// own AiAction row via the functions in lib/ai — nothing here writes to
// AiAction directly.
router.post(
  "/resume-parse",
  authenticate,
  requireRole(...PERMISSION_MATRIX.candidate.parseResume),
  upload.single("resume"),
  async (req, res) => {
    const resumeText = await extractPdfText(req, res);
    if (resumeText === null) return;

    const actorId = req.user!.userId;
    const parsed = await resumeParse({ resumeText, actorId });
    const confidence = await confidenceScore({ resumeText, parsed, actorId });
    const prefilledForm = await formPrefill({ parsed, actorId });
    const missingInfo = await missingInfoCheck({ parsed, confidence, actorId });
    const validation = await smartValidation({ educationEntries: parsed.education, actorId });

    res.json({ parsed, confidence, prefilledForm, missingInfo, validation });
  }
);

// Frontend Day F3 — text-extraction only, zero AI calls. The Resume
// Analyzer's "Upload File" tab needs raw resume text to hand to
// POST /candidates/evaluate-adhoc (which runs its own RESUME_PARSE +
// MATCH_SCORE); running the full pipeline above first would burn 3 extra
// Gemini calls (confidenceScore, formPrefill) it has no use for.
router.post(
  "/extract-text",
  authenticate,
  requireRole(...PERMISSION_MATRIX.candidate.parseResume),
  upload.single("resume"),
  async (req, res) => {
    const resumeText = await extractPdfText(req, res);
    if (resumeText === null) return;
    res.json({ resumeText });
  }
);

export default router;
