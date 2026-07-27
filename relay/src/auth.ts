import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PEER_PREFIX = "al1";
const INVITE_PREFIX = "ali1";
const DEFAULT_INVITE_TTL_HOURS = 72;
const MIN_SECRET_LENGTH = 16;

export const PEER_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface TokenService {
  issuePeerToken(name: string): string;
  verifyPeerToken(token: string): string | null;
  issueInvite(ttlHours?: number): { invite: string; expires_at: number };
  verifyInvite(invite: string): boolean;
  isRevoked(name: string): boolean;
}

function hmac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function signatureMatches(givenBase64url: string, expected: Buffer): boolean {
  const given = Buffer.from(givenBase64url, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createTokenService(secret: string, revokedCsv = ""): TokenService {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`RELAY_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const revoked = new Set(
    revokedCsv.split(",").map((name) => name.trim()).filter(Boolean),
  );
  return {
    issuePeerToken(name: string): string {
      const nameB64 = Buffer.from(name, "utf8").toString("base64url");
      const sig = hmac(secret, `peer:${name}`).toString("base64url");
      return `${PEER_PREFIX}.${nameB64}.${sig}`;
    },
    verifyPeerToken(token: string): string | null {
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== PEER_PREFIX) return null;
      const name = Buffer.from(parts[1], "base64url").toString("utf8");
      if (!PEER_NAME_PATTERN.test(name)) return null;
      if (!signatureMatches(parts[2], hmac(secret, `peer:${name}`))) return null;
      if (revoked.has(name)) return null;
      return name;
    },
    issueInvite(ttlHours = DEFAULT_INVITE_TTL_HOURS) {
      const expires_at = Date.now() + ttlHours * 3_600_000;
      const nonce = randomBytes(8).toString("base64url");
      const sig = hmac(secret, `invite:${expires_at}:${nonce}`).toString("base64url");
      return { invite: `${INVITE_PREFIX}.${expires_at}.${nonce}.${sig}`, expires_at };
    },
    verifyInvite(invite: string): boolean {
      const parts = invite.split(".");
      if (parts.length !== 4 || parts[0] !== INVITE_PREFIX) return false;
      const expires = Number(parts[1]);
      if (!Number.isFinite(expires) || expires <= Date.now()) return false;
      return signatureMatches(parts[3], hmac(secret, `invite:${parts[1]}:${parts[2]}`));
    },
    isRevoked: (name: string) => revoked.has(name),
  };
}

export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}
