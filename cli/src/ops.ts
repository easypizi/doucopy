import { randomBytes } from "node:crypto";
import { fetchStatus, normalizeRelayUrl } from "./api.js";

export type ExecFn = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

const HEROKU = "heroku";
const GIT = "git";

export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

async function requireHerokuCli(exec: ExecFn): Promise<void> {
  const res = await exec(HEROKU, ["--version"]);
  if (res.code !== 0) {
    throw new Error("heroku CLI not found. Install: https://devcenter.heroku.com/articles/heroku-cli");
  }
}

async function herokuConfigGet(exec: ExecFn, app: string, key: string): Promise<string | null> {
  const res = await exec(HEROKU, ["config:get", key, "-a", app]);
  if (res.code !== 0) return null;
  const value = res.stdout.trim();
  return value.length > 0 ? value : null;
}

async function herokuConfigSet(exec: ExecFn, app: string, kv: Record<string, string>): Promise<void> {
  const args = ["config:set", ...Object.entries(kv).map(([k, v]) => `${k}=${v}`), "-a", app];
  const res = await exec(HEROKU, args);
  if (res.code !== 0) throw new Error(`heroku config:set failed: ${res.stderr.trim()}`);
}

async function herokuAppInfo(exec: ExecFn, app: string): Promise<{ webUrl: string }> {
  const res = await exec(HEROKU, ["apps:info", "-a", app, "--json"]);
  if (res.code !== 0) throw new Error(`heroku apps:info failed: ${res.stderr.trim()}`);
  const data = JSON.parse(res.stdout) as { app?: { web_url?: string } };
  const webUrl = data.app?.web_url;
  if (!webUrl) throw new Error(`heroku returned no web_url for ${app}`);
  return { webUrl: webUrl.replace(/\/+$/, "") };
}

async function pollHealth(
  url: string,
  fetchImpl: typeof fetch,
  attempts = 20,
  intervalMs = 1500,
): Promise<void> {
  const health = `${normalizeRelayUrl(url)}/health`;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetchImpl(health);
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean };
        if (body.ok === true) return;
      }
    } catch {
      // relay may be restarting after a config change or a fresh push
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`relay did not report healthy at ${health}`);
}

export interface DeployOptions {
  app: string;
  exec: ExecFn;
  fetchImpl?: typeof fetch;
  branch?: string;
}

export async function runDeploy(opts: DeployOptions): Promise<{ webUrl: string; setSecret: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  await requireHerokuCli(opts.exec);
  const info = await herokuAppInfo(opts.exec, opts.app);
  let setSecret = false;
  const existing = await herokuConfigGet(opts.exec, opts.app, "RELAY_SECRET");
  if (!existing) {
    const secret = generateSecret();
    await herokuConfigSet(opts.exec, opts.app, { RELAY_SECRET: secret });
    console.log("generated and set RELAY_SECRET (32 bytes)");
    setSecret = true;
  }
  const branch = opts.branch ?? "HEAD:main";
  const push = await opts.exec(GIT, ["push", "heroku", branch]);
  if (push.code !== 0) throw new Error(`git push heroku failed: ${push.stderr.trim() || push.stdout.trim()}`);
  await pollHealth(info.webUrl, fetchImpl);
  console.log(`deployed and healthy at ${info.webUrl}`);
  return { webUrl: info.webUrl, setSecret };
}

export interface SecretRotateOptions {
  app: string;
  exec: ExecFn;
}

export async function runSecretRotate(opts: SecretRotateOptions): Promise<string> {
  await requireHerokuCli(opts.exec);
  const secret = generateSecret();
  await herokuConfigSet(opts.exec, opts.app, { RELAY_SECRET: secret });
  console.log(
    "rotated RELAY_SECRET. every existing peer token is now invalid. re-join all machines with fresh invites.",
  );
  return secret;
}

function parseRevoked(csv: string | null): Set<string> {
  return new Set((csv ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

async function writeRevoked(exec: ExecFn, app: string, list: Set<string>): Promise<void> {
  await herokuConfigSet(exec, app, { REVOKED_PEERS: [...list].join(",") });
}

export async function runRevoke(peer: string, app: string, exec: ExecFn): Promise<boolean> {
  await requireHerokuCli(exec);
  const current = parseRevoked(await herokuConfigGet(exec, app, "REVOKED_PEERS"));
  if (current.has(peer)) {
    console.log(`${peer} is already in REVOKED_PEERS`);
    return false;
  }
  current.add(peer);
  await writeRevoked(exec, app, current);
  console.log(`revoked ${peer}. relay restarts automatically on config change.`);
  return true;
}

export async function runUnrevoke(peer: string, app: string, exec: ExecFn): Promise<boolean> {
  await requireHerokuCli(exec);
  const current = parseRevoked(await herokuConfigGet(exec, app, "REVOKED_PEERS"));
  if (!current.has(peer)) {
    console.log(`${peer} is not in REVOKED_PEERS`);
    return false;
  }
  current.delete(peer);
  await writeRevoked(exec, app, current);
  console.log(`removed ${peer} from REVOKED_PEERS`);
  return true;
}

export interface HealthOptions {
  relayUrl?: string;
  app?: string;
  exec?: ExecFn;
  fetchImpl?: typeof fetch;
  token?: string;
}

export async function runHealth(opts: HealthOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let url = opts.relayUrl;
  if (!url && opts.app) {
    if (!opts.exec) throw new Error("exec required to resolve app URL");
    await requireHerokuCli(opts.exec);
    url = (await herokuAppInfo(opts.exec, opts.app)).webUrl;
  }
  if (!url) throw new Error("either --url or --app is required");
  await pollHealth(url, fetchImpl, 3, 1000);
  console.log(`${url}/health ok`);
  if (opts.token) {
    const status = await fetchStatus(url, opts.token, fetchImpl);
    console.log(`authenticated as ${status.self}, ${status.peers.length} known peer(s)`);
  }
}

export async function loadRelaySecretFromHeroku(app: string, exec: ExecFn): Promise<string> {
  await requireHerokuCli(exec);
  const secret = await herokuConfigGet(exec, app, "RELAY_SECRET");
  if (!secret) throw new Error(`RELAY_SECRET is not set on ${app}`);
  return secret;
}
