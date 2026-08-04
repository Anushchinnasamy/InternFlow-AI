import { prisma } from "./prisma";

/**
 * Loads an Internship with everything the NDA gate and document generators
 * need (candidate, mentor, referral). startDate/endDate prefer the actual
 * dates once set, falling back to the referral's proposed dates beforehand
 * — this is the one place that fallback is decided so the gate check, the
 * NDA generator, and the confirmation letter can't disagree with each other.
 */
export async function loadInternshipPacket(internshipId: string) {
  const internship = await prisma.internship.findUnique({
    where: { id: internshipId },
    include: { referral: { include: { candidate: true } }, mentor: true },
  });
  if (!internship) return null;

  const startDate = internship.actualStart ?? internship.referral.proposedStart;
  const endDate = internship.actualEnd ?? internship.referral.proposedEnd;

  return { internship, startDate, endDate };
}

export type InternshipPacket = NonNullable<Awaited<ReturnType<typeof loadInternshipPacket>>>;
