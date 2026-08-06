import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const HISTORY_FILE = "field-history.json";
const CAP = 10;

export interface FieldHistory {
  relay_urls: string[];
  peer_names: string[];
  heroku_apps: string[];
}

const EMPTY: FieldHistory = {
  relay_urls: [],
  peer_names: [],
  heroku_apps: [],
};

function historyPath(home: string): string {
  return path.join(home, ".doucopy", HISTORY_FILE);
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

export function readHistory(home: string): FieldHistory {
  const file = historyPath(home);
  if (!existsSync(file)) return { ...EMPTY, relay_urls: [], peer_names: [], heroku_apps: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<FieldHistory>;
    return {
      relay_urls: normalizeList(raw.relay_urls),
      peer_names: normalizeList(raw.peer_names),
      heroku_apps: normalizeList(raw.heroku_apps),
    };
  } catch {
    return { ...EMPTY, relay_urls: [], peer_names: [], heroku_apps: [] };
  }
}

function pushUnique(list: string[], value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return list;
  const next = [trimmed, ...list.filter((v) => v !== trimmed)];
  return next.slice(0, CAP);
}

export function pushHistory(
  home: string,
  patch: Partial<{ relay_url: string; peer_name: string; heroku_app: string }>,
): FieldHistory {
  const current = readHistory(home);
  const next: FieldHistory = {
    relay_urls: patch.relay_url ? pushUnique(current.relay_urls, patch.relay_url) : current.relay_urls,
    peer_names: patch.peer_name ? pushUnique(current.peer_names, patch.peer_name) : current.peer_names,
    heroku_apps: patch.heroku_app ? pushUnique(current.heroku_apps, patch.heroku_app) : current.heroku_apps,
  };
  const dir = path.join(home, ".doucopy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(historyPath(home), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}
