import path from "node:path";

export type DaemonPathOptions = {
  /** Absolute path to the node binary used to run the daemon (usually process.execPath). */
  nodeBin: string;
  /** User home used for ~/.local/bin (real os.homedir on install). */
  pathHome: string;
  platform?: NodeJS.Platform;
  /** Optional env for expanding Windows %VAR% style dirs at render time. */
  env?: NodeJS.ProcessEnv;
};

/**
 * PATH prefix so the responder can find cursor-agent / claude / codex.
 * Always puts dirname(nodeBin) first (nvm / fnm / official Node install dirs
 * where `npm i -g` drops claude and codex).
 */
export function buildDaemonPathDirs(opts: DaemonPathOptions): string[] {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.pathHome;
  // Use platform-specific path helpers so Mac unit tests can render Windows wrappers
  // without posix dirname mangling "C:\\Program Files\\nodejs\\node.exe".
  const p = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = p.dirname(opts.nodeBin);

  if (platform === "win32") {
    const appData = env.APPDATA || p.join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA || p.join(home, "AppData", "Local");
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    return uniqueExistingPreferred([
      nodeDir,
      p.join(home, ".local", "bin"),
      p.join(localAppData, "cursor-agent"),
      p.join(localAppData, "Programs", "cursor", "resources", "app", "bin"),
      p.join(appData, "npm"),
      p.join(programFiles, "nodejs"),
    ]);
  }

  return uniqueExistingPreferred([
    nodeDir,
    p.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]);
}

/** Full PATH value for launchd / cmd wrapper (dirs + optional trailing system PATH). */
export function buildDaemonPathValue(opts: DaemonPathOptions & { appendPath?: string }): string {
  const platform = opts.platform ?? process.platform;
  const sep = platform === "win32" ? ";" : ":";
  const dirs = buildDaemonPathDirs(opts);
  if (opts.appendPath?.trim()) {
    return [...dirs, opts.appendPath.trim()].join(sep);
  }
  return dirs.join(sep);
}

function uniqueExistingPreferred(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const key = dir.replace(/[/\\]+$/, "").toLowerCase();
    if (!dir || seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}
