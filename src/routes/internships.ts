import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { DocumentType, Internship, InternshipStatus, Prisma, Role } from "@prisma/client";
import { authenticate } from "../middleware/authenticate";
import { requireRole, PERMISSION_MATRIX } from "../middleware/rbac";
import { withAudit } from "../lib/withAudit";
import { prisma } from "../lib/prisma";
import { transition } from "../lib/transition";
import { completeTask } from "../lib/tasks";
import { addBusinessDays, subtractBusinessDays } from "../lib/businessDays";
import { loadInternshipPacket } from "../lib/internshipContext";
import { generateNdaPdf } from "../lib/pdf/ndaPdf";
import { generateConfirmationLetterPdf } from "../lib/pdf/confirmationLetterPdf";
import { generateCertificatePdf } from "../lib/pdf/certificatePdf";
import { saveGeneratedFile, saveUploadedFile } from "../lib/uploads";
import { esignAdapter } from "../lib/adapters/esign";
import { adAdapter } from "../lib/adapters/ad";
import { findCandidateForUser } from "../lib/candidateContext";
import { maskJoiningRecord } from "../lib/pii";
import { generateCredentialToken, hashCredentialToken, generateMockAdCredentials } from "../lib/credentials";
import { sendTemplatedEmail } from "../lib/notifications";
import { buildExitChecklist } from "../lib/exitChecklist";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = Router();

// Frontend Day F4 — NDA Management, Non-Worker ID, and Access Provisioning
// all need a cross-candidate list, which nothing exposed before this (only
// /candidates/search, which requires a text query and can't "list all").
// One shared endpoint rather than three bespoke ones — reuses
// PERMISSION_MATRIX.internship.read (ALL_ROLES), a Day 1 forward-declared
// entry no route had used yet; scoped in-handler the same way
// /candidates/search scopes MENTOR/REFERRER/CANDIDATE to their own.
router.get("/", authenticate, requireRole(...PERMISSION_MATRIX.internship.read), async (req, res) => {
  const role = req.user!.role;
  const statusFilter = typeof req.query.status === "string" ? req.query.status.split(",") : undefined;

  let scopeFilter: Prisma.InternshipWhereInput = {};
  if (role === Role.MENTOR) {
    scopeFilter = { mentorId: req.user!.userId };
  } else if (role === Role.REFERRER) {
    scopeFilter = { referral: { referrerId: req.user!.userId } };
  } else if (role === Role.CANDIDATE) {
    const candidate = await findCandidateForUser(req.user!.userId);
    scopeFilter = { referral: { candidateId: candidate?.id ?? "__none__" } };
  }
  // HR/PROGRAM_OWNER/ADMIN_SECURITY/IT_ADMIN/LEGAL/SYSADMIN: unrestricted,
  // per internship.read's existing ALL_ROLES grant.

  const internships = await prisma.internship.findMany({
    where: {
      ...scopeFilter,
      ...(statusFilter ? { status: { in: statusFilter as InternshipStatus[] } } : {}),
    },
    include: {
      referral: { include: { candidate: true } },
      mentor: true,
      documents: { where: { type: DocumentType.NDA }, orderBy: { version: "desc" }, take: 1 },
      tasks: { where: { OR: [{ type: { in: ["AD_PROVISION", "SITE_ACCESS", "EXIT_CHECKLIST"] } }, { completedAt: null }] } },
      certificate: true,
      joiningRecord: true,
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  // Frontend Day F5 Workflow Kanban's "days in stage": the most recent
  // TRANSITION audit event for an internship is, by definition, the moment
  // it entered whatever status it's currently in (status only moves forward
  // through transition(), so nothing since could have re-entered it).
  // Batched once across every row rather than one query per card.
  const transitionEvents = await prisma.auditEvent.findMany({
    where: { entity: "Internship", entityId: { in: internships.map((i) => i.id) }, action: "TRANSITION" },
    orderBy: { createdAt: "desc" },
    select: { entityId: true, createdAt: true },
  });
  const stageEnteredAtByInternship = new Map<string, Date>();
  for (const e of transitionEvents) {
    if (!stageEnteredAtByInternship.has(e.entityId)) stageEnteredAtByInternship.set(e.entityId, e.createdAt);
  }

  const results = internships.map((i) => {
    const latestNda = i.documents[0] ?? null;
    const adProvisionTask = i.tasks.find((t) => t.type === "AD_PROVISION") ?? null;
    const siteAccessTask = i.tasks.find((t) => t.type === "SITE_ACCESS") ?? null;
    const exitChecklistTask = i.tasks.find((t) => t.type === "EXIT_CHECKLIST") ?? null;
    // Workflow Kanban's "owner" — the Task model only tracks an assignee
    // *role*, never a specific user, so this is a role badge ("Owner: HR"),
    // not a named person. First open task of any type is enough for a
    // contextual hint; a card can only realistically have one relevant open
    // task for its current stage at a time.
    const openTask = i.tasks.find((t) => !t.completedAt) ?? null;
    return {
      id: i.id,
      status: i.status,
      nonWorkerId: i.nonWorkerId,
      nonWorkerIdDeactivatedAt: i.nonWorkerIdDeactivatedAt,
      adAccountActive: i.adAccountActive,
      badgeNumber: i.badgeNumber,
      badgeReturnedAt: i.badgeReturnedAt,
      actualStart: i.actualStart,
      actualEnd: i.actualEnd,
      mentorCompletionConfirmedAt: i.mentorCompletionConfirmedAt,
      certificateRequestedAt: i.certificateRequestedAt,
      certificateApprovedAt: i.certificateApprovedAt,
      hasCertificate: !!i.certificate,
      candidateId: i.referral.candidateId,
      candidateName: i.referral.candidate.fullName,
      projectTitle: i.referral.projectTitle,
      mentorName: i.mentor.name,
      mentorId: i.mentorId,
      referralId: i.referralId,
      joiningRecordId: i.joiningRecord?.id ?? null,
      // Frontend Day F5 Intern Lifecycle page's Progress % bar — same
      // actual-over-proposed fallback loadInternshipPacket uses, resolved
      // here so the frontend doesn't have to re-derive it from a referral
      // sub-object it doesn't otherwise need.
      startDate: i.actualStart ?? i.referral.proposedStart,
      endDate: i.actualEnd ?? i.referral.proposedEnd,
      stageEnteredAt: stageEnteredAtByInternship.get(i.id) ?? i.createdAt,
      openTask: openTask ? { type: openTask.type, assigneeRole: openTask.assigneeRole, slaBreached: openTask.slaBreached } : null,
      nda: latestNda
        ? {
            id: latestNda.id,
            version: latestNda.version,
            signedAt: latestNda.signedAt,
            expiredAt: latestNda.expiredAt,
            status: latestNda.signedAt ? "signed" : latestNda.expiredAt ? "expired" : "pending",
          }
        : null,
      adProvisionTask: adProvisionTask
        ? { id: adProvisionTask.id, checklist: adProvisionTask.checklist, completedAt: adProvisionTask.completedAt }
        : null,
      siteAccessTask: siteAccessTask ? { id: siteAccessTask.id, completedAt: siteAccessTask.completedAt } : null,
      exitChecklistTask: exitChecklistTask
        ? {
            id: exitChecklistTask.id,
            checklist: buildExitChecklist(i, exitChecklistTask.checklist),
            completedAt: exitChecklistTask.completedAt,
          }
        : null,
    };
  });

  res.json({ internships: results });
});

const nonWorkerIdSchema = z.object({ nonWorkerId: z.string().min(1) });

router.post(
  "/:id/non-worker-id",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.nonWorkerId),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const parsedBody = nonWorkerIdSchema.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
      return;
    }
    const { id } = parsedParams.data;
    const { nonWorkerId } = parsedBody.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (internship.status !== InternshipStatus.VERIFIED) {
      res.status(409).json({ error: `Internship is in status ${internship.status}, expected VERIFIED` });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    await withAudit(
      {
        ...actor,
        action: "UPDATE",
        entity: "Internship",
        entityId: internship.id,
        before: { nonWorkerId: internship.nonWorkerId },
        after: { nonWorkerId },
      },
      () => prisma.internship.update({ where: { id: internship.id }, data: { nonWorkerId } })
    );

    const pendingTask = await prisma.task.findFirst({
      where: { internshipId: internship.id, type: "NON_WORKER_ID", completedAt: null },
    });
    const task = pendingTask ? await completeTask(pendingTask.id, actor) : null;

    await transition({
      entity: "INTERNSHIP",
      entityId: internship.id,
      from: InternshipStatus.VERIFIED,
      to: InternshipStatus.ID_ISSUED,
      ...actor,
    });

    // Day 4: reaching ID_ISSUED auto-generates the NDA and sends it out for
    // signature — no separate HR action needed to kick off the NDA gate.
    const packet = await loadInternshipPacket(internship.id);
    if (!packet) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    const { candidate } = packet.internship.referral;
    const mentorName = packet.internship.mentor.name;
    const projectTitle = packet.internship.referral.projectTitle;

    const ndaPdf = await generateNdaPdf({
      candidateName: candidate.fullName,
      nonWorkerId,
      mentorName,
      projectTitle,
      startDate: packet.startDate,
      endDate: packet.endDate,
    });
    const { storageUri, sha256 } = await saveGeneratedFile(internship.id, ndaPdf, "nda-unsigned.pdf");

    const ndaDocument = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "Document",
        entityId: (created) => created.id,
        after: { type: "NDA", internshipId: internship.id, sha256, version: 1 },
      },
      () =>
        prisma.document.create({
          data: { internshipId: internship.id, type: DocumentType.NDA, storageUri, sha256, version: 1 },
        })
    );

    const { providerRef } = await esignAdapter.issue(
      { documentId: ndaDocument.id, internshipId: internship.id, sha256 },
      candidate.email
    );

    const ndaDocumentWithRef = await withAudit(
      {
        ...actor,
        action: "UPDATE",
        entity: "Document",
        entityId: ndaDocument.id,
        before: { providerRef: null },
        after: { providerRef },
      },
      () => prisma.document.update({ where: { id: ndaDocument.id }, data: { providerRef } })
    );

    const ndaSignDueAt = new Date(packet.startDate);
    ndaSignDueAt.setDate(ndaSignDueAt.getDate() - 1);

    const ndaSignTask = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "Task",
        entityId: (created) => created.id,
        after: { type: "NDA_SIGN", internshipId: internship.id, dueAt: ndaSignDueAt },
      },
      () =>
        prisma.task.create({
          data: {
            internshipId: internship.id,
            type: "NDA_SIGN",
            assigneeRole: "CANDIDATE",
            dueAt: ndaSignDueAt,
          },
        })
    );

    const finalInternship = await transition({
      entity: "INTERNSHIP",
      entityId: internship.id,
      from: InternshipStatus.ID_ISSUED,
      to: InternshipStatus.NDA_PENDING,
      ...actor,
    });

    await sendTemplatedEmail({
      to: candidate.email,
      templateId: "T09_NDA_FOR_SIGNATURE",
      mergeData: { candidateName: candidate.fullName, projectTitle, startDate: packet.startDate.toISOString().slice(0, 10) },
      internshipId: internship.id,
    });

    res.json({ internship: finalInternship, task, ndaDocument: ndaDocumentWithRef, ndaSignTask });
  }
);

