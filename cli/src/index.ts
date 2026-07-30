#!/usr/bin/env node
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { runChat } from "./chat.js";
import { shellExec } from "./exec.js";
import { runInvite } from "./invite.js";
import { runJoin } from "./join.js";
import { startDaemon, stopDaemon } from "./launchd.js";
import { runLogs } from "./logs.js";
import { migrateLegacyHome } from "./migrate.js";
import { runDeploy, runHealth, runRevoke, runSecretRotate, runUnrevoke } from "./ops.js";
import { runPause, runResume } from "./pause.js";
import { runPolicy } from "./policy.js";
import { runRelay } from "./relay.js";
import { runSettings } from "./settings.js";
import { runSetup } from "./setup-wizard.js";
import { runStatus } from "./status.js";

const USAGE = `Usage: doucopy <command>

Setup
  join [relay-url] [invite]              connect, reconfigure or resume setup
  setup                                  owner: deploy relay + first join
  invite [--ttl h] [--secret s | --app]  create an invite code
  settings                               edit restrictions, model, persona, harness
  policy                                 edit ~/.doucopy/policy.md

Daily
  chat                                   interactive REPL to ask peers
  status                                 show daemon state, peers and dialogs
  logs [-f]                              show responder logs
  pause <peer> [--for 2h | --until iso]  refuse questions from a peer
  resume <peer>                          re-enable questions from a peer
  start | stop | restart                 control the responder daemon

Relay ops (owner)
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
  if (migrateLegacyHome(home)) {
    console.log("migrated ~/.agent-link to ~/.doucopy");
  }
  switch (command) {
    case "join": {
      await runJoin(rest);
      return;
    }
    case "setup":
      await runSetup(rest);
      return;
    case "settings":
      await runSettings(home);
      return;
    case "policy":
      runPolicy(home);
      return;
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
      if (!peer) throw new Error("usage: doucopy pause <peer> [--for 2h | --until iso]");
      const { values } = parseArgs({
        args: flags,
        options: { for: { type: "string" }, until: { type: "string" } },
      });
      await runPause(peer, { forSpec: values.for, until: values.until });
      return;
    }
    case "resume": {
      const [peer] = rest;
      if (!peer) throw new Error("usage: doucopy resume <peer>");
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
      if (sub !== "rotate") throw new Error("usage: doucopy secret rotate --app <name>");
      const { values } = parseArgs({ args: subrest, options: { app: { type: "string" } } });
      await runSecretRotate({ app: requireFlag(values.app, "app"), exec: shellExec });
      return;
    }
    case "revoke": {
      const [peer, ...flags] = rest;
      if (!peer) throw new Error("usage: doucopy revoke <peer> --app <name>");
      const { values } = parseArgs({ args: flags, options: { app: { type: "string" } } });
      await runRevoke(peer, requireFlag(values.app, "app"), shellExec);
      return;
    }
    case "unrevoke": {
      const [peer, ...flags] = rest;
      if (!peer) throw new Error("usage: doucopy unrevoke <peer> --app <name>");
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
    case "chat":
      await runChat();
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
