import path from "path";
import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX } from "../middleware/rbac";
import { prisma } from "../lib/prisma";
import { withAudit } from "../lib/withAudit";

const router = Router();

// Frontend Day F5 Certificates page. "issued" and "pending" are two
// different underlying tables (Certificate rows vs. Internships that have
// requested-but-not-yet-generated a certificate, per Day 6's request/approve/
// generate sequence) — kept as one endpoint with a required `status` since
// the page shows them as two tabs of the same resource, not two resources.
const listQuerySchema = z.object({ status: z.enum(["issued", "pending"]) });

router.get("/", authenticate, requireRole(...PERMISSION_MATRIX.certificate.list), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }

  if (parsed.data.status === "pending") {
    const internships = await prisma.internship.findMany({
      where: { certificateRequestedAt: { not: null }, certificate: null },
      include: { referral: { include: { candidate: true } } },
      orderBy: { certificateRequestedAt: "desc" },
    });
    res.json({
      pending: internships.map((i) => ({
        internshipId: i.id,
        candidateName: i.referral.candidate.fullName,
        projectTitle: i.referral.projectTitle,
        certificateRequestedAt: i.certificateRequestedAt,
        certificateApprovedAt: i.certificateApprovedAt,
      })),
    });
    return;
  }

  // "issued" = Certificate rows with no revokedAt. Revoked certificates stay
  // in the table (nothing here is ever hard-deleted) but drop out of this
  // list — see POST /:id/revoke.
  const certificates = await prisma.certificate.findMany({
    where: { revokedAt: null },
    include: { internship: { include: { referral: { include: { candidate: true } } } } },
    orderBy: { issuedAt: "desc" },
  });
  res.json({
    issued: certificates.map((c) => ({
      id: c.id,
      internshipId: c.internshipId,
      referenceNumber: c.referenceNumber,
      storageUri: c.storageUri,
      issuedAt: c.issuedAt,
      candidateName: c.internship.referral.candidate.fullName,
      projectTitle: c.internship.referral.projectTitle,
    })),
  });
});

// Frontend Day F5 Certificates page's Download action. Nothing in the
// codebase serves generated/uploaded files yet (saveGeneratedFile/
// saveUploadedFile just write to local disk) — this is the first such
// route, deliberately authenticated+role-gated rather than a blanket
// express.static(UPLOAD_DIR), since these PDFs carry candidate PII.
router.get("/:id/download", authenticate, requireRole(...PERMISSION_MATRIX.certificate.list), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const certificate = await prisma.certificate.findUnique({ where: { id: parsedParams.data.id } });
  if (!certificate) {
    res.status(404).json({ error: "Certificate not found" });
    return;
  }

  res.download(path.resolve(certificate.storageUri), `${certificate.referenceNumber}.pdf`, (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: "Certificate file not found on disk" });
    }
  });
});

const revokeSchema = z.object({ reason: z.string().min(1) });

router.post("/:id/revoke", authenticate, requireRole(...PERMISSION_MATRIX.certificate.revoke), async (req, res) => {
  const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
  const parsedBody = revokeSchema.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
    return;
  }
  const { id } = parsedParams.data;
  const { reason } = parsedBody.data;

  const certificate = await prisma.certificate.findUnique({ where: { id } });
  if (!certificate) {
    res.status(404).json({ error: "Certificate not found" });
    return;
  }
  if (certificate.revokedAt) {
    res.status(409).json({ error: "Certificate is already revoked" });
    return;
  }

  const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };
  const revokedAt = new Date();

  const updated = await withAudit(
    {
      ...actor,
      action: "REVOKE",
      entity: "Certificate",
      entityId: certificate.id,
      before: { revokedAt: null, revokedReason: null },
      after: { revokedAt, revokedReason: reason },
    },
    () => prisma.certificate.update({ where: { id: certificate.id }, data: { revokedAt, revokedReason: reason } })
  );

  res.json({ certificate: updated });
});

export default router;