const typedSignatureSchema = z.object({
  typedName: z.string().min(1),
  // Multipart form fields arrive as strings even for a "boolean" checkbox,
  // so accept both the JSON boolean and the string form.
  consentChecked: z.union([z.literal(true), z.literal("true")]),
});

router.post(
  "/:id/nda/sign",
  authenticate,
  requireRole(...PERMISSION_MATRIX.document.signNda),
  upload.single("file"),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const candidate = await findCandidateForUser(req.user!.userId);
    if (!candidate) {
      res.status(404).json({ error: "No candidate profile is linked to this account" });
      return;
    }

    const internship = await prisma.internship.findUnique({ where: { id }, include: { referral: true } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (internship.referral.candidateId !== candidate.id) {
      res.status(403).json({ error: "This is not your internship" });
      return;
    }
    if (internship.status !== InternshipStatus.NDA_PENDING) {
      res.status(409).json({ error: `Internship is in status ${internship.status}, expected NDA_PENDING` });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };
    const signedAt = new Date();

    let storageUri: string;
    let sha256: string;
    let signatureMeta: Record<string, unknown> | undefined;

    if (req.file) {
      // Wet-sign fallback: candidate/HR uploads an already-signed PDF.
      ({ storageUri, sha256 } = await saveUploadedFile(internship.id, req.file));
    } else {
      const parsedBody = typedSignatureSchema.safeParse(req.body);
      if (!parsedBody.success) {
        res.status(400).json({
          error: "Provide either an uploaded signed PDF ('file') or typedName + consentChecked:true",
          details: parsedBody.error.flatten(),
        });
        return;
      }
      signatureMeta = { typedName: parsedBody.data.typedName, consentedAt: signedAt.toISOString(), ip: req.ip ?? null };

      const packet = await loadInternshipPacket(id);
      if (!packet) {
        res.status(404).json({ error: "Internship not found" });
        return;
      }
      const ndaPdf = await generateNdaPdf({
        candidateName: packet.internship.referral.candidate.fullName,
        nonWorkerId: internship.nonWorkerId ?? "",
        mentorName: packet.internship.mentor.name,
        projectTitle: packet.internship.referral.projectTitle,
        startDate: packet.startDate,
        endDate: packet.endDate,
        signature: { typedName: parsedBody.data.typedName, signedAt },
      });
      ({ storageUri, sha256 } = await saveGeneratedFile(internship.id, ndaPdf, "nda-signed.pdf"));
    }

    const existingCount = await prisma.document.count({ where: { internshipId: internship.id, type: DocumentType.NDA } });

    const signedDocument = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "Document",
        entityId: (created) => created.id,
        after: { type: "NDA", internshipId: internship.id, sha256, version: existingCount + 1, signedAt },
      },
      () =>
        prisma.document.create({
          data: {
            internshipId: internship.id,
            type: DocumentType.NDA,
            storageUri,
            sha256,
            version: existingCount + 1,
            signedAt,
            signatureMeta: signatureMeta as Prisma.InputJsonValue | undefined,
          },
        })
    );

    const pendingTask = await prisma.task.findFirst({
      where: { internshipId: internship.id, type: "NDA_SIGN", completedAt: null },
    });
    const task = pendingTask ? await completeTask(pendingTask.id, actor) : null;

    // transition() runs the NDA hard gate (CLAUDE.md rule 1) before allowing
    // this — if signedAt isn't at least 1 day before startDate, it throws
    // and the internship stays in NDA_PENDING.
    const updatedInternship = await transition({
      entity: "INTERNSHIP",
      entityId: internship.id,
      from: InternshipStatus.NDA_PENDING,
      to: InternshipStatus.NDA_SIGNED,
      ...actor,
    });

    // Day 5: reaching NDA_SIGNED auto-fires both provisioning tracks in
    // parallel — AD account creation and physical site access — same
    // auto-trigger pattern as Day 4's NDA generation on ID_ISSUED.
    const provisionDueAt = addBusinessDays(new Date(), 2);
    const [adProvisionTask, siteAccessTask] = await Promise.all([
      withAudit(
        {
          ...actor,
          action: "CREATE",
          entity: "Task",
          entityId: (created) => created.id,
          after: { type: "AD_PROVISION", internshipId: internship.id, dueAt: provisionDueAt },
        },
        () =>
          prisma.task.create({
            data: {
              internshipId: internship.id,
              type: "AD_PROVISION",
              assigneeRole: "IT_ADMIN",
              dueAt: provisionDueAt,
              // Frontend Day F4's 4 access sub-tracks (Email/VPN/Repository/
              // Internal Tools) — granular progress only, ticked via
              // PATCH /tasks/:id/checklist. Finalizing AD provisioning is
              // still exactly this route's job (POST /:id/ad-provision),
              // independent of checklist state.
              checklist: { email: "pending", vpn: "pending", repository: "pending", internalTools: "pending" },
            },
          })
      ),
      withAudit(
        {
          ...actor,
          action: "CREATE",
          entity: "Task",
          entityId: (created) => created.id,
          after: { type: "SITE_ACCESS", internshipId: internship.id, dueAt: provisionDueAt },
        },
        () =>
          prisma.task.create({
            data: {
              internshipId: internship.id,
              type: "SITE_ACCESS",
              assigneeRole: "ADMIN_SECURITY",
              dueAt: provisionDueAt,
            },
          })
      ),
    ]);

    await sendTemplatedEmail({
      to: candidate.email,
      templateId: "T10_NDA_SIGNED_CONFIRMATION",
      mergeData: {
        candidateName: candidate.fullName,
        projectTitle: internship.referral.projectTitle,
        signedAt: signedAt.toISOString().slice(0, 10),
      },
      internshipId: internship.id,
    });

    res.json({ internship: updatedInternship, document: signedDocument, task, adProvisionTask, siteAccessTask });
  }
);

