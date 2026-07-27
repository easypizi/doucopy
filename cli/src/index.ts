#!/usr/bin/env node
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { shellExec } from "./exec.js";
import { runInvite } from "./invite.js";
import { runJoin } from "./join.js";
import { startDaemon, stopDaemon } from "./launchd.js";
import { runLogs } from "./logs.js";
import { runDeploy, runHealth, runRevoke, runSecretRotate, runUnrevoke } from "./ops.js";
import { runPause, runResume } from "./pause.js";
import { runRelay } from "./relay.js";
import { runStatus } from "./status.js";

const USAGE = `Usage: agent-link <command>

Setup
  join <relay-url> <invite>              connect this machine to a relay
  invite [--ttl h] [--secret s | --app]  create an invite code

Daemon
  status                                 show daemon state, peers and dialogs
  start | stop | restart                 control the responder daemon
  logs [-f]                              show responder logs
  pause <peer> [--for 2h | --until iso]  refuse questions from a peer
  resume <peer>                          re-enable questions from a peer

Relay ops
  deploy --app <name>                    push and health-check the relay
  secret rotate --app <name>             rotate RELAY_SECRET (breaks every peer)
  revoke <peer> --app <name>             add peer to REVOKED_PEERS
  unrevoke <peer> --app <name>           remove peer from REVOKED_PEERS
  health [--app <name> | --url <url>]    hit /health and (with token) /status
  relay                                  run the relay server (requires RELAY_SECRET)
`;

function requireFlag(value: string | undefined, name: string): string {
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const home = homedir();
  switch (command) {
    case "join": {
      const [relayUrl, invite] = rest;
      if (!relayUrl || !invite) throw new Error("usage: agent-link join <relay-url> <invite>");
      await runJoin(relayUrl, invite);
      return;
    }
    case "invite":
      await runInvite(rest);
      return;
    case "status":
      await runStatus();
      return;
    case "start":
      startDaemon(home);
      return;
    case "stop":
      stopDaemon(home);
      return;
    case "restart":
      stopDaemon(home);
      startDaemon(home);
      return;
    case "logs":
      runLogs(rest.includes("-f") || rest.includes("--follow"));
      return;
    case "pause": {
      const [peer, ...flags] = rest;
      if (!peer) throw new Error("usage: agent-link pause <peer> [--for 2h | --until iso]");
      const { values } = parseArgs({
        args: flags,
        options: { for: { type: "string" }, until: { type: "string" } },
      });
      await runPause(peer, { forSpec: values.for, until: values.until });
      return;
    }
    case "resume": {
      const [peer] = rest;
      if (!peer) throw new Error("usage: agent-link resume <peer>");
      await runResume(peer);
      return;
    }
    case "deploy": {
      const { values } = parseArgs({ args: rest, options: { app: { type: "string" } } });
      await runDeploy({ app: requireFlag(values.app, "app"), exec: shellExec });
      return;
    }
    case "secret": {
      const [sub, ...subrest] = rest;
      if (sub !== "rotate") throw new Error("usage: agent-link secret rotate --app <name>");
      const { values } = parseArgs({ args: subrest, options: { app: { type: "string" } } });
      await runSecretRotate({ app: requireFlag(values.app, "app"), exec: shellExec });
      return;
    }
    case "revoke": {
      const [peer, ...flags] = rest;
      if (!peer) throw new Error("usage: agent-link revoke <peer> --app <name>");
      const { values } = parseArgs({ args: flags, options: { app: { type: "string" } } });
      await runRevoke(peer, requireFlag(values.app, "app"), shellExec);
      return;
    }
    case "unrevoke": {
      const [peer, ...flags] = rest;
      if (!peer) throw new Error("usage: agent-link unrevoke <peer> --app <name>");
      const { values } = parseArgs({ args: flags, options: { app: { type: "string" } } });
      await runUnrevoke(peer, requireFlag(values.app, "app"), shellExec);
      return;
    }
    case "health": {
      const { values } = parseArgs({
        args: rest,
        options: { app: { type: "string" }, url: { type: "string" } },
      });
      await runHealth({ app: values.app, relayUrl: values.url, exec: shellExec });
      return;
    }
    case "relay":
      await runRelay();
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.log(USAGE);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
