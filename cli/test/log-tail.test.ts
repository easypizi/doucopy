import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { responderLogSnippet, tailFileLines } from "../src/log-tail.js";

describe("tailFileLines", () => {
  it("returns the last N lines", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-tail-"));
    const file = path.join(home, "a.log");
    writeFileSync(file, "1\n2\n3\n4\n5\n");
    expect(tailFileLines(file, 3)).toBe("3\n4\n5");
  });
});

describe("responderLogSnippet", () => {
  it("includes err and out tails when present", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-snip-"));
    mkdirSync(path.join(home, ".doucopy"), { recursive: true });
    writeFileSync(path.join(home, ".doucopy", "responder.err.log"), "boom\n");
    writeFileSync(path.join(home, ".doucopy", "responder.log"), "started\n");
    const snip = responderLogSnippet(home, 5);
    expect(snip).toContain("responder.err.log");
    expect(snip).toContain("boom");
    expect(snip).toContain("started");
  });
});
