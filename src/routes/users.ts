import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX, ALL_ROLES } from "../middleware/rbac";
import { prisma } from "../lib/prisma";

const router = Router();

const querySchema = z.object({ role: z.enum(ALL_ROLES as [Role, ...Role[]]) });

// Frontend Day F3 — Referral Intake's mentor picker (mentorId is a
// validated FK on Referral, not free text). Returns only id/name/email,
// never governmentId/dob (those stay behind the existing PII masking path
// on JoiningRecord — nothing here touches that).
router.get("/", authenticate, requireRole(...PERMISSION_MATRIX.user.listByRole), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  const users = await prisma.user.findMany({
    where: { role: parsed.data.role, active: true },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });

  res.json({ users });
});

export default router;
