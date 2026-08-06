import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CACHE_FILE = "update-check.json";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export interface UpdateCheckCache {
  latest: string | null;
  checkedAt: number;
  error?: string;
}

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: number;
  error?: string;
  fromCache: boolean;
}

function cachePath(home: string): string {
  return path.join(home, ".doucopy", CACHE_FILE);
}

export function readUpdateCache(home: string): UpdateCheckCache | null {
  const file = cachePath(home);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as UpdateCheckCache;
    if (typeof raw.checkedAt !== "number") return null;
    return {
      latest: typeof raw.latest === "string" ? raw.latest : null,
      checkedAt: raw.checkedAt,
      error: typeof raw.error === "string" ? raw.error : undefined,
    };
  } catch {
    return null;
  }
}

export function writeUpdateCache(home: string, cache: UpdateCheckCache): void {
  mkdirSync(path.join(home, ".doucopy"), { recursive: true });
  writeFileSync(cachePath(home), `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
}

/** Semver-ish compare: returns true if latest > current. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[-+]/)[0]!
      .split(".")
      .map((p) => Number.parseInt(p, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

export type NpmViewRunner = () => { ok: boolean; stdout: string; stderr: string };

function defaultNpmView(): { ok: boolean; stdout: string; stderr: string } {
  const out = spawnSync("npm", ["view", "doucopy", "version"], {
    encoding: "utf8",
    timeout: 5000,
    env: process.env,
  });
  return {
    ok: out.status === 0,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? out.error?.message ?? "",
  };
}

export function checkForUpdate(
  home: string,
  current: string,
  opts: { force?: boolean; ttlMs?: number; npmView?: NpmViewRunner; now?: number } = {},
): UpdateCheckResult {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cached = readUpdateCache(home);
  if (!opts.force && cached && now - cached.checkedAt < ttl) {
    const latest = cached.latest;
    return {
      current,
      latest,
      updateAvailable: Boolean(latest && isNewerVersion(latest, current)),
      checkedAt: cached.checkedAt,
      error: cached.error,
      fromCache: true,
    };
  }

  const run = opts.npmView ?? defaultNpmView;
  const result = run();
  if (!result.ok) {
    const error = (result.stderr || result.stdout || "npm view failed").trim().slice(0, 200);
    const cache: UpdateCheckCache = {
      latest: cached?.latest ?? null,
      checkedAt: now,
      error,
    };
    writeUpdateCache(home, cache);
    return {
      current,
      latest: cache.latest,
      updateAvailable: Boolean(cache.latest && isNewerVersion(cache.latest, current)),
      checkedAt: now,
      error,
      fromCache: false,
    };
  }

  const latest = result.stdout.trim().split(/\s+/)[0] ?? "";
  const cache: UpdateCheckCache = { latest: latest || null, checkedAt: now };
  writeUpdateCache(home, cache);
  return {
    current,
    latest: cache.latest,
    updateAvailable: Boolean(cache.latest && isNewerVersion(cache.latest, current)),
    checkedAt: now,
    fromCache: false,
  };
}
