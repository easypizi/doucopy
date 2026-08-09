import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  areAllSkillsInstalled,
  installGlobalSkills,
  removeGlobalDoucopySkills,
  SHIPPED_SKILLS,
} from "../src/skills.js";

function makeSourceDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "doucopy-skills-src-"));
  for (const skill of SHIPPED_SKILLS) {
    mkdirSync(path.join(dir, skill), { recursive: true });
    writeFileSync(path.join(dir, skill, "SKILL.md"), `# ${skill}\nversion 1\n`);
  }
  return dir;
}

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "doucopy-home-"));
}

describe("installGlobalSkills", () => {
  it("copies every shipped skill into ~/.cursor/skills for a cursor client", () => {
    const home = makeHome();
    const source = makeSourceDir();
    const installed = installGlobalSkills({ home, clients: ["cursor"], sourceDir: source });
    expect(installed).toHaveLength(SHIPPED_SKILLS.length);
    for (const skill of SHIPPED_SKILLS) {
      const target = path.join(home, ".cursor/skills", skill, "SKILL.md");
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf8")).toContain(`# ${skill}`);
    }
  });

  it("also targets ~/.claude/skills when the claude client is picked", () => {
    const home = makeHome();
    const source = makeSourceDir();
    installGlobalSkills({ home, clients: ["cursor", "claude"], sourceDir: source });
    for (const skill of SHIPPED_SKILLS) {
      expect(existsSync(path.join(home, ".cursor/skills", skill, "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(home, ".claude/skills", skill, "SKILL.md"))).toBe(true);
    }
  });

  it("targets ~/.codex/skills when the codex client is picked", () => {
    const home = makeHome();
    const source = makeSourceDir();
    const installed = installGlobalSkills({ home, clients: ["codex"], sourceDir: source });
    expect(installed).toHaveLength(SHIPPED_SKILLS.length);
    for (const skill of SHIPPED_SKILLS) {
      expect(existsSync(path.join(home, ".codex/skills", skill, "SKILL.md"))).toBe(true);
    }
  });

  it("removeGlobalDoucopySkills clears cursor, claude, and codex skill homes", () => {
    const home = makeHome();
    const source = makeSourceDir();
    installGlobalSkills({ home, clients: ["cursor", "claude", "codex"], sourceDir: source });
    const removed = removeGlobalDoucopySkills(home);
    for (const client of ["cursor", "claude", "codex"] as const) {
      for (const skill of SHIPPED_SKILLS) {
        const dir = path.join(home, `.${client}/skills`, skill);
        expect(existsSync(dir)).toBe(false);
        expect(removed).toContain(dir);
      }
    }
  });

  it("marks the first install as `installed` and matching reinstalls as `unchanged`", () => {
    const home = makeHome();
    const source = makeSourceDir();
    const first = installGlobalSkills({ home, clients: ["cursor"], sourceDir: source });
    expect(first.every((r) => r.status === "installed")).toBe(true);
    const second = installGlobalSkills({ home, clients: ["cursor"], sourceDir: source });
    expect(second.every((r) => r.status === "unchanged")).toBe(true);
  });

  it("marks reinstalls as `updated` when the source content actually changed", () => {
    const home = makeHome();
    const source = makeSourceDir();
    installGlobalSkills({ home, clients: ["cursor"], sourceDir: source });
    const target = path.join(home, ".cursor/skills", "doucopy-ask/SKILL.md");
    writeFileSync(path.join(source, "doucopy-ask/SKILL.md"), "# doucopy-ask\nversion 2\n");
    const result = installGlobalSkills({ home, clients: ["cursor"], sourceDir: source });
    expect(readFileSync(target, "utf8")).toContain("version 2");
    const bySkill = new Map(result.map((r) => [r.skill, r.status]));
    expect(bySkill.get("doucopy-ask")).toBe("updated");
    expect(bySkill.get("doucopy-answer")).toBe("unchanged");
  });

  it("areAllSkillsInstalled reflects fresh, stale and missing states", () => {
    const home = makeHome();
    const source = makeSourceDir();
    expect(areAllSkillsInstalled(home, ["cursor"], source)).toBe(false);
    installGlobalSkills({ home, clients: ["cursor"], sourceDir: source });
    expect(areAllSkillsInstalled(home, ["cursor"], source)).toBe(true);
    writeFileSync(path.join(source, "doucopy-ask/SKILL.md"), "changed");
    expect(areAllSkillsInstalled(home, ["cursor"], source)).toBe(false);
    // Empty client list is trivially satisfied.
    expect(areAllSkillsInstalled(home, [], source)).toBe(true);
  });

  it("skips a skill silently when the source dir does not contain it", () => {
    const home = makeHome();
    const source = mkdtempSync(path.join(tmpdir(), "doucopy-skills-empty-"));
    // Only one skill exists in source.
    mkdirSync(path.join(source, "doucopy-ask"), { recursive: true });
    writeFileSync(path.join(source, "doucopy-ask/SKILL.md"), "x");
    const installed = installGlobalSkills({ home, clients: ["cursor"], sourceDir: source });
    expect(installed.map((s) => s.skill)).toEqual(["doucopy-ask"]);
  });

  it("returns an empty list when no clients are picked", () => {
    const home = makeHome();
    const source = makeSourceDir();
    expect(installGlobalSkills({ home, clients: [], sourceDir: source })).toEqual([]);
  });

  it("removes legacy agent-link-* skill copies on install (upgrade cleanup)", () => {
    const home = makeHome();
    const source = makeSourceDir();
    const legacyDir = path.join(home, ".cursor/skills/agent-link-ask");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path.join(legacyDir, "SKILL.md"), "stale");
    installGlobalSkills({ home, clients: ["cursor"], sourceDir: source });
    expect(existsSync(legacyDir)).toBe(false);
  });

  it("replaces a broken destination symlink instead of failing with ENOENT", () => {
    const home = makeHome();
    const source = makeSourceDir();
    const cursorSkills = path.join(home, ".cursor/skills");
    mkdirSync(cursorSkills, { recursive: true });
    const broken = path.join(cursorSkills, "doucopy-ask");
    symlinkSync(path.join(home, "missing-old-repo/doucopy-ask"), broken);
    expect(existsSync(broken)).toBe(false);
    expect(lstatSync(broken).isSymbolicLink()).toBe(true);

    const installed = installGlobalSkills({ home, clients: ["cursor"], sourceDir: source });
    expect(installed.some((r) => r.skill === "doucopy-ask")).toBe(true);
    expect(lstatSync(broken).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(broken, "SKILL.md"), "utf8")).toContain("# doucopy-ask");
  });

  it("removeGlobalDoucopySkills deletes broken doucopy-* symlinks", () => {
    const home = makeHome();
    const cursorSkills = path.join(home, ".cursor/skills");
    mkdirSync(cursorSkills, { recursive: true });
    const broken = path.join(cursorSkills, "doucopy-ask");
    symlinkSync(path.join(home, "gone/doucopy-ask"), broken);
    const removed = removeGlobalDoucopySkills(home);
    expect(removed).toContain(broken);
    expect(() => lstatSync(broken)).toThrow();
  });
});