// Frontend Day F4 — invalidates the current unsigned NDA and re-runs the
// Day 4 generation logic (new Document version, new esign providerRef, new
// NDA_SIGN task) so the candidate gets a clean new signing window. Gated
// purely by "the latest NDA Document is still unsigned" — if it's already
// signed, there's nothing to expire (the internship has already moved on
// to NDA_SIGNED, which the caller can just as easily infer from the 409).
router.post(
  "/:id/nda/expire",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.ndaExpire),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }

    const currentNdaDocument = await prisma.document.findFirst({
      where: { internshipId: id, type: DocumentType.NDA },
      orderBy: { version: "desc" },
    });
    if (!currentNdaDocument) {
      res.status(404).json({ error: "No NDA document found for this internship" });
      return;
    }
    if (currentNdaDocument.signedAt) {
      res.status(409).json({ error: "The NDA has already been signed and cannot be expired" });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };
    const now = new Date();

    const expiredDocument = await withAudit(
      {
        ...actor,
        action: "EXPIRE",
        entity: "Document",
        entityId: currentNdaDocument.id,
        before: { expiredAt: null },
        after: { expiredAt: now },
      },
      () => prisma.document.update({ where: { id: currentNdaDocument.id }, data: { expiredAt: now } })
    );

    const openSignTask = await prisma.task.findFirst({
      where: { internshipId: id, type: "NDA_SIGN", completedAt: null },
    });
    const cancelledTask = openSignTask
      ? await withAudit(
          {
            ...actor,
            action: "CANCEL",
            entity: "Task",
            entityId: openSignTask.id,
            before: { completedAt: null },
            after: { completedAt: now },
          },
          () => prisma.task.update({ where: { id: openSignTask.id }, data: { completedAt: now } })
        )
      : null;

    const packet = await loadInternshipPacket(id);
    if (!packet) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    const { candidate } = packet.internship.referral;
    const mentorName = packet.internship.mentor.name;
    const projectTitle = packet.internship.referral.projectTitle;

    const ndaPdf = await generateNdaPdf({
      candidateName: candidate.fullName,
      nonWorkerId: internship.nonWorkerId ?? "",
      mentorName,
      projectTitle,
      startDate: packet.startDate,
      endDate: packet.endDate,
    });
    const { storageUri, sha256 } = await saveGeneratedFile(internship.id, ndaPdf, "nda-unsigned.pdf");
    const newVersion = currentNdaDocument.version + 1;

    const newNdaDocument = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "Document",
        entityId: (created) => created.id,
        after: { type: "NDA", internshipId: id, sha256, version: newVersion },
      },
      () =>
        prisma.document.create({
          data: { internshipId: id, type: DocumentType.NDA, storageUri, sha256, version: newVersion },
        })
    );

    const { providerRef } = await esignAdapter.issue(
      { documentId: newNdaDocument.id, internshipId: id, sha256 },
      candidate.email
    );

    const newNdaDocumentWithRef = await withAudit(
      {
        ...actor,
        action: "UPDATE",
        entity: "Document",
        entityId: newNdaDocument.id,
        before: { providerRef: null },
        after: { providerRef },
      },
      () => prisma.document.update({ where: { id: newNdaDocument.id }, data: { providerRef } })
    );

    const ndaSignDueAt = new Date(packet.startDate);
    ndaSignDueAt.setDate(ndaSignDueAt.getDate() - 1);

    const newNdaSignTask = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "Task",
        entityId: (created) => created.id,
        after: { type: "NDA_SIGN", internshipId: id, dueAt: ndaSignDueAt },
      },
      () =>
        prisma.task.create({
          data: { internshipId: id, type: "NDA_SIGN", assigneeRole: "CANDIDATE", dueAt: ndaSignDueAt },
        })
    );

    await sendTemplatedEmail({
      to: candidate.email,
      templateId: "T09_NDA_FOR_SIGNATURE",
      mergeData: { candidateName: candidate.fullName, projectTitle, startDate: packet.startDate.toISOString().slice(0, 10) },
      internshipId: id,
    });

    res.json({
      expiredDocument,
      cancelledTask,
      ndaDocument: newNdaDocumentWithRef,
      ndaSignTask: newNdaSignTask,
    });
  }
);

router.post(
  "/:id/confirmation-letter",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.confirmationLetter),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (!internship.nonWorkerId) {
      res.status(409).json({ error: "Confirmation letter requires a Non-Worker ID to be issued first" });
      return;
    }

    const packet = await loadInternshipPacket(id);
    if (!packet) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }

    const letterPdf = await generateConfirmationLetterPdf({
      candidateName: packet.internship.referral.candidate.fullName,
      nonWorkerId: internship.nonWorkerId,
      mentorName: packet.internship.mentor.name,
      projectTitle: packet.internship.referral.projectTitle,
      startDate: packet.startDate,
      endDate: packet.endDate,
      site: packet.internship.referral.site,
    });
    const { storageUri, sha256 } = await saveGeneratedFile(id, letterPdf, "confirmation-letter.pdf");

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };
    const existingCount = await prisma.document.count({
      where: { internshipId: id, type: DocumentType.CONFIRMATION_LETTER },
    });

    const document = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "Document",
        entityId: (created) => created.id,
        after: { type: "CONFIRMATION_LETTER", internshipId: id, sha256, version: existingCount + 1 },
      },
      () =>
        prisma.document.create({
          data: {
            internshipId: id,
            type: DocumentType.CONFIRMATION_LETTER,
            storageUri,
            sha256,
            version: existingCount + 1,
          },
        })
    );

    res.status(201).json({ document });
  }
);

router.get(
  "/:id/documents",
  authenticate,
  requireRole(...PERMISSION_MATRIX.document.read),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({ where: { id }, include: { referral: true } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }

    if (req.user!.role === "CANDIDATE") {
      const candidate = await findCandidateForUser(req.user!.userId);
      if (!candidate || internship.referral.candidateId !== candidate.id) {
        res.status(403).json({ error: "This is not your internship" });
        return;
      }
    }

    const documents = await prisma.document.findMany({
      where: { internshipId: id },
      orderBy: [{ type: "asc" }, { version: "asc" }],
    });

    res.json({ documents });
  }
);

