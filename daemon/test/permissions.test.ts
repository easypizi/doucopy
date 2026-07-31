import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DaemonConfig } from "../src/config.js";
import {
  buildPermissions,
  claudeSettingsArg,
  materializeCursorPermissions,
} from "../src/permissions.js";

function baseConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    relay_url: "https://example.com",
    self_peer: "work",
    token: "tok",
    memory_sources: {
      transcripts_glob: path.join(homedir(), ".cursor/projects/*/agent-transcripts/**/*.jsonl"),
      agents_md_roots: [path.join(homedir(), "dev")],
      extra_files: [path.join(homedir(), ".cursor/NOTES.md")],
    },
    responder: {
      cursor_agent_binary: "cursor-agent",
      workspace_dir: path.join(homedir(), ".doucopy/workspace"),
      response_timeout_seconds: 300,
    },
    ...overrides,
  };
}

describe("buildPermissions", () => {
  it("applies safe defaults when restrictions are missing", () => {
    const workspace = path.join(homedir(), ".doucopy/workspace/conv1");
    const perms = buildPermissions(baseConfig(), workspace);
    expect(perms.restrictions.fs_write.mode).toBe("workspace_only");
    expect(perms.restrictions.shell.mode).toBe("off");
    expect(perms.cursor.permissions.deny).toContain("Shell(*)");
    expect(perms.claude.permissions.deny).toContain("Bash");
    expect(perms.codexSandbox).toBe("workspace-write");
    expect(perms.summary.shell).toBe("off");
  });

  it("always includes built-in read denials", () => {
    const workspace = path.join(homedir(), ".doucopy/workspace/conv1");
    const perms = buildPermissions(baseConfig(), workspace);
    const ssh = path.join(homedir(), ".ssh");
    const aws = path.join(homedir(), ".aws");
    const doucopy = path.join(homedir(), ".doucopy");
    expect(perms.readDeny).toEqual(expect.arrayContaining([ssh, aws, doucopy]));
    expect(perms.cursor.permissions.deny.some((d) => d.includes(".ssh"))).toBe(true);
    expect(perms.claude.permissions.deny.some((d) => d.includes(".ssh"))).toBe(true);
  });

  it("denies Desktop writes by default and allows them when listed", () => {
    const workspace = path.join(homedir(), ".doucopy/workspace/conv1");
    const desktop = path.join(homedir(), "Desktop");
    const locked = buildPermissions(baseConfig(), workspace);
    expect(locked.cursor.permissions.deny.some((d) => d.includes(`${desktop}/`))).toBe(true);

    const allowed = buildPermissions(
      baseConfig({
        restrictions: {
          fs_write: { mode: "custom", allow: [desktop] },
          shell: { mode: "off" },
        },
      }),
      workspace,
    );
    expect(allowed.writeRoots).toContain(desktop);
    expect(allowed.cursor.permissions.allow.some((a) => a.includes(`${desktop}/`))).toBe(true);
    expect(allowed.cursor.permissions.deny.some((d) => d === `Write(${desktop}/**)`)).toBe(false);
  });

  it("merges custom read denials", () => {
    const workspace = path.join(homedir(), ".doucopy/workspace/conv1");
    const finance = path.join(homedir(), "Documents/finance");
    const perms = buildPermissions(
      baseConfig({ restrictions: { fs_read: { deny: [finance] } } }),
      workspace,
    );
    expect(perms.readDeny).toContain(finance);
    expect(perms.cursor.permissions.deny).toContain(`Read(${finance}/**)`);
    expect(perms.claude.permissions.deny.some((d) => d.includes("Documents/finance"))).toBe(true);
  });

  it("maps shell deny_patterns and open modes", () => {
    const workspace = path.join(homedir(), ".doucopy/workspace/conv1");
    const patterned = buildPermissions(
      baseConfig({
        restrictions: { shell: { mode: "deny_patterns", deny: ["rm", "curl"] } },
      }),
      workspace,
    );
    expect(patterned.cursor.permissions.deny).toContain("Shell(rm)");
    expect(patterned.cursor.permissions.deny).toContain("Shell(curl)");
    expect(patterned.cursor.permissions.deny).not.toContain("Shell(*)");
    expect(patterned.claude.permissions.allow).toContain("Bash");
    expect(patterned.claude.permissions.deny).toContain("Bash(rm)");

    const open = buildPermissions(
      baseConfig({ restrictions: { shell: { mode: "open" } } }),
      workspace,
    );
    expect(open.cursor.permissions.deny).not.toContain("Shell(*)");
    expect(open.claude.permissions.allow).toContain("Bash");
    expect(open.codexSandbox).toBe("danger-full-access");
  });

  it("allows read on memory sources and workspace", () => {
    const workspace = path.join(homedir(), ".doucopy/workspace/conv1");
    const perms = buildPermissions(baseConfig(), workspace);
    expect(perms.cursor.permissions.allow.some((a) => a.includes(workspace))).toBe(true);
    expect(perms.cursor.permissions.allow.some((a) => a.includes(".cursor/projects"))).toBe(true);
    expect(perms.cursor.permissions.allow.some((a) => a.includes(`${path.join(homedir(), "dev")}/`))).toBe(true);
    expect(perms.claude.permissions.allow).toContain("Read");
  });

  it("allows read prefixes for every transcripts_glob entry", () => {
    const workspace = path.join(homedir(), ".doucopy/workspace/conv1");
    const perms = buildPermissions(
      baseConfig({
        memory_sources: {
          transcripts_glob: [
            path.join(homedir(), ".cursor/projects/*/agent-transcripts/**/*.jsonl"),
            path.join(homedir(), ".claude/projects/**/*.jsonl"),
            path.join(homedir(), ".codex/sessions/**/*.jsonl"),
          ],
          agents_md_roots: [],
          extra_files: [],
        },
      }),
      workspace,
    );
    expect(perms.cursor.permissions.allow.some((a) => a.includes(".cursor/projects"))).toBe(true);
    expect(perms.cursor.permissions.allow.some((a) => a.includes(".claude/projects"))).toBe(true);
    expect(perms.cursor.permissions.allow.some((a) => a.includes(".codex/sessions"))).toBe(true);
  });

  it("emits three harness formats and materializes cursor cli.json", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-perms-"));
    const workspace = path.join(dir, "workspace");
    const perms = buildPermissions(baseConfig(), workspace);
    expect(perms.cursor.permissions.allow.length).toBeGreaterThan(0);
    expect(perms.cursor.permissions.deny.length).toBeGreaterThan(0);
    expect(perms.claude.permissions.allow).toContain("Read");
    expect(["workspace-write", "danger-full-access", "read-only"]).toContain(perms.codexSandbox);

    const file = materializeCursorPermissions(workspace, perms);
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(parsed.permissions.deny).toContain("Shell(*)");

    const settings = JSON.parse(claudeSettingsArg(perms)) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(settings.permissions.deny).toContain("Bash");
  });

  it("uses danger-full-access for codex when custom write allows outside workspace", () => {
    const workspace = path.join(homedir(), ".doucopy/workspace/conv1");
    const desktop = path.join(homedir(), "Desktop");
    const perms = buildPermissions(
      baseConfig({
        restrictions: {
          fs_write: { mode: "custom", allow: [desktop] },
          shell: { mode: "off" },
        },
      }),
      workspace,
    );
    expect(perms.codexSandbox).toBe("danger-full-access");
  });
});
