import { describe, expect, it } from "vitest";
import { bearerToken, loadPeersFromEnv } from "../src/auth.js";

describe("loadPeersFromEnv", () => {
  it("maps tokens to lowercase peer names", () => {
    const registry = loadPeersFromEnv({
      PEER_TOKEN_PERSONAL: "aaa",
      PEER_TOKEN_WORK: "bbb",
    } as NodeJS.ProcessEnv);
    expect(registry.peers().sort()).toEqual(["personal", "work"]);
    expect(registry.peerForToken("aaa")).toBe("personal");
    expect(registry.peerForToken("bbb")).toBe("work");
    expect(registry.peerForToken("ccc")).toBeNull();
  });

  it("throws when no peers configured", () => {
    expect(() => loadPeersFromEnv({} as NodeJS.ProcessEnv)).toThrow();
  });
});

describe("bearerToken", () => {
  it("extracts the token from an Authorization header", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
  });
});