router.post(
  "/:id/ad-provision",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.adProvision),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({ where: { id }, include: { referral: { include: { candidate: true } } } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (internship.status !== InternshipStatus.NDA_SIGNED) {
      res.status(409).json({ error: `Internship is in status ${internship.status}, expected NDA_SIGNED` });
      return;
    }
    if (internship.adAccountActive) {
      res.status(409).json({ error: "AD account is already provisioned for this internship" });
      return;
    }
    if (!internship.nonWorkerId) {
      res.status(409).json({ error: "Non-Worker ID must be issued before AD provisioning" });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };
    const { candidate } = internship.referral;

    const { accountRef } = await adAdapter.provision(
      { fullName: candidate.fullName, email: candidate.email },
      internship.nonWorkerId
    );

    const updatedInternship = await withAudit(
      {
        ...actor,
        action: "UPDATE",
        entity: "Internship",
        entityId: internship.id,
        before: { adAccountRef: internship.adAccountRef, adAccountActive: internship.adAccountActive },
        after: { adAccountRef: accountRef, adAccountActive: true },
      },
      () =>
        prisma.internship.update({
          where: { id: internship.id },
          data: { adAccountRef: accountRef, adAccountActive: true },
        })
    );

    const pendingTask = await prisma.task.findFirst({
      where: { internshipId: internship.id, type: "AD_PROVISION", completedAt: null },
    });
    const task = pendingTask ? await completeTask(pendingTask.id, actor) : null;

    res.json({ internship: updatedInternship, task });
  }
);

const siteAccessSchema = z.object({
  badgeNumber: z.string().min(1),
  accessZones: z.array(z.string()).min(1),
});

router.post(
  "/:id/site-access",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.siteAccess),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const parsedBody = siteAccessSchema.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
      return;
    }
    const { id } = parsedParams.data;
    const { badgeNumber, accessZones } = parsedBody.data;

    const internship = await prisma.internship.findUnique({
      where: { id },
      include: { referral: { include: { candidate: true } } },
    });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (internship.status !== InternshipStatus.NDA_SIGNED) {
      res.status(409).json({ error: `Internship is in status ${internship.status}, expected NDA_SIGNED` });
      return;
    }
    if (internship.badgeNumber) {
      res.status(409).json({ error: "Badge/site access has already been set for this internship" });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    const updatedInternship = await withAudit(
      {
        ...actor,
        action: "UPDATE",
        entity: "Internship",
        entityId: internship.id,
        before: { badgeNumber: internship.badgeNumber },
        // accessZones has no dedicated column (badge validity is implicitly
        // actualEnd/proposedEnd per spec) — it's still captured in the audit
        // trail even though only badgeNumber is persisted on the row.
        after: { badgeNumber, accessZones },
      },
      () => prisma.internship.update({ where: { id: internship.id }, data: { badgeNumber } })
    );

    const pendingTask = await prisma.task.findFirst({
      where: { internshipId: internship.id, type: "SITE_ACCESS", completedAt: null },
    });
    const task = pendingTask ? await completeTask(pendingTask.id, actor) : null;

    await sendTemplatedEmail({
      to: internship.referral.candidate.email,
      templateId: "T12_SITE_ACCESS_NOTIFICATION",
      mergeData: { candidateName: internship.referral.candidate.fullName, badgeNumber, accessZones: accessZones.join(", ") },
      internshipId: internship.id,
    });

    res.json({ internship: updatedInternship, task });
  }
);

router.post(
  "/:id/ready-check",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.readyCheck),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }

    if (internship.status === InternshipStatus.READY_TO_START) {
      res.json({ internship, message: "Internship is already READY_TO_START" });
      return;
    }
    if (internship.status !== InternshipStatus.NDA_SIGNED) {
      res.status(409).json({ error: `Internship is in status ${internship.status}, expected NDA_SIGNED` });
      return;
    }

    const missing: string[] = [];
    if (!internship.adAccountActive) missing.push("AD_PROVISION");
    if (!internship.badgeNumber) missing.push("SITE_ACCESS");
    if (missing.length > 0) {
      res.status(409).json({ error: "Internship is not ready to start", missing });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    // Two-hop, both gated: the NDA hard gate (Day 4) re-validates on the way
    // into ACCESS_PROVISIONED and again into READY_TO_START, regardless of
    // whether AD/badge readiness above already confirmed it once.
    await transition({
      entity: "INTERNSHIP",
      entityId: internship.id,
      from: InternshipStatus.NDA_SIGNED,
      to: InternshipStatus.ACCESS_PROVISIONED,
      ...actor,
    });
    const readyInternship = await transition({
      entity: "INTERNSHIP",
      entityId: internship.id,
      from: InternshipStatus.ACCESS_PROVISIONED,
      to: InternshipStatus.READY_TO_START,
      ...actor,
    });

    const mutualConnectTask = await createMutualConnectTask(internship.id, actor);

    const readyPacket = await loadInternshipPacket(internship.id);
    if (readyPacket) {
      await sendTemplatedEmail({
        to: readyPacket.internship.mentor.email,
        templateId: "T13_MENTOR_DOSSIER_NOTICE",
        mergeData: {
          mentorName: readyPacket.internship.mentor.name,
          candidateName: readyPacket.internship.referral.candidate.fullName,
          projectTitle: readyPacket.internship.referral.projectTitle,
          startDate: readyPacket.startDate.toISOString().slice(0, 10),
        },
        internshipId: internship.id,
      });
    }

    res.json({ internship: readyInternship, mutualConnectTask });
  }
);

// Shared by both POST /:id/mutual-connect and ready-check's auto-trigger on
// success, per CLAUDE.md-style "one place, not two" — idempotent so calling
// it twice (once from ready-check, once manually) doesn't duplicate tasks.
async function createMutualConnectTask(
  internshipId: string,
  actor: { actorId: string; role: Role; ip?: string | null }
) {
  const existing = await prisma.task.findFirst({ where: { internshipId, type: "MUTUAL_CONNECT" } });
  if (existing) return existing;

  const packet = await loadInternshipPacket(internshipId);
  if (!packet) return null;

  const dueAt = subtractBusinessDays(packet.startDate, 2);

  const task = await withAudit(
    {
      ...actor,
      action: "CREATE",
      entity: "Task",
      entityId: (created) => created.id,
      after: { type: "MUTUAL_CONNECT", internshipId, dueAt },
    },
    () =>
      prisma.task.create({
        data: {
          internshipId,
          // Task.assigneeRole holds a single Role; MENTOR initiates first
          // contact. Candidate visibility to this task is handled by the
          // T14 email fan-out below, not by an RBAC read on this row.
          type: "MUTUAL_CONNECT",
          assigneeRole: "MENTOR",
          dueAt,
        },
      })
  );

  const { mentor, referral } = packet.internship;
  const startDate = packet.startDate.toISOString().slice(0, 10);
  await Promise.all([
    sendTemplatedEmail({
      to: mentor.email,
      templateId: "T14_MUTUAL_CONNECT_PROMPT",
      mergeData: { recipientName: mentor.name, otherPartyName: referral.candidate.fullName, startDate },
      internshipId,
    }),
    sendTemplatedEmail({
      to: referral.candidate.email,
      templateId: "T14_MUTUAL_CONNECT_PROMPT",
      mergeData: { recipientName: referral.candidate.fullName, otherPartyName: mentor.name, startDate },
      internshipId,
    }),
  ]);

  return task;
}

router.post(
  "/:id/mutual-connect",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.mutualConnect),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };
    const task = await createMutualConnectTask(id, actor);

    res.status(201).json({ task });
  }
);

