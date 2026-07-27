import { describe, expect, it, vi } from "vitest";
import {
  generateSecret,
  loadRelaySecretFromHeroku,
  runDeploy,
  runHealth,
  runRevoke,
  runSecretRotate,
  runUnrevoke,
  type ExecFn,
} from "../src/ops.js";

type Call = { cmd: string; args: string[] };

function mockExec(handlers: Array<(call: Call) => { stdout?: string; stderr?: string; code?: number }>): {
  exec: ExecFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const handler = handlers[i] ?? (() => ({ code: 0 }));
    i += 1;
    const result = handler({ cmd, args });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.code ?? 0,
    };
  };
  return { exec, calls };
}

const APP = "my-relay";
const APP_INFO = JSON.stringify({ app: { web_url: "https://my-relay.example.com/" } });

describe("generateSecret", () => {
  it("produces base64url without padding", () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBeGreaterThanOrEqual(40);
  });
});

describe("runDeploy", () => {
  it("generates a secret if missing, sets it, pushes, then health-checks", async () => {
    const { exec, calls } = mockExec([
      () => ({ code: 0, stdout: "heroku/9.0.0" }),
      () => ({ code: 0, stdout: APP_INFO }),
      () => ({ code: 0, stdout: "" }),
      () => ({ code: 0 }),
      () => ({ code: 0, stdout: "pushed" }),
    ]);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await runDeploy({ app: APP, exec, fetchImpl });
    expect(result).toEqual({ webUrl: "https://my-relay.example.com", setSecret: true });
    expect(calls[0]).toEqual({ cmd: "heroku", args: ["--version"] });
    expect(calls[2]).toEqual({ cmd: "heroku", args: ["config:get", "RELAY_SECRET", "-a", APP] });
    expect(calls[3].args[0]).toBe("config:set");
    expect(calls[3].args[1]).toMatch(/^RELAY_SECRET=[A-Za-z0-9_-]+$/);
    expect(calls[4]).toEqual({ cmd: "git", args: ["push", "heroku", "HEAD:main"] });
  });

  it("keeps an existing secret and just pushes", async () => {
    const { exec, calls } = mockExec([
      () => ({ code: 0 }),
      () => ({ code: 0, stdout: APP_INFO }),
      () => ({ code: 0, stdout: "existing-secret-1234567890" }),
      () => ({ code: 0, stdout: "pushed" }),
    ]);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await runDeploy({ app: APP, exec, fetchImpl });
    expect(result.setSecret).toBe(false);
    expect(calls.map((c) => `${c.cmd} ${c.args[0]}`)).toEqual([
      "heroku --version",
      "heroku apps:info",
      "heroku config:get",
      "git push",
    ]);
  });

  it("fails fast when heroku CLI is missing", async () => {
    const { exec } = mockExec([() => ({ code: 127, stderr: "not found" })]);
    await expect(runDeploy({ app: APP, exec })).rejects.toThrow(/heroku CLI not found/);
  });

  it("fails when git push fails", async () => {
    const { exec } = mockExec([
      () => ({ code: 0 }),
      () => ({ code: 0, stdout: APP_INFO }),
      () => ({ code: 0, stdout: "s3cr3t-1234567890abcdef" }),
      () => ({ code: 1, stderr: "rejected: non-fast-forward" }),
    ]);
    await expect(runDeploy({ app: APP, exec })).rejects.toThrow(/git push heroku failed.*non-fast-forward/);
  });

  it("does NOT rotate RELAY_SECRET when heroku config:get transiently fails", async () => {
    const { exec, calls } = mockExec([
      () => ({ code: 0 }),
      () => ({ code: 0, stdout: APP_INFO }),
      () => ({ code: 1, stderr: "Error: connect ETIMEDOUT" }),
    ]);
    await expect(runDeploy({ app: APP, exec })).rejects.toThrow(/heroku config:get RELAY_SECRET failed.*ETIMEDOUT/);
    // Critical: no config:set and no git push must have run.
    const cmds = calls.map((c) => `${c.cmd} ${c.args[0]}`);
    expect(cmds).not.toContain("heroku config:set");
    expect(cmds).not.toContain("git push");
  });
});

describe("runSecretRotate", () => {
  it("generates a fresh secret and sets it", async () => {
    const { exec, calls } = mockExec([
      () => ({ code: 0 }),
      () => ({ code: 0 }),
    ]);
    const secret = await runSecretRotate({ app: APP, exec });
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(calls[1].args[1]).toBe(`RELAY_SECRET=${secret}`);
  });
});

describe("revoke / unrevoke", () => {
  it("adds a peer to REVOKED_PEERS", async () => {
    const { exec, calls } = mockExec([
      () => ({ code: 0 }),
      () => ({ code: 0, stdout: "old-a, old-b" }),
      () => ({ code: 0 }),
    ]);
    const changed = await runRevoke("mallory", APP, exec);
    expect(changed).toBe(true);
    expect(calls[2].args[1]).toBe("REVOKED_PEERS=old-a,old-b,mallory");
  });

  it("is a no-op when the peer is already revoked", async () => {
    const { exec, calls } = mockExec([
      () => ({ code: 0 }),
      () => ({ code: 0, stdout: "mallory" }),
    ]);
    const changed = await runRevoke("mallory", APP, exec);
    expect(changed).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("removes a peer from REVOKED_PEERS", async () => {
    const { exec, calls } = mockExec([
      () => ({ code: 0 }),
      () => ({ code: 0, stdout: "mallory,eve" }),
      () => ({ code: 0 }),
    ]);
    const changed = await runUnrevoke("mallory", APP, exec);
    expect(changed).toBe(true);
    expect(calls[2].args[1]).toBe("REVOKED_PEERS=eve");
  });
});

describe("runHealth", () => {
  it("hits /health for a raw URL", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    await runHealth({ relayUrl: "https://r.example.com", fetchImpl });
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("https://r.example.com/health");
  });

  it("resolves an app URL through heroku apps:info", async () => {
    const { exec } = mockExec([
      () => ({ code: 0 }),
      () => ({ code: 0, stdout: APP_INFO }),
    ]);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    await runHealth({ app: APP, exec, fetchImpl });
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("https://my-relay.example.com/health");
  });

  it("requires either --url or --app", async () => {
    await expect(runHealth({})).rejects.toThrow(/either --url or --app/);
  });
});

describe("loadRelaySecretFromHeroku", () => {
  it("returns the secret from heroku config", async () => {
    const { exec } = mockExec([
      () => ({ code: 0 }),
      () => ({ code: 0, stdout: "supersecret-1234567890" }),
    ]);
    await expect(loadRelaySecretFromHeroku(APP, exec)).resolves.toBe("supersecret-1234567890");
  });

  it("throws with a distinct message when the secret is unset (exit 0 + empty stdout)", async () => {
    const { exec } = mockExec([
      () => ({ code: 0 }),
      () => ({ code: 0, stdout: "" }),
    ]);
    await expect(loadRelaySecretFromHeroku(APP, exec)).rejects.toThrow(/RELAY_SECRET is not set/);
  });

  it("propagates a transient heroku failure instead of treating it as unset", async () => {
    const { exec } = mockExec([
      () => ({ code: 0 }),
      () => ({ code: 1, stderr: "!!! Error: ETIMEDOUT" }),
    ]);
    await expect(loadRelaySecretFromHeroku(APP, exec)).rejects.toThrow(/heroku config:get RELAY_SECRET failed/);
  });
});
