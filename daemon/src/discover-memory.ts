import fg from "fast-glob";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Live skill/plan/rule roots (mirrors cli discoverSkillRoots; no config rewrite). */
export function discoverSkillRoots(home: string = homedir()): string[] {
  const roots: string[] = [];
  const add = (dir: string) => {
    if (existsSync(dir) && !roots.includes(dir)) roots.push(dir);
  };
  const cursor = path.join(home, ".cursor");
  add(path.join(cursor, "skills"));
  add(path.join(cursor, "skills-cursor"));
  add(path.join(cursor, "plans"));
  add(path.join(cursor, "rules"));
  if (existsSync(cursor)) {
    for (const hit of fg.sync("skills-*", { cwd: cursor, onlyDirectories: true, absolute: true, suppressErrors: true })) {
      add(hit);
    }
  }
  add(path.join(home, ".claude", "skills"));
  add(path.join(home, ".claude", "rules"));
  add(path.join(home, ".codex", "skills"));
  add(path.join(home, ".codex", "memories"));
  return roots;
}

const EXTRA_DENY = new Set([
  "mcp.json",
  "mcp.json.bak",
  "auth.json",
  "ide_state.json",
  "agent-cli-state.json",
  "cli-config.json",
  "argv.json",
  "statsig-cache.json",
]);

export function discoverExtraFiles(home: string = homedir()): string[] {
  const files: string[] = [];
  const push = (f: string) => {
    if (f && !files.includes(f)) files.push(f);
  };
  const cursorDir = path.join(home, ".cursor");
  if (existsSync(cursorDir)) {
    for (const file of fg.sync("*.md", { cwd: cursorDir, absolute: true, suppressErrors: true })) {
      if (EXTRA_DENY.has(path.basename(file))) continue;
      push(file);
    }
  }
  for (const rel of ["CLAUDE.md", "AGENTS.md"]) {
    const p = path.join(home, rel);
    if (existsSync(p)) push(p);
  }
  const claudeMd = path.join(home, ".claude", "CLAUDE.md");
  if (existsSync(claudeMd)) push(claudeMd);
  const codex = path.join(home, ".codex");
  if (existsSync(codex)) {
    for (const file of fg.sync("**/AGENTS.md", { cwd: codex, deep: 3, absolute: true, suppressErrors: true })) {
      push(file);
    }
    for (const file of fg.sync("memories/**/*.{md,txt}", { cwd: codex, absolute: true, suppressErrors: true })) {
      push(file);
    }
  }
  return files;
}

export function unionPaths(a: string[] | undefined, b: string[]): string[] {
  return [...new Set([...(a ?? []), ...b])];
}
