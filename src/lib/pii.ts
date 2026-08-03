import { Role } from "@prisma/client";

export const PII_UNMASKED_ROLES: Role[] = [Role.HR, Role.LEGAL];

export function canViewUnmaskedPii(role: Role): boolean {
  return PII_UNMASKED_ROLES.includes(role);
}

export function maskGovtId(value: string | null): string | null {
  if (!value) return value;
  const last4 = value.slice(-4);
  return `****${last4}`;
}

export function maskDobToYear(value: Date | null): string | null {
  if (!value) return null;
  return String(value.getFullYear());
}

interface JoiningRecordPiiFields {
  govtIdNumber: string | null;
  dob: Date | null;
}

/** Returns a copy with govtIdNumber/dob masked unless the role is HR/LEGAL. */
export function maskJoiningRecord<T extends JoiningRecordPiiFields>(
  record: T,
  role: Role,
  reveal: boolean
): Omit<T, "govtIdNumber" | "dob"> & { govtIdNumber: string | null; dob: string | Date | null } {
  if (reveal && canViewUnmaskedPii(role)) {
    return record;
  }
  return { ...record, govtIdNumber: maskGovtId(record.govtIdNumber), dob: maskDobToYear(record.dob) };
}
