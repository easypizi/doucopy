import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// config.json is a literal copy of whatever the old join wizard wrote, so it
// can still contain a `responder.workspace_dir` (or other field) pointing at
// the pre-rename `~/.agent-link/...` path. The directory rename alone leaves
// that string stale (it now points outside the moved tree), so patch every
// occurrence to `~/.doucopy/...`. Best-effort: a config we can't parse is
// left alone, the daemon's own validation will surface a clear error.
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

// One-time migration for machines set up before the doucopy rename. If a
// legacy ~/.agent-link directory exists and ~/.doucopy does not yet, the
// whole tree (config, policy, paused/conversations state, workspace, logs,
// join-draft) moves in a single rename. No-op once ~/.doucopy exists.
export function migrateLegacyHome(home: string): boolean {
  const legacy = path.join(home, ".agent-link");
  const current = path.join(home, ".doucopy");
  if (existsSync(current) || !existsSync(legacy)) return false;
  renameSync(legacy, current);
  fixLegacyConfigPaths(current);
  return true;
}