router.get(
  "/:id/dossier",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.dossier),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const packet = await loadInternshipPacket(id);
    if (!packet) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    const { internship, startDate, endDate } = packet;
    if (internship.mentorId !== req.user!.userId) {
      res.status(403).json({ error: "You are not the assigned mentor for this internship" });
      return;
    }

    const { candidate } = internship.referral;
    const joiningRecord = await prisma.joiningRecord.findUnique({ where: { candidateId: candidate.id } });
    const ndaDocument = await prisma.document.findFirst({
      where: { internshipId: id, type: DocumentType.NDA },
      orderBy: { version: "desc" },
    });

    // Reuse Day 3's masking path rather than building a second one — MENTOR
    // is never in PII_UNMASKED_ROLES so this always comes back masked
    // (****last4 / year-only dob) regardless of the `reveal` argument.
    const maskedPii = maskJoiningRecord(
      { govtIdNumber: joiningRecord?.govtIdNumber ?? null, dob: joiningRecord?.dob ?? null },
      req.user!.role,
      false
    );

    res.json({
      candidate: {
        fullName: candidate.fullName,
        qualification: candidate.qualification,
        institution: candidate.institution,
        skills: candidate.skills,
        city: candidate.city,
        nationality: candidate.nationality,
      },
      project: {
        title: internship.referral.projectTitle,
        overview: internship.referral.projectOverview,
        site: internship.referral.site,
        department: internship.referral.department,
      },
      nonWorkerId: internship.nonWorkerId,
      startDate,
      endDate,
      emergencyContact: joiningRecord
        ? { name: joiningRecord.emergencyContactName, phone: joiningRecord.emergencyContactPhone }
        : null,
      pii: maskedPii,
      nda: {
        status: ndaDocument?.signedAt ? "SIGNED" : "PENDING",
        signedAt: ndaDocument?.signedAt ?? null,
      },
    });
  }
);

router.post(
  "/:id/credentials/issue",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.credentialsIssue),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({
      where: { id },
      include: { referral: { include: { candidate: true } } },
    });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (!internship.adAccountActive || !internship.nonWorkerId) {
      res.status(409).json({ error: "AD account must be provisioned before issuing credentials" });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    const rawToken = generateCredentialToken();
    const tokenHash = hashCredentialToken(rawToken);
    const { username, password } = generateMockAdCredentials(internship.nonWorkerId);
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);

    const credentialToken = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "CredentialToken",
        entityId: (created) => created.id,
        after: { internshipId: id, expiresAt },
      },
      () =>
        prisma.credentialToken.create({
          data: { internshipId: id, tokenHash, mockUsername: username, mockPassword: password, expiresAt },
        })
    );

    // T-11: link only, never the OTP/password itself (FR-13 non-negotiable).
    // No frontend exists yet, so the "link" points at this backend's own
    // redeem route — swap for a real frontend URL once one exists.
    const redeemLink = `${req.protocol}://${req.get("host")}/credentials/redeem/${rawToken}`;
    await sendTemplatedEmail({
      to: internship.referral.candidate.email,
      templateId: "T11_CREDENTIAL_DELIVERY_NOTICE",
      mergeData: { candidateName: internship.referral.candidate.fullName, redeemLink },
      internshipId: internship.id,
    });

    // The raw token itself is still returned in the API response so the
    // caller (IT_ADMIN) can verify delivery — Day 6 does not yet have a
    // frontend to click the emailed link, only the email send + webhook
    // pipeline. Only tokenHash is ever persisted (never plain-text at rest).
    res.status(201).json({
      credentialTokenId: credentialToken.id,
      redeemToken: rawToken,
      expiresAt: credentialToken.expiresAt,
    });
  }
);

router.post(
  "/:id/credentials/reissue",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.credentialsReissue),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }

    const latestToken = await prisma.credentialToken.findFirst({
      where: { internshipId: id },
      orderBy: { createdAt: "desc" },
    });
    if (!latestToken) {
      res.status(409).json({ error: "No credentials have been issued yet for this internship" });
      return;
    }
    if (latestToken.reissueCount >= 3) {
      res.status(409).json({ error: "Maximum of 3 reissues already used for this internship's credentials" });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    // Superseding reissue: the previous token can no longer be redeemed.
    await withAudit(
      {
        ...actor,
        action: "EXPIRE",
        entity: "CredentialToken",
        entityId: latestToken.id,
        before: { expiresAt: latestToken.expiresAt },
        after: { expiresAt: new Date() },
      },
      () => prisma.credentialToken.update({ where: { id: latestToken.id }, data: { expiresAt: new Date() } })
    );

    const rawToken = generateCredentialToken();
    const tokenHash = hashCredentialToken(rawToken);
    const { username, password } = generateMockAdCredentials(internship.nonWorkerId ?? id);
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
    const reissueCount = latestToken.reissueCount + 1;

    const credentialToken = await withAudit(
      {
        ...actor,
        action: "REISSUE",
        entity: "CredentialToken",
        entityId: (created) => created.id,
        after: { internshipId: id, expiresAt, reissueCount },
      },
      () =>
        prisma.credentialToken.create({
          data: { internshipId: id, tokenHash, mockUsername: username, mockPassword: password, expiresAt, reissueCount },
        })
    );

    res.status(201).json({
      credentialTokenId: credentialToken.id,
      redeemToken: rawToken,
      expiresAt: credentialToken.expiresAt,
      reissueCount,
    });
  }
);

router.post(
  "/:id/start-confirm",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.startConfirm),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const packet = await loadInternshipPacket(id);
    if (!packet) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    const { internship, startDate, endDate } = packet;
    if (internship.mentorId !== req.user!.userId) {
      res.status(403).json({ error: "You are not the assigned mentor for this internship" });
      return;
    }
    if (internship.status !== InternshipStatus.READY_TO_START) {
      res.status(409).json({ error: `Internship is in status ${internship.status}, expected READY_TO_START` });
      return;
    }
    if (new Date() < startDate) {
      res.status(409).json({ error: `Cannot confirm start before the internship's start date (${startDate.toISOString()})` });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    const updatedInternship = await transition({
      entity: "INTERNSHIP",
      entityId: internship.id,
      from: InternshipStatus.READY_TO_START,
      to: InternshipStatus.ACTIVE,
      ...actor,
    });

    const finalInternship = internship.actualStart
      ? updatedInternship
      : await withAudit(
          {
            ...actor,
            action: "UPDATE",
            entity: "Internship",
            entityId: internship.id,
            before: { actualStart: internship.actualStart },
            after: { actualStart: new Date() },
          },
          () => prisma.internship.update({ where: { id: internship.id }, data: { actualStart: new Date() } })
        );

    const { mentor, referral } = internship;
    const actualStart = (finalInternship as Internship).actualStart?.toISOString().slice(0, 10) ?? "";
    await Promise.all([
      sendTemplatedEmail({
        to: referral.candidate.email,
        templateId: "T15_START_CONFIRMATION",
        mergeData: { recipientName: referral.candidate.fullName, candidateName: referral.candidate.fullName, projectTitle: referral.projectTitle, actualStart },
        internshipId: internship.id,
      }),
      sendTemplatedEmail({
        to: mentor.email,
        templateId: "T15_START_CONFIRMATION",
        mergeData: { recipientName: mentor.name, candidateName: referral.candidate.fullName, projectTitle: referral.projectTitle, actualStart },
        internshipId: internship.id,
      }),
    ]);

    // Day 6: two CLOSURE_REMINDER tasks at actualEnd-7d and actualEnd-2d,
    // "checked by the sweep" (src/lib/slaSweep.ts sends T19 and completes
    // them once dueAt arrives). Single HR-assigned task per due date — same
    // single-assignee-field precedent as MUTUAL_CONNECT (Day 5); the sweep's
    // email fans out to both mentor and HR regardless of assigneeRole.
    const closureReminderDates = [
      new Date(endDate.getTime() - 7 * 24 * 3600 * 1000),
      new Date(endDate.getTime() - 2 * 24 * 3600 * 1000),
    ];
    await Promise.all(
      closureReminderDates.map((dueAt) =>
        withAudit(
          {
            ...actor,
            action: "CREATE",
            entity: "Task",
            entityId: (created) => created.id,
            after: { type: "CLOSURE_REMINDER", internshipId: internship.id, dueAt },
          },
          () =>
            prisma.task.create({
              data: { internshipId: internship.id, type: "CLOSURE_REMINDER", assigneeRole: "HR", dueAt },
            })
        )
      )
    );

    res.json({ internship: finalInternship });
  }
);

