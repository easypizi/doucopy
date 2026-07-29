import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneWorkspaces, safeDirName } from "../src/workspace.js";

describe("safeDirName", () => {
  it("keeps safe ids and hashes unsafe ones", () => {
    expect(safeDirName("0198f-uuid-like")).toBe("0198f-uuid-like");
    const hashed = safeDirName("../../escape");
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(safeDirName("a".repeat(65))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("pruneWorkspaces", () => {
  it("removes only directories older than the cutoff", () => {
    const root = mkdtempSync(path.join(tmpdir(), "doucopy-ws-"));
    const oldDir = path.join(root, "old-conv");
    const newDir = path.join(root, "new-conv");
    mkdirSync(oldDir);
    mkdirSync(newDir);
    writeFileSync(path.join(root, "task.md"), "legacy file, must be ignored");
    const stale = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(oldDir, stale, stale);
    const removed = pruneWorkspaces(root, 7 * 24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(true);
    expect(existsSync(path.join(root, "task.md"))).toBe(true);
  });

  it("tolerates a missing root", () => {
    expect(pruneWorkspaces("/nonexistent/doucopy-root")).toBe(0);
  });
});
