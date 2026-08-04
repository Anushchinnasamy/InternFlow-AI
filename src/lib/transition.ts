// Single choke point for Referral/Internship status changes. Per CLAUDE.md
// rule 5, no other code path may write to `status` directly — every status
// change goes through transition(), which validates the edge against the
// state graph and audits the change via withAudit.

import { DocumentType, Internship, InternshipStatus, Referral, Role } from "@prisma/client";
import { prisma } from "./prisma";
import { withAudit } from "./withAudit";
import { loadInternshipPacket } from "./internshipContext";

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

const S = InternshipStatus;

const LINEAR_CHAIN: InternshipStatus[] = [
  S.DRAFT,
  S.SUBMITTED,
  S.MENTOR_REVIEW,
  S.HR_REVIEW,
  S.APPROVED,
  S.JOINING_PENDING,
  S.JOINING_SUBMITTED,
  S.VERIFIED,
  S.ID_ISSUED,
  S.NDA_PENDING,
  S.NDA_SIGNED,
  S.ACCESS_PROVISIONED,
  S.READY_TO_START,
  S.ACTIVE,
  S.COMPLETED,
  S.CLOSED,
];

const OFF_RAMPS: InternshipStatus[] = [S.REJECTED, S.WITHDRAWN, S.EXPIRED, S.CANCELLED];
const TERMINAL_STATES: InternshipStatus[] = [S.CLOSED, ...OFF_RAMPS];

function buildAllowedTransitions(): Record<InternshipStatus, InternshipStatus[]> {
  const allowed = {} as Record<InternshipStatus, InternshipStatus[]>;

  for (const status of Object.values(S)) {
    allowed[status] = [];
  }

  for (let i = 0; i < LINEAR_CHAIN.length - 1; i++) {
    allowed[LINEAR_CHAIN[i]].push(LINEAR_CHAIN[i + 1]);
  }

  allowed[S.ACTIVE].push(S.EXTENDED);
  allowed[S.EXTENDED].push(S.COMPLETED);
  // Day 5: a no-show past the start date branches off READY_TO_START into
  // DELAYED instead of continuing straight to ACTIVE. Resuming from DELAYED
  // isn't built yet — no endpoint reaches it, so no forward edge exists here.
  allowed[S.READY_TO_START].push(S.DELAYED);

  for (const status of Object.values(S)) {
    if (!TERMINAL_STATES.includes(status)) {
      allowed[status].push(...OFF_RAMPS);
    }
  }

  return allowed;
}

const ALLOWED_TRANSITIONS = buildAllowedTransitions();

// CLAUDE.md non-negotiable rule 1: internship status can never reach
// NDA_SIGNED or anything after it unless a Document(type: NDA) exists with
// signedAt set at least 1 day before the internship's start date. This is
// enforced here — the one shared transition() choke point — specifically so
// no future endpoint (Day 5's access provisioning included) can reach these
// statuses through a path that forgot to check. Do not remove or weaken
// this check; do not move it into a single endpoint instead.
const NDA_GATE_STATUSES = new Set<InternshipStatus>([
  ...LINEAR_CHAIN.slice(LINEAR_CHAIN.indexOf(S.NDA_SIGNED)),
  S.EXTENDED,
  S.DELAYED,
]);

async function assertNdaGate(internshipId: string, to: InternshipStatus): Promise<void> {
  if (!NDA_GATE_STATUSES.has(to)) return;

  const packet = await loadInternshipPacket(internshipId);
  if (!packet) {
    throw new TransitionError(`Internship ${internshipId} not found for NDA gate check`);
  }

  const signedNda = await prisma.document.findFirst({
    where: { internshipId, type: DocumentType.NDA, signedAt: { not: null } },
    orderBy: { version: "desc" },
  });

  const deadline = new Date(packet.startDate);
  deadline.setDate(deadline.getDate() - 1);

  if (!signedNda?.signedAt || signedNda.signedAt > deadline) {
    throw new TransitionError(
      `Internship ${internshipId} cannot reach ${to}: no NDA signed at least 1 day before the internship start date`
    );
  }
}

export type TransitionEntity = "REFERRAL" | "INTERNSHIP";

export interface TransitionParams {
  entity: TransitionEntity;
  entityId: string;
  from: InternshipStatus;
  to: InternshipStatus;
  actorId: string;
  role: Role;
  ip?: string | null;
  reason?: string;
}

export async function transition(params: TransitionParams): Promise<Referral | Internship> {
  const { entity, entityId, from, to, actorId, role, ip, reason } = params;

  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new TransitionError(`Illegal transition for ${entity} ${entityId}: ${from} -> ${to}`);
  }

  const current =
    entity === "REFERRAL"
      ? await prisma.referral.findUnique({ where: { id: entityId } })
      : await prisma.internship.findUnique({ where: { id: entityId } });

  if (!current) {
    throw new TransitionError(`${entity} ${entityId} not found`);
  }
  if (current.status !== from) {
    throw new TransitionError(
      `${entity} ${entityId} is in status ${current.status}, not the expected ${from}`
    );
  }

  if (entity === "INTERNSHIP") {
    await assertNdaGate(entityId, to);
  }

  const mutation: () => Promise<Referral | Internship> = () =>
    entity === "REFERRAL"
      ? prisma.referral.update({ where: { id: entityId }, data: { status: to } })
      : prisma.internship.update({ where: { id: entityId }, data: { status: to } });

  return withAudit<Referral | Internship>(
    {
      actorId,
      role,
      action: "TRANSITION",
      entity: entity === "REFERRAL" ? "Referral" : "Internship",
      entityId,
      before: { status: from },
      after: { status: to, ...(reason ? { reason } : {}) },
      ip,
    },
    mutation
  );
}
