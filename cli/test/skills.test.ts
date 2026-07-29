import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { areAllSkillsInstalled, installGlobalSkills, SHIPPED_SKILLS } from "../src/skills.js";

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
    const target = path.join(home, ".cursor/skills", "agent-link-ask/SKILL.md");
    writeFileSync(path.join(source, "agent-link-ask/SKILL.md"), "# agent-link-ask\nversion 2\n");
    const result = installGlobalSkills({ home, clients: ["cursor"], sourceDir: source });
    expect(readFileSync(target, "utf8")).toContain("version 2");
    const bySkill = new Map(result.map((r) => [r.skill, r.status]));
    expect(bySkill.get("agent-link-ask")).toBe("updated");
    expect(bySkill.get("agent-link-answer")).toBe("unchanged");
  });

  it("areAllSkillsInstalled reflects fresh, stale and missing states", () => {
    const home = makeHome();
    const source = makeSourceDir();
    expect(areAllSkillsInstalled(home, ["cursor"], source)).toBe(false);
    installGlobalSkills({ home, clients: ["cursor"], sourceDir: source });
    expect(areAllSkillsInstalled(home, ["cursor"], source)).toBe(true);
    writeFileSync(path.join(source, "agent-link-ask/SKILL.md"), "changed");
    expect(areAllSkillsInstalled(home, ["cursor"], source)).toBe(false);
    // Empty client list is trivially satisfied.
    expect(areAllSkillsInstalled(home, [], source)).toBe(true);
  });

  it("skips a skill silently when the source dir does not contain it", () => {
    const home = makeHome();
    const source = mkdtempSync(path.join(tmpdir(), "doucopy-skills-empty-"));
    // Only one skill exists in source.
    mkdirSync(path.join(source, "agent-link-ask"), { recursive: true });
    writeFileSync(path.join(source, "agent-link-ask/SKILL.md"), "x");
    const installed = installGlobalSkills({ home, clients: ["cursor"], sourceDir: source });
    expect(installed.map((s) => s.skill)).toEqual(["agent-link-ask"]);
  });

  it("returns an empty list when no clients are picked", () => {
    const home = makeHome();
    const source = makeSourceDir();
    expect(installGlobalSkills({ home, clients: [], sourceDir: source })).toEqual([]);
  });
});
