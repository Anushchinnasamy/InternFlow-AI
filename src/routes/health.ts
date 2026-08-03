import { Router } from "express";
import { Role, AiActionType } from "@prisma/client";
import { prisma } from "../lib/prisma";

const router = Router();

router.get("/", async (_req, res) => {
  let dbConnected = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbConnected = false;
  }

  res.status(dbConnected ? 200 : 503).json({
    status: dbConnected ? "ok" : "degraded",
    dbConnected,
    roles: Object.values(Role),
    aiActionTypes: Object.values(AiActionType),
  });
});

export default router;
