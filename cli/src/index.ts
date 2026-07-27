#!/usr/bin/env node
import { homedir } from "node:os";
import { runInvite } from "./invite.js";
import { runJoin } from "./join.js";
import { startDaemon, stopDaemon } from "./launchd.js";
import { runLogs } from "./logs.js";
import { runRelay } from "./relay.js";
import { runStatus } from "./status.js";

const USAGE = `Usage: agent-link <command>

Commands:
  join <relay-url> <invite>              connect this machine to a relay
  invite [--ttl <hours>] [--secret <s>]  create an invite code for a new machine
  status                                 show daemon state, peers and dialogs
  start | stop | restart                 control the responder daemon
  logs [-f]                              show responder logs
  relay                                  run the relay server (requires RELAY_SECRET)
`;

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
