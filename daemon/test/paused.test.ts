import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPaused, listPaused, pausePeer, pausedUntil, resumePeer } from "../src/paused.js";

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "agent-link-paused-")), "paused.json");
}

describe("paused module", () => {
  it("is not paused by default", () => {
    expect(isPaused("work", tmpFile())).toBe(false);
  });

  it("pausePeer with null blocks indefinitely", () => {
    const file = tmpFile();
    pausePeer("work", null, file);
    expect(isPaused("work", file)).toBe(true);
    expect(pausedUntil("work", file)).toBeNull();
  });

  it("expires an until_ms in the past", () => {
    const file = tmpFile();
    pausePeer("work", Date.now() - 1000, file);
    expect(isPaused("work", file)).toBe(false);
    expect(pausedUntil("work", file)).toBeUndefined();
  });

  it("keeps an until_ms in the future", () => {
    const file = tmpFile();
    const until = Date.now() + 60_000;
    pausePeer("work", until, file);
    expect(isPaused("work", file)).toBe(true);
    expect(pausedUntil("work", file)).toBe(until);
  });

  it("resumePeer removes the entry", () => {
    const file = tmpFile();
    pausePeer("work", null, file);
    expect(resumePeer("work", file)).toBe(true);
    expect(isPaused("work", file)).toBe(false);
    expect(resumePeer("work", file)).toBe(false);
  });

  it("listPaused hides expired entries and sorts by peer", () => {
    const file = tmpFile();
    pausePeer("zeta", null, file);
    pausePeer("alpha", Date.now() + 60_000, file);
    pausePeer("expired", Date.now() - 1000, file);
    const entries = listPaused(file);
    expect(entries.map((e) => e.peer)).toEqual(["alpha", "zeta"]);
  });

  it("recovers from a corrupt file", () => {
    const file = tmpFile();
    writeFileSync(file, "not json");
    expect(isPaused("work", file)).toBe(false);
    pausePeer("work", null, file);
    expect(isPaused("work", file)).toBe(true);
  });
});
