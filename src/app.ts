// Express app configuration, split out from index.ts (which just imports
// this, starts the cron jobs, and calls listen()) so tests can exercise the
// app in-process via supertest without binding a real port.

import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";

import healthRouter from "./routes/health";
import authRouter from "./routes/auth";
import meRouter from "./routes/me";
import adminRouter from "./routes/admin";
import resumeParseRouter from "./routes/resumeParse";
import candidatesRouter from "./routes/candidates";
import referralsRouter from "./routes/referrals";
import joiningFormsRouter from "./routes/joiningForms";
import internshipsRouter from "./routes/internships";
import credentialsRouter from "./routes/credentials";
import tasksRouter from "./routes/tasks";
import extensionsRouter from "./routes/extensions";
import webhooksRouter from "./routes/webhooks";
import notificationsRouter from "./routes/notifications";
import chatbotRouter from "./routes/chatbot";
import dashboardRouter from "./routes/dashboard";
import evaluationsRouter from "./routes/evaluations";
import copilotRouter from "./routes/copilot";
import aiActionsRouter from "./routes/aiActions";
import usersRouter from "./routes/users";
import certificatesRouter from "./routes/certificates";
import { TransitionError } from "./lib/transition";

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use("/health", healthRouter);
app.use("/auth", authRouter);
app.use("/me", meRouter);
app.use("/admin", adminRouter);
app.use("/ai", resumeParseRouter);
app.use("/candidates", candidatesRouter);
app.use("/referrals", referralsRouter);
app.use("/joining-forms", joiningFormsRouter);
app.use("/internships", internshipsRouter);
app.use("/credentials", credentialsRouter);
app.use("/tasks", tasksRouter);
app.use("/extensions", extensionsRouter);
app.use("/webhooks", webhooksRouter);
app.use("/notifications", notificationsRouter);
app.use("/chatbot", chatbotRouter);
app.use("/dashboard", dashboardRouter);
app.use("/evaluations", evaluationsRouter);
app.use("/copilot", copilotRouter);
app.use("/ai-actions", aiActionsRouter);
app.use("/users", usersRouter);
app.use("/certificates", certificatesRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof TransitionError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof Error) {
    console.error(err);
    res.status(500).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});
