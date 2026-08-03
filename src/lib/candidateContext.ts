import { prisma } from "./prisma";

export async function findCandidateForUser(userId: string) {
  return prisma.candidate.findUnique({ where: { userId } });
}

/** Most recent internship reachable from a candidate via their referral chain. */
export async function findActiveInternshipForCandidate(candidateId: string) {
  return prisma.internship.findFirst({
    where: { referral: { candidateId } },
    orderBy: { createdAt: "desc" },
  });
}
