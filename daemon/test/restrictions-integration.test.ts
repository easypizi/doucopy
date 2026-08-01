/**
 * Integration-style checks for responder restrictions.
 * Real cursor-agent / claude / codex are not invoked. We assert the permission
 * artifacts the daemon would apply, which is what enforces lockdown under
 * --force / dontAsk / --sandbox.
 */
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DaemonConfig } from "../src/config.js";
import { buildPermissions } from "../src/permissions.js";

function configWith(restrictions?: DaemonConfig["restrictions"]): DaemonConfig {
  return {
    relay_url: "https://example.com",
    self_peer: "work",
    token: "tok",
    memory_sources: {
      transcripts_glob: path.join(homedir(), ".cursor/projects/*/agent-transcripts/**/*.jsonl"),
      agents_md_roots: [path.join(homedir(), "dev")],
      extra_files: [],
    },
    responder: {
      cursor_agent_binary: "cursor-agent",
      workspace_dir: path.join(homedir(), ".doucopy/workspace"),
      response_timeout_seconds: 300,
    },
    restrictions,
  };
}

describe("restrictions integration scenarios", () => {
  it("default lockdown: Desktop write denied, shell off, memory reads still allowed", () => {
    const workspace = path.join(homedir(), ".doucopy/workspace", "mem-conv");
    const desktop = path.join(homedir(), "Desktop");
    const perms = buildPermissions(configWith(undefined), workspace);

    expect(perms.cursor.permissions.deny).toContain("Shell(*)");
    expect(perms.cursor.permissions.deny).toContain(`Write(${desktop}/**)`);
    expect(perms.cursor.permissions.allow.some((a) => a.startsWith("Read(") && a.includes(".cursor/projects"))).toBe(true);
    expect(perms.cursor.permissions.allow).toContain(`Write(${workspace}/**)`);
    // Shell off must not remove Read allows used for memory search.
    expect(perms.cursor.permissions.allow.some((a) => a.startsWith("Read("))).toBe(true);
    expect(perms.claude.permissions.allow).toContain("Read");
    expect(perms.claude.permissions.deny).toContain("Bash");
  });

  it("custom allow: Desktop write permitted while other home folders stay denied", () => {
    const workspace = path.join(homedir(), ".doucopy/workspace", "allow-conv");
    const desktop = path.join(homedir(), "Desktop");
    const documents = path.join(homedir(), "Documents");
    const perms = buildPermissions(
      configWith({
        fs_write: { mode: "custom", allow: [desktop] },
        shell: { mode: "off" },
      }),
      workspace,
    );
    expect(perms.cursor.permissions.allow).toContain(`Write(${desktop}/**)`);
    expect(perms.cursor.permissions.deny).not.toContain(`Write(${desktop}/**)`);
    expect(perms.cursor.permissions.deny).toContain(`Write(${documents}/**)`);
  });

  it("read blocklist denies custom paths while built-in blocklist remains", () => {
    const workspace = path.join(homedir(), ".doucopy/workspace", "read-conv");
    const finance = path.join(homedir(), "Documents/finance");
    const perms = buildPermissions(
      configWith({ fs_read: { deny: [finance] } }),
      workspace,
    );
    expect(perms.readDeny).toEqual(
      expect.arrayContaining([
        path.join(homedir(), ".ssh"),
        path.join(homedir(), ".aws"),
        path.join(homedir(), ".doucopy/config.json"),
        finance,
      ]),
    );
    expect(perms.readDeny).not.toContain(workspace);
    expect(perms.cursor.permissions.deny).toContain(`Read(${finance}/**)`);
  });
});
