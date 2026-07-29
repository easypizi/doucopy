import { parseArgs } from "node:util";
import { requestInvite } from "./api.js";
import { shellExec } from "./exec.js";
import { loadRelaySecretFromHeroku } from "./ops.js";

export async function runInvite(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      ttl: { type: "string" },
      secret: { type: "string" },
      app: { type: "string" },
    },
  });
  const ttl = values.ttl !== undefined ? Number(values.ttl) : undefined;
  if (values.ttl !== undefined && (!Number.isFinite(ttl) || (ttl as number) <= 0)) {
    throw new Error("--ttl must be a positive number of hours");
  }

  let secret = values.secret;
  if (!secret && values.app) {
    secret = await loadRelaySecretFromHeroku(values.app, shellExec);
  }

  if (secret) {
    const { createTokenService } = await import("../../relay/dist/auth.js");
    const { invite, expires_at } = createTokenService(secret).issueInvite(ttl);
    printInvite(invite, expires_at);
    return;
  }

  const { loadConfig } = await import("../../daemon/dist/config.js");
  const config = loadConfig();
  const result = await requestInvite(config.relay_url, config.token, ttl);
  printInvite(result.invite, result.expires_at, config.relay_url);
}

function printInvite(invite: string, expiresAt: number, relayUrl?: string): void {
  console.log(`invite (valid until ${new Date(expiresAt).toISOString()}):`);
  console.log(`  ${invite}`);
  if (relayUrl) {
    console.log("on the new machine run:");
    console.log(`  npx doucopy join ${relayUrl} ${invite}`);
  }
}
