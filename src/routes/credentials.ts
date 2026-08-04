import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { authenticate } from "../middleware/authenticate";
import { requireRole } from "../middleware/rbac";
import { prisma } from "../lib/prisma";
import { withAudit } from "../lib/withAudit";
import { hashCredentialToken } from "../lib/credentials";
import { findCandidateForUser } from "../lib/candidateContext";

const router = Router();

// The candidate already has an account by this stage of the lifecycle
// (Day 2/3), so redemption is CANDIDATE-authenticated and matched to their
// own internship rather than a fully public magic-link flow.
router.get("/redeem/:token", authenticate, requireRole(Role.CANDIDATE), async (req, res) => {
  const parsedParams = z.object({ token: z.string().min(1) }).safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { token } = parsedParams.data;
  const tokenHash = hashCredentialToken(token);

  const credentialToken = await prisma.credentialToken.findFirst({
    where: { tokenHash },
    include: { internship: { include: { referral: true } } },
  });
  if (!credentialToken) {
    res.status(404).json({ error: "Invalid or unknown token" });
    return;
  }

  const candidate = await findCandidateForUser(req.user!.userId);
  if (!candidate || credentialToken.internship.referral.candidateId !== candidate.id) {
    res.status(403).json({ error: "This credential token does not belong to your internship" });
    return;
  }

  if (credentialToken.usedAt) {
    res.status(410).json({ error: "This credential token has already been redeemed" });
    return;
  }
  if (credentialToken.expiresAt < new Date()) {
    res.status(410).json({ error: "This credential token has expired" });
    return;
  }

  const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

  const redeemed = await withAudit(
    {
      ...actor,
      action: "REDEEM",
      entity: "CredentialToken",
      entityId: credentialToken.id,
      before: { usedAt: null },
      after: { usedAt: new Date() },
    },
    () => prisma.credentialToken.update({ where: { id: credentialToken.id }, data: { usedAt: new Date() } })
  );

  res.json({
    username: credentialToken.mockUsername,
    password: credentialToken.mockPassword,
    redeemedAt: redeemed.usedAt,
  });
});

export default router;
