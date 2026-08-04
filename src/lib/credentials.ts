import { randomBytes, createHash } from "crypto";

/** Raw single-use redemption token — this is the bearer secret handed to the candidate. */
export function generateCredentialToken(): string {
  return randomBytes(32).toString("hex");
}

/** Only the hash is ever stored, per FR-13's "never plain-text" requirement for the token itself. */
export function hashCredentialToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface MockAdCredentials {
  username: string;
  password: string;
}

/** ManualADAdapter's fake AD login for the candidate — see CredentialToken schema comment. */
export function generateMockAdCredentials(nonWorkerId: string): MockAdCredentials {
  return {
    username: `${nonWorkerId.toLowerCase()}@ad.internflow.local`,
    password: randomBytes(9).toString("base64url"),
  };
}
