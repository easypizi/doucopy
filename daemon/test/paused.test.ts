import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

  it("readers never mutate the file, even when entries have expired", () => {
    const file = tmpFile();
    // Pause "work" indefinitely so the entry is real.
    pausePeer("work", null, file);
    // Now write an expired entry by hand alongside it.
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, number | null>;
    raw["stale"] = Date.now() - 5000;
    writeFileSync(file, JSON.stringify(raw));
    const mtimeBefore = statSync(file).mtimeMs;
    // Read-only operations must not rewrite the file.
    expect(isPaused("stale", file)).toBe(false);
    expect(isPaused("work", file)).toBe(true);
    expect(pausedUntil("stale", file)).toBeUndefined();
    expect(listPaused(file).map((e) => e.peer)).toEqual(["work"]);
    const mtimeAfter = statSync(file).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
    // The stale entry is still on disk — writers get to clean it up.
    const stillThere = JSON.parse(readFileSync(file, "utf8")) as Record<string, number | null>;
    expect("stale" in stillThere).toBe(true);
  });

  it("writers prune expired entries", () => {
    const file = tmpFile();
    pausePeer("work", null, file);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, number | null>;
    raw["stale"] = Date.now() - 5000;
    writeFileSync(file, JSON.stringify(raw));
    // A pausePeer for a different peer should sweep the stale one out.
    pausePeer("other", null, file);
    const cleaned = JSON.parse(readFileSync(file, "utf8")) as Record<string, number | null>;
    expect("stale" in cleaned).toBe(false);
    expect("work" in cleaned).toBe(true);
    expect("other" in cleaned).toBe(true);
  });

  it("recovers from a corrupt file", () => {
    const file = tmpFile();
    writeFileSync(file, "not json");
    expect(isPaused("work", file)).toBe(false);
    pausePeer("work", null, file);
    expect(isPaused("work", file)).toBe(true);
  });
});
