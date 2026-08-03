import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const SALT_ROUNDS = 12;
const SEED_PASSWORD = "Password123!";

const SEED_USERS: { email: string; name: string; role: Role }[] = [
  { email: "referrer@internflow.dev", name: "Riya Referrer", role: Role.REFERRER },
  { email: "candidate@internflow.dev", name: "Cody Candidate", role: Role.CANDIDATE },
  { email: "mentor@internflow.dev", name: "Mia Mentor", role: Role.MENTOR },
  { email: "hr@internflow.dev", name: "Hana HR", role: Role.HR },
  { email: "programowner@internflow.dev", name: "Priya ProgramOwner", role: Role.PROGRAM_OWNER },
  { email: "adminsecurity@internflow.dev", name: "Alex AdminSecurity", role: Role.ADMIN_SECURITY },
  { email: "itadmin@internflow.dev", name: "Ivan ITAdmin", role: Role.IT_ADMIN },
  { email: "legal@internflow.dev", name: "Lena Legal", role: Role.LEGAL },
  { email: "sysadmin@internflow.dev", name: "Sam SysAdmin", role: Role.SYSADMIN },
];

async function main() {
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, SALT_ROUNDS);

  for (const seedUser of SEED_USERS) {
    await prisma.user.upsert({
      where: { email: seedUser.email },
      update: {},
      create: { ...seedUser, passwordHash },
    });
  }

  console.log(`Seeded ${SEED_USERS.length} users, one per role.`);
  console.log(`All seed users share password: ${SEED_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
