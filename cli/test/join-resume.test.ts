import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearDraft,
  readDraft,
  readExistingConnection,
  writeDraft,
} from "../src/join.js";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "doucopy-join-"));
}

function writeConfig(home: string, config: Record<string, unknown>): void {
  const dir = path.join(home, ".agent-link");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
}

describe("readExistingConnection", () => {
  it("returns null when config.json is absent", () => {
    expect(readExistingConnection(makeHome())).toBeNull();
  });

  it("returns the (relayUrl, peer, token) triple from a valid config", () => {
    const home = makeHome();
    writeConfig(home, { relay_url: "https://r.example", self_peer: "mac", token: "tok1" });
    expect(readExistingConnection(home)).toEqual({
      relayUrl: "https://r.example",
      peer: "mac",
      token: "tok1",
    });
  });

  it("returns null when a required field is missing", () => {
    const home = makeHome();
    writeConfig(home, { relay_url: "https://r.example", self_peer: "mac" });
    expect(readExistingConnection(home)).toBeNull();
  });

  it("returns null when the config file is not valid JSON", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".agent-link"), { recursive: true });
    writeFileSync(path.join(home, ".agent-link/config.json"), "not json");
    expect(readExistingConnection(home)).toBeNull();
  });
});

describe("join draft", () => {
  it("roundtrips relay URL and invite through write and read", () => {
    const home = makeHome();
    writeDraft(home, "https://r.example", "ali1.eyJ", 1_000);
    const draft = readDraft(home, 2_000);
    expect(draft).toEqual({ relayUrl: "https://r.example", invite: "ali1.eyJ" });
  });

  it("returns null and deletes a draft older than 48h", () => {
    const home = makeHome();
    writeDraft(home, "https://r.example", "ali1.eyJ", 0);
    const stale = 49 * 60 * 60 * 1000;
    expect(readDraft(home, stale)).toBeNull();
    expect(existsSync(path.join(home, ".agent-link/join-draft.json"))).toBe(false);
  });

  it("returns null and deletes a draft with bad shape", () => {
    const home = makeHome();
    mkdirSync(path.join(home, ".agent-link"), { recursive: true });
    writeFileSync(path.join(home, ".agent-link/join-draft.json"), "{}");
    expect(readDraft(home)).toBeNull();
    expect(existsSync(path.join(home, ".agent-link/join-draft.json"))).toBe(false);
  });

  it("clearDraft is a no-op when the file is not present", () => {
    const home = makeHome();
    expect(() => clearDraft(home)).not.toThrow();
  });

  it("clearDraft removes an existing draft", () => {
    const home = makeHome();
    writeDraft(home, "https://r.example", "ali1.eyJ");
    clearDraft(home);
    expect(existsSync(path.join(home, ".agent-link/join-draft.json"))).toBe(false);
  });
});