router.post(
  "/:id/mark-delayed",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.markDelayed),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const packet = await loadInternshipPacket(id);
    if (!packet) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    const { internship, startDate } = packet;
    if (internship.status !== InternshipStatus.READY_TO_START) {
      res.status(409).json({ error: `Internship is in status ${internship.status}, expected READY_TO_START` });
      return;
    }
    if (new Date() < startDate) {
      res.status(409).json({ error: `Start date (${startDate.toISOString()}) hasn't passed yet` });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    const updatedInternship = await transition({
      entity: "INTERNSHIP",
      entityId: internship.id,
      from: InternshipStatus.READY_TO_START,
      to: InternshipStatus.DELAYED,
      ...actor,
    });

    // Reminders (day 1/3/5) are conceptual for now — POST /tasks/:id/remind
    // increments delayReminderCount by hand; Day 6's SLA sweep fires them.
    const followUpTask = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "Task",
        entityId: (created) => created.id,
        after: { type: "DELAY_FOLLOWUP", internshipId: internship.id },
      },
      () =>
        prisma.task.create({
          data: {
            internshipId: internship.id,
            type: "DELAY_FOLLOWUP",
            assigneeRole: "HR",
            dueAt: addBusinessDays(new Date(), 1),
          },
        })
    );

    const { mentor, referral } = internship;
    const startDateStr = startDate.toISOString().slice(0, 10);
    await Promise.all([
      sendTemplatedEmail({
        to: referral.candidate.email,
        templateId: "T16_DELAY_NOTIFICATION",
        mergeData: { recipientName: referral.candidate.fullName, candidateName: referral.candidate.fullName, startDate: startDateStr },
        internshipId: internship.id,
      }),
      sendTemplatedEmail({
        to: mentor.email,
        templateId: "T16_DELAY_NOTIFICATION",
        mergeData: { recipientName: mentor.name, candidateName: referral.candidate.fullName, startDate: startDateStr },
        internshipId: internship.id,
      }),
    ]);

    res.json({ internship: updatedInternship, followUpTask });
  }
);

const extendSchema = z.object({
  requestedEndDate: z.coerce.date(),
  justification: z.string().min(1),
});

router.post(
  "/:id/extend",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.extend),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const parsedBody = extendSchema.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
      return;
    }
    const { id } = parsedParams.data;
    const { requestedEndDate, justification } = parsedBody.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (internship.mentorId !== req.user!.userId) {
      res.status(403).json({ error: "You are not the assigned mentor for this internship" });
      return;
    }
    if (internship.status !== InternshipStatus.ACTIVE) {
      res.status(409).json({ error: `Internship is in status ${internship.status}, expected ACTIVE` });
      return;
    }

    const existingPending = await prisma.task.findFirst({
      where: { internshipId: id, type: "EXTENSION_REQUEST", completedAt: null },
    });
    if (existingPending) {
      res.status(409).json({
        error: "An extension request is already pending for this internship",
        taskId: existingPending.id,
      });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    // status stays ACTIVE — the pending-extension marker lives entirely on
    // this task's payload until POST /extensions/:taskId/decide gets both
    // HR and PROGRAM_OWNER approval.
    const payload = {
      requestedEndDate: requestedEndDate.toISOString(),
      justification,
      hrApproved: false,
      hrApprovedBy: null as string | null,
      hrApprovedAt: null as string | null,
      programOwnerApproved: false,
      programOwnerApprovedBy: null as string | null,
      programOwnerApprovedAt: null as string | null,
    };

    const task = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "Task",
        entityId: (created) => created.id,
        after: { type: "EXTENSION_REQUEST", internshipId: id, payload },
      },
      () =>
        prisma.task.create({
          data: {
            internshipId: id,
            type: "EXTENSION_REQUEST",
            assigneeRole: "HR",
            dueAt: addBusinessDays(new Date(), 3),
            payload: payload as Prisma.InputJsonValue,
          },
        })
    );

    res.status(201).json({ task });
  }
);

const reassignMentorSchema = z.object({
  newMentorId: z.string().min(1),
  reason: z.string().min(1),
});

router.post(
  "/:id/reassign-mentor",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.reassignMentor),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const parsedBody = reassignMentorSchema.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
      return;
    }
    const { id } = parsedParams.data;
    const { newMentorId, reason } = parsedBody.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }

    const newMentor = await prisma.user.findUnique({ where: { id: newMentorId } });
    if (!newMentor || newMentor.role !== Role.MENTOR) {
      res.status(400).json({ error: "newMentorId must belong to a user with the MENTOR role" });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    // Only Internship.mentorId moves — this is what dossier access and
    // start-confirm/extend ownership checks key off, so the new mentor gets
    // access immediately with no separate grant step. Old mentor's prior
    // audit history is untouched (audit events are never rewritten).
    const updatedInternship = await withAudit(
      {
        ...actor,
        action: "REASSIGN_MENTOR",
        entity: "Internship",
        entityId: internship.id,
        before: { mentorId: internship.mentorId },
        after: { mentorId: newMentorId, reason },
      },
      () => prisma.internship.update({ where: { id: internship.id }, data: { mentorId: newMentorId } })
    );

    res.json({ internship: updatedInternship });
  }
);

const withdrawSchema = z.object({ reason: z.string().min(1) });

router.post(
  "/:id/withdraw",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.withdraw),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const parsedBody = withdrawSchema.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
      return;
    }
    const { id } = parsedParams.data;
    const { reason } = parsedBody.data;

    const internship = await prisma.internship.findUnique({
      where: { id },
      include: { referral: { include: { candidate: true, referrer: true } } },
    });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }

    const role = req.user!.role;
    if (role === Role.CANDIDATE) {
      const candidate = await findCandidateForUser(req.user!.userId);
      if (!candidate || internship.referral.candidateId !== candidate.id) {
        res.status(403).json({ error: "This is not your internship" });
        return;
      }
    } else if (role === Role.REFERRER) {
      if (internship.referral.referrerId !== req.user!.userId) {
        res.status(403).json({ error: "This is not your referral" });
        return;
      }
    }
    // HR: unrestricted, per PERMISSION_MATRIX.internship.withdraw.

    const actor = { actorId: req.user!.userId, role, ip: req.ip ?? null };

    // WITHDRAWN is an off-ramp allowed from any non-terminal state (see
    // transition.ts) — "from" is simply the internship's current status.
    const updatedInternship = await transition({
      entity: "INTERNSHIP",
      entityId: internship.id,
      from: internship.status,
      to: InternshipStatus.WITHDRAWN,
      ...actor,
      reason,
    });

    await sendTemplatedEmail({
      to: internship.referral.referrer.email,
      templateId: "T22_REJECTION_DECLINE",
      mergeData: {
        recipientName: internship.referral.referrer.name,
        candidateName: internship.referral.candidate.fullName,
        decisionWord: "withdrawn",
        reason,
      },
      internshipId: internship.id,
    });

    res.json({ internship: updatedInternship });
  }
);

const CLOSABLE_STATUSES: InternshipStatus[] = [InternshipStatus.ACTIVE, InternshipStatus.EXTENDED];

