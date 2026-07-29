import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { packageRoot } from "./launchd.js";

// User-facing skills we ship. The maintainer-only ones (dev, relay, privacy,
// setup) stay inside the repo and are never installed into a user's home.
export const SHIPPED_SKILLS = [
  "doucopy-ask",
  "doucopy-answer",
  "doucopy-troubleshoot",
] as const;

// Names these skills shipped under before the agent-link → doucopy rename.
// Removed from the target dir on every install so an upgrade doesn't leave
// two copies of the same skill (old and new name) active at once.
const LEGACY_SKILLS = [
  "agent-link-ask",
  "agent-link-answer",
  "agent-link-troubleshoot",
] as const;

export type SkillsClient = "cursor" | "claude";

export interface InstallSkillsOptions {
  home: string;
  clients: SkillsClient[];
  // Where to read shipped skills from. Defaults to the packaged skills/ dir,
  // falling back to .cursor/skills for a source checkout where sync-skills
  // has not run yet.
  sourceDir?: string;
}

export interface InstalledSkill {
  client: SkillsClient;
  skill: string;
  path: string;
  status: "installed" | "updated" | "unchanged";
}

function resolveSourceDir(explicit?: string): string {
  if (explicit) return explicit;
  const packaged = path.join(packageRoot(), "skills");
  if (existsSync(packaged) && readdirSync(packaged).length > 0) return packaged;
  // Dev fallback: the maintainer is running from a source checkout without
  // having run `npm run sync-skills` yet.
  return path.join(packageRoot(), ".cursor/skills");
}

function targetDir(home: string, client: SkillsClient): string {
  if (client === "cursor") return path.join(home, ".cursor/skills");
  return path.join(home, ".claude/skills");
}

// Deep content comparison so we can skip an install when the destination
// already matches. Directories match iff their file trees match byte-for-byte
// (small SKILL.md files, no perf concern). Anything unexpected (broken
// symlinks, permissions issues) returns false so we fall through to copy.
function treesEqual(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.isDirectory() !== sb.isDirectory()) return false;
    if (sa.isDirectory()) {
      const ea = readdirSync(a).sort();
      const eb = readdirSync(b).sort();
      if (ea.length !== eb.length) return false;
      for (let i = 0; i < ea.length; i += 1) {
        if (ea[i] !== eb[i]) return false;
        if (!treesEqual(path.join(a, ea[i]), path.join(b, eb[i]))) return false;
      }
      return true;
    }
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

export function areAllSkillsInstalled(
  home: string,
  clients: SkillsClient[],
  sourceDir?: string,
): boolean {
  if (clients.length === 0) return true;
  const source = resolveSourceDir(sourceDir);
  for (const client of clients) {
    const dst = targetDir(home, client);
    for (const skill of SHIPPED_SKILLS) {
      const from = path.join(source, skill);
      if (!existsSync(from)) continue;
      const to = path.join(dst, skill);
      if (!existsSync(to) || !treesEqual(from, to)) return false;
    }
  }
  return true;
}

// Idempotent by content: copies only when the destination is missing or its
// contents differ from the shipped source. Upgrade scenarios still refresh
// files, but re-running with the same source is a no-op that reports
// `unchanged` for every skill so the caller can print an accurate summary.
export function installGlobalSkills(opts: InstallSkillsOptions): InstalledSkill[] {
  const source = resolveSourceDir(opts.sourceDir);
  const result: InstalledSkill[] = [];
  for (const client of opts.clients) {
    const dst = targetDir(opts.home, client);
    mkdirSync(dst, { recursive: true });
    for (const legacy of LEGACY_SKILLS) {
      rmSync(path.join(dst, legacy), { recursive: true, force: true });
    }
    for (const skill of SHIPPED_SKILLS) {
      const from = path.join(source, skill);
      if (!existsSync(from)) continue;
      const to = path.join(dst, skill);
      const existed = existsSync(to);
      if (existed && treesEqual(from, to)) {
        result.push({ client, skill, path: to, status: "unchanged" });
        continue;
      }
      cpSync(from, to, { recursive: true, force: true });
      result.push({
        client,
        skill,
        path: to,
        status: existed ? "updated" : "installed",
      });
    }
  }
  return result;
}
