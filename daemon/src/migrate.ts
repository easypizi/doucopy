import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// See cli/src/migrate.ts for the full rationale: config.json can still
// contain a literal `~/.agent-link/...` path (e.g. workspace_dir) after the
// directory itself has been renamed. Patch it so loadConfig doesn't point at
// a location that no longer exists.
function fixLegacyConfigPaths(doucopyDir: string): void {
  const configPath = path.join(doucopyDir, "config.json");
  if (!existsSync(configPath)) return;
  try {
    const raw = readFileSync(configPath, "utf8");
    if (!raw.includes(".agent-link")) return;
    writeFileSync(configPath, raw.split(".agent-link").join(".doucopy"));
  } catch {
    // leave the file untouched; loadConfig will report anything actually broken
  }
}

// Mirrors cli/src/migrate.ts. Duplicated rather than shared because the CLI
// and daemon are separate workspaces without a common lib package; the
// daemon must be able to self-migrate even if it is started before the CLI
// ever runs `doucopy` again (e.g. a launchd restart after an upgrade).
export function migrateLegacyHome(home: string): boolean {
  const legacy = path.join(home, ".agent-link");
  const current = path.join(home, ".doucopy");
  if (existsSync(current) || !existsSync(legacy)) return false;
  renameSync(legacy, current);
  fixLegacyConfigPaths(current);
  return true;
}