router.post(
  "/:id/close",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.close),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const packet = await loadInternshipPacket(id);
    if (!packet) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    const { internship, endDate } = packet;

    if (req.user!.role === Role.MENTOR && internship.mentorId !== req.user!.userId) {
      res.status(403).json({ error: "You are not the assigned mentor for this internship" });
      return;
    }
    if (!CLOSABLE_STATUSES.includes(internship.status)) {
      res.status(409).json({ error: `Internship is in status ${internship.status}, expected ACTIVE or EXTENDED` });
      return;
    }
    if (new Date() < endDate) {
      res.status(409).json({ error: `Cannot close before the internship's end date (${endDate.toISOString()})` });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    const updatedInternship = await transition({
      entity: "INTERNSHIP",
      entityId: internship.id,
      from: internship.status,
      to: InternshipStatus.COMPLETED,
      ...actor,
    });

    // Persist a concrete actualEnd even for internships that were never
    // extended (actualEnd stays null until then) — downstream closure
    // fields (AD_DEACTIVATE/BADGE_RETURN dueAt) need a real date to anchor to.
    const finalInternship = internship.actualEnd
      ? updatedInternship
      : await withAudit(
          {
            ...actor,
            action: "UPDATE",
            entity: "Internship",
            entityId: internship.id,
            before: { actualEnd: internship.actualEnd },
            after: { actualEnd: endDate },
          },
          () => prisma.internship.update({ where: { id: internship.id }, data: { actualEnd: endDate } })
        );

    // Three closure-followup tasks. Due-date formulas here are what
    // src/lib/slaSweep.ts's compliance-critical rules key off of
    // (">24h post-end" and "5 business days post-end" are baked into these
    // dueAt values, not recomputed separately in the sweep).
    const adDeactivateDueAt = new Date(endDate.getTime() + 24 * 3600 * 1000);
    const nonWorkerIdDeactivateDueAt = addBusinessDays(endDate, 1);
    const badgeReturnDueAt = addBusinessDays(endDate, 5);
    // No SLA clock is defined for this in CLAUDE.md — reuses BADGE_RETURN's
    // 5-business-day window as a reasonable default due date.
    const exitChecklistDueAt = badgeReturnDueAt;

    const [adDeactivateTask, nonWorkerIdDeactivateTask, badgeReturnTask, exitChecklistTask] = await Promise.all([
      withAudit(
        {
          ...actor,
          action: "CREATE",
          entity: "Task",
          entityId: (created) => created.id,
          after: { type: "AD_DEACTIVATE", internshipId: internship.id, dueAt: adDeactivateDueAt },
        },
        () =>
          prisma.task.create({
            data: { internshipId: internship.id, type: "AD_DEACTIVATE", assigneeRole: "IT_ADMIN", dueAt: adDeactivateDueAt },
          })
      ),
      withAudit(
        {
          ...actor,
          action: "CREATE",
          entity: "Task",
          entityId: (created) => created.id,
          after: { type: "NON_WORKER_ID_DEACTIVATE", internshipId: internship.id, dueAt: nonWorkerIdDeactivateDueAt },
        },
        () =>
          prisma.task.create({
            data: {
              internshipId: internship.id,
              type: "NON_WORKER_ID_DEACTIVATE",
              assigneeRole: "HR",
              dueAt: nonWorkerIdDeactivateDueAt,
            },
          })
      ),
      withAudit(
        {
          ...actor,
          action: "CREATE",
          entity: "Task",
          entityId: (created) => created.id,
          after: { type: "BADGE_RETURN", internshipId: internship.id, dueAt: badgeReturnDueAt },
        },
        () =>
          prisma.task.create({
            data: { internshipId: internship.id, type: "BADGE_RETURN", assigneeRole: "ADMIN_SECURITY", dueAt: badgeReturnDueAt },
          })
      ),
      withAudit(
        {
          ...actor,
          action: "CREATE",
          entity: "Task",
          entityId: (created) => created.id,
          after: { type: "EXIT_CHECKLIST", internshipId: internship.id, dueAt: exitChecklistDueAt },
        },
        () =>
          prisma.task.create({
            data: {
              internshipId: internship.id,
              type: "EXIT_CHECKLIST",
              assigneeRole: "HR",
              dueAt: exitChecklistDueAt,
              checklist: buildExitChecklist(internship) as Prisma.InputJsonValue,
            },
          })
      ),
    ]);

    await sendTemplatedEmail({
      to: internship.referral.candidate.email,
      templateId: "T20_CERTIFICATE_REQUEST_AVAILABLE",
      mergeData: { candidateName: internship.referral.candidate.fullName, projectTitle: internship.referral.projectTitle },
      internshipId: internship.id,
    });

    res.json({ internship: finalInternship, adDeactivateTask, nonWorkerIdDeactivateTask, badgeReturnTask, exitChecklistTask });
  }
);

router.post(
  "/:id/ad-deactivate",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.adDeactivate),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (!internship.adAccountActive) {
      res.status(409).json({ error: "AD account is not currently active for this internship" });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    await adAdapter.deactivate(internship.adAccountRef ?? "");

    const updatedInternship = await withAudit(
      {
        ...actor,
        action: "UPDATE",
        entity: "Internship",
        entityId: internship.id,
        before: { adAccountActive: internship.adAccountActive, adDeactivatedAt: internship.adDeactivatedAt },
        after: { adAccountActive: false, adDeactivatedAt: new Date() },
      },
      () =>
        prisma.internship.update({
          where: { id: internship.id },
          data: { adAccountActive: false, adDeactivatedAt: new Date() },
        })
    );

    const pendingTask = await prisma.task.findFirst({
      where: { internshipId: internship.id, type: "AD_DEACTIVATE", completedAt: null },
    });
    const task = pendingTask ? await completeTask(pendingTask.id, actor) : null;

    res.json({ internship: updatedInternship, task });
  }
);

router.post(
  "/:id/non-worker-id-deactivate",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.nonWorkerIdDeactivate),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (internship.nonWorkerIdDeactivatedAt) {
      res.status(409).json({ error: "Non-Worker ID has already been deactivated for this internship" });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    const updatedInternship = await withAudit(
      {
        ...actor,
        action: "UPDATE",
        entity: "Internship",
        entityId: internship.id,
        before: { nonWorkerIdDeactivatedAt: internship.nonWorkerIdDeactivatedAt },
        after: { nonWorkerIdDeactivatedAt: new Date() },
      },
      () => prisma.internship.update({ where: { id: internship.id }, data: { nonWorkerIdDeactivatedAt: new Date() } })
    );

    const pendingTask = await prisma.task.findFirst({
      where: { internshipId: internship.id, type: "NON_WORKER_ID_DEACTIVATE", completedAt: null },
    });
    const task = pendingTask ? await completeTask(pendingTask.id, actor) : null;

    res.json({ internship: updatedInternship, task });
  }
);

router.post(
  "/:id/badge-return",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.badgeReturn),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (internship.badgeReturnedAt) {
      res.status(409).json({ error: "Badge has already been recorded as returned for this internship" });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    const updatedInternship = await withAudit(
      {
        ...actor,
        action: "UPDATE",
        entity: "Internship",
        entityId: internship.id,
        before: { badgeReturnedAt: internship.badgeReturnedAt },
        after: { badgeReturnedAt: new Date() },
      },
      () => prisma.internship.update({ where: { id: internship.id }, data: { badgeReturnedAt: new Date() } })
    );

    const pendingTask = await prisma.task.findFirst({
      where: { internshipId: internship.id, type: "BADGE_RETURN", completedAt: null },
    });
    const task = pendingTask ? await completeTask(pendingTask.id, actor) : null;

    res.json({ internship: updatedInternship, task });
  }
);

