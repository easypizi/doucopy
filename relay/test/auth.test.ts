import { describe, expect, it } from "vitest";
import { bearerToken, createTokenService, PEER_NAME_PATTERN } from "../src/auth.js";

const SECRET = "test-secret-0123456789abcdef";

describe("createTokenService", () => {
  it("issues and verifies a peer token", () => {
    const svc = createTokenService(SECRET);
    const token = svc.issuePeerToken("ivan-mbp");
    expect(token.startsWith("al1.")).toBe(true);
    expect(svc.verifyPeerToken(token)).toBe("ivan-mbp");
  });

  it("rejects a token signed with a different secret", () => {
    const other = createTokenService("another-secret-0123456789");
    const token = other.issuePeerToken("ivan-mbp");
    expect(createTokenService(SECRET).verifyPeerToken(token)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    const svc = createTokenService(SECRET);
    expect(svc.verifyPeerToken("")).toBeNull();
    expect(svc.verifyPeerToken("al1.onlytwo")).toBeNull();
    expect(svc.verifyPeerToken("nope.x.y")).toBeNull();
  });

  it("rejects revoked peers", () => {
    const svc = createTokenService(SECRET, "mallory, eve");
    const token = svc.issuePeerToken("mallory");
    expect(svc.verifyPeerToken(token)).toBeNull();
    expect(svc.isRevoked("eve")).toBe(true);
    expect(svc.isRevoked("ivan")).toBe(false);
  });

  it("issues and verifies an invite", () => {
    const svc = createTokenService(SECRET);
    const { invite, expires_at } = svc.issueInvite(1);
    expect(invite.startsWith("ali1.")).toBe(true);
    expect(expires_at).toBeGreaterThan(Date.now());
    expect(svc.verifyInvite(invite)).toBe(true);
  });

  it("rejects an expired invite", () => {
    const svc = createTokenService(SECRET);
    const { invite } = svc.issueInvite(-1);
    expect(svc.verifyInvite(invite)).toBe(false);
  });

  it("rejects a tampered invite", () => {
    const svc = createTokenService(SECRET);
    const { invite } = svc.issueInvite(1);
    const parts = invite.split(".");
    parts[1] = String(Number(parts[1]) + 3_600_000);
    expect(svc.verifyInvite(parts.join("."))).toBe(false);
  });

  it("requires a sufficiently long secret", () => {
    expect(() => createTokenService("short")).toThrow();
  });
});

describe("PEER_NAME_PATTERN", () => {
  it("accepts safe names and rejects unsafe ones", () => {
    expect(PEER_NAME_PATTERN.test("ivan-mbp.2")).toBe(true);
    expect(PEER_NAME_PATTERN.test("with space")).toBe(false);
    expect(PEER_NAME_PATTERN.test("")).toBe(false);
    expect(PEER_NAME_PATTERN.test("a".repeat(65))).toBe(false);
  });
});

describe("bearerToken", () => {
  it("extracts the token from an Authorization header", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
  });
});