router.post(
  "/:id/close-check",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.closeCheck),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }

    if (internship.status === InternshipStatus.CLOSED) {
      res.json({ internship, message: "Internship is already CLOSED" });
      return;
    }
    if (internship.status !== InternshipStatus.COMPLETED) {
      res.status(409).json({ error: `Internship is in status ${internship.status}, expected COMPLETED` });
      return;
    }

    const missing: string[] = [];
    if (internship.adAccountActive) missing.push("AD_DEACTIVATE");
    if (!internship.nonWorkerIdDeactivatedAt) missing.push("NON_WORKER_ID_DEACTIVATE");
    if (!internship.badgeReturnedAt) missing.push("BADGE_RETURN");
    if (missing.length > 0) {
      // Nested under `details` to match the codebase's existing 400
      // validation-error convention (`{ error, details }`) — the frontend's
      // shared ApiError only surfaces `details`, not arbitrary top-level
      // fields, so a bare `missing` key here would be unreachable from
      // Frontend Day F5's Closure page, the first real consumer of this list.
      res.status(409).json({ error: "Internship is not ready to close", details: { missing } });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    const closedInternship = await transition({
      entity: "INTERNSHIP",
      entityId: internship.id,
      from: InternshipStatus.COMPLETED,
      to: InternshipStatus.CLOSED,
      ...actor,
    });

    res.json({ internship: closedInternship });
  }
);

const mentorConfirmCompletionSchema = z.object({
  satisfactory: z.boolean(),
  remark: z.string().max(500),
});

router.post(
  "/:id/mentor-confirm-completion",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.mentorConfirmCompletion),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    const parsedBody = mentorConfirmCompletionSchema.safeParse(req.body);
    if (!parsedParams.success || !parsedBody.success) {
      res.status(400).json({ error: "Invalid input", details: parsedBody.success ? undefined : parsedBody.error.flatten() });
      return;
    }
    const { id } = parsedParams.data;
    const { satisfactory, remark } = parsedBody.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (internship.mentorId !== req.user!.userId) {
      res.status(403).json({ error: "You are not the assigned mentor for this internship" });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    const updatedInternship = await withAudit(
      {
        ...actor,
        action: "MENTOR_CONFIRM_COMPLETION",
        entity: "Internship",
        entityId: internship.id,
        before: { mentorCompletionConfirmedAt: internship.mentorCompletionConfirmedAt },
        after: { mentorCompletionConfirmedAt: new Date(), mentorCompletionSatisfactory: satisfactory, mentorCompletionRemark: remark },
      },
      () =>
        prisma.internship.update({
          where: { id: internship.id },
          data: {
            mentorCompletionConfirmedAt: new Date(),
            mentorCompletionSatisfactory: satisfactory,
            mentorCompletionRemark: remark,
          },
        })
    );

    res.json({ internship: updatedInternship });
  }
);

router.post(
  "/:id/certificate-request",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.certificateRequest),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const candidate = await findCandidateForUser(req.user!.userId);
    if (!candidate) {
      res.status(404).json({ error: "No candidate profile is linked to this account" });
      return;
    }

    const internship = await prisma.internship.findUnique({ where: { id }, include: { referral: true } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (internship.referral.candidateId !== candidate.id) {
      res.status(403).json({ error: "This is not your internship" });
      return;
    }
    if (internship.status !== InternshipStatus.COMPLETED) {
      res.status(409).json({ error: `Internship is in status ${internship.status}, expected COMPLETED` });
      return;
    }
    if (!internship.mentorCompletionConfirmedAt) {
      res.status(409).json({ error: "Mentor completion confirmation is required before requesting a certificate" });
      return;
    }
    if (internship.certificateRequestedAt) {
      res.status(409).json({ error: "Certificate has already been requested for this internship" });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    const updatedInternship = await withAudit(
      {
        ...actor,
        action: "CERTIFICATE_REQUEST",
        entity: "Internship",
        entityId: internship.id,
        before: { certificateRequestedAt: null },
        after: { certificateRequestedAt: new Date() },
      },
      () => prisma.internship.update({ where: { id: internship.id }, data: { certificateRequestedAt: new Date() } })
    );

    res.json({ internship: updatedInternship });
  }
);

router.post(
  "/:id/certificate-request/approve",
  authenticate,
  requireRole(...PERMISSION_MATRIX.internship.certificateRequestApprove),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (!internship.certificateRequestedAt) {
      res.status(409).json({ error: "No certificate request is pending for this internship" });
      return;
    }
    if (internship.certificateApprovedAt) {
      res.status(409).json({ error: "Certificate request has already been approved" });
      return;
    }

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    const updatedInternship = await withAudit(
      {
        ...actor,
        action: "CERTIFICATE_REQUEST_APPROVE",
        entity: "Internship",
        entityId: internship.id,
        before: { certificateApprovedAt: null },
        after: { certificateApprovedAt: new Date(), certificateApprovedBy: req.user!.userId },
      },
      () =>
        prisma.internship.update({
          where: { id: internship.id },
          data: { certificateApprovedAt: new Date(), certificateApprovedBy: req.user!.userId },
        })
    );

    res.json({ internship: updatedInternship });
  }
);

router.post(
  "/:id/certificate/generate",
  authenticate,
  requireRole(...PERMISSION_MATRIX.certificate.issue),
  async (req, res) => {
    const parsedParams = z.object({ id: z.string().min(1) }).safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { id } = parsedParams.data;

    const internship = await prisma.internship.findUnique({ where: { id } });
    if (!internship) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }
    if (!internship.mentorCompletionConfirmedAt) {
      res.status(409).json({ error: "Mentor completion confirmation is required before generating a certificate" });
      return;
    }
    if (!internship.certificateApprovedAt) {
      res.status(409).json({ error: "Certificate request must be approved before generating" });
      return;
    }
    const existingCertificate = await prisma.certificate.findUnique({ where: { internshipId: id } });
    if (existingCertificate) {
      res.status(409).json({ error: "Certificate has already been generated for this internship", certificate: existingCertificate });
      return;
    }

    const packet = await loadInternshipPacket(id);
    if (!packet) {
      res.status(404).json({ error: "Internship not found" });
      return;
    }

    const year = new Date().getFullYear();
    const countThisYear = await prisma.certificate.count({ where: { referenceNumber: { startsWith: `CERT-${year}-` } } });
    const referenceNumber = `CERT-${year}-${String(countThisYear + 1).padStart(4, "0")}`;

    const certPdf = await generateCertificatePdf({
      candidateName: packet.internship.referral.candidate.fullName,
      projectTitle: packet.internship.referral.projectTitle,
      mentorName: packet.internship.mentor.name,
      startDate: packet.startDate,
      endDate: packet.endDate,
      referenceNumber,
    });
    const { storageUri, sha256 } = await saveGeneratedFile(id, certPdf, `certificate-${referenceNumber}.pdf`);

    const actor = { actorId: req.user!.userId, role: req.user!.role, ip: req.ip ?? null };

    const certificate = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "Certificate",
        entityId: (created) => created.id,
        after: { internshipId: id, referenceNumber, sha256 },
      },
      () => prisma.certificate.create({ data: { internshipId: id, referenceNumber, storageUri } })
    );

    const existingDocCount = await prisma.document.count({ where: { internshipId: id, type: DocumentType.CERTIFICATE } });
    const document = await withAudit(
      {
        ...actor,
        action: "CREATE",
        entity: "Document",
        entityId: (created) => created.id,
        after: { type: "CERTIFICATE", internshipId: id, sha256, version: existingDocCount + 1 },
      },
      () =>
        prisma.document.create({
          data: { internshipId: id, type: DocumentType.CERTIFICATE, storageUri, sha256, version: existingDocCount + 1 },
        })
    );

    await sendTemplatedEmail({
      to: packet.internship.referral.candidate.email,
      templateId: "T21_CERTIFICATE_ISSUED",
      mergeData: {
        candidateName: packet.internship.referral.candidate.fullName,
        projectTitle: packet.internship.referral.projectTitle,
        referenceNumber,
      },
      internshipId: id,
    });

    res.status(201).json({ certificate, document });
  }
);

export default router;
