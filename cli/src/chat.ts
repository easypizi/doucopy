import { createInterface } from "node:readline/promises";
import { askPeer, fetchReply, fetchStatus, type AskResult, type RelayStatus } from "./api.js";
import { c, formatPeersTable } from "./color.js";
import { buildPeerRows } from "./status.js";

// The REPL uses only ANSI helpers already vendored in cli/src/color.ts (no
// extra dependencies). Key bindings are whatever readline gives us for free
// (arrows, history, ^C, ^D). Stays pastable inside tmux / Claude Code / SSH.

const ASK_WAIT_SECONDS = 20;
const REPLY_WAIT_SECONDS = 25;
const REPLY_MAX_ATTEMPTS = 20;

interface ChatState {
  relayUrl: string;
  token: string;
  self: string;
  peer: string | null;
  conversationId: string | null;
  timeoutSeconds: number;
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function printPeersTable(state: ChatState, status: RelayStatus): Promise<void> {
  let paused: { peer: string; until_ms: number | null }[] = [];
  try {
    const { listPaused } = await import("../../daemon/dist/paused.js");
    paused = listPaused();
  } catch {
    // paused module may not be reachable in some smoke setups; empty is fine.
  }
  print(formatPeersTable(buildPeerRows(status, state.self, paused)));
}

function printHelp(): void {
  print("commands:");
  print("  /peers                  refresh and list peers");
  print("  /use <peer>             set the peer to talk to");
  print("  /new                    start a new conversation (drops conversation_id)");
  print("  /timeout <seconds>      set ask timeout (default 20, max 240)");
  print("  /status                 relay status snapshot");
  print("  /help                   this text");
  print("  /quit                   exit (also: Ctrl-D)");
  print("anything else is sent to the current peer as a question.");
}

function summariseResult(r: AskResult): string {
  const meta = `ticket=${r.ticket_id} conv=${r.conversation_id}`;
  if (r.status === "answered") return `[answered ${meta}]\n${r.answer ?? ""}`;
  if (r.status === "error") return `[error ${meta}] ${r.error ?? ""}`;
  if (r.status === "peer_offline") return `[peer offline ${meta}] queued, will deliver when the peer comes back`;
  if (r.status === "pending") return `[pending ${meta}] still waiting, polling…`;
  return `[${r.status} ${meta}]`;
}

async function pollPending(
  state: ChatState,
  ticket: string,
): Promise<{ status: "answered" | "error" | "timeout"; answer?: string; error?: string }> {
  for (let i = 0; i < REPLY_MAX_ATTEMPTS; i += 1) {
    const r = await fetchReply(state.relayUrl, state.token, ticket, REPLY_WAIT_SECONDS);
    if (r.status === "answered") return { status: "answered", answer: r.answer };
    if (r.status === "error") return { status: "error", error: r.error };
    if (r.status === "unknown_ticket") return { status: "error", error: "unknown_ticket (relay restarted or ticket expired)" };
    // still pending, poll again
  }
  return { status: "timeout" };
}

async function handleAsk(state: ChatState, question: string): Promise<void> {
  if (!state.peer) {
    print("no peer selected. use `/peers` then `/use <peer>` first.");
    return;
  }
  const askInput = {
    peer: state.peer,
    question,
    wait_seconds: Math.min(state.timeoutSeconds, ASK_WAIT_SECONDS),
    conversation_id: state.conversationId ?? undefined,
  };
  let initial: AskResult;
  try {
    initial = await askPeer(state.relayUrl, state.token, askInput);
  } catch (err) {
    print(`ask failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  state.conversationId = initial.conversation_id;
  print(summariseResult(initial));
  if (initial.status !== "pending") return;
  const polled = await pollPending(state, initial.ticket_id);
  if (polled.status === "answered") {
    print(`[answered ticket=${initial.ticket_id}]\n${polled.answer ?? ""}`);
  } else if (polled.status === "error") {
    print(`[error ticket=${initial.ticket_id}] ${polled.error ?? ""}`);
  } else {
    print(
      `[still pending after ${REPLY_MAX_ATTEMPTS * REPLY_WAIT_SECONDS}s] pick it up later with:\n` +
        `  doucopy reply ${initial.ticket_id}`,
    );
  }
}

interface HandleCommandResult {
  quit?: boolean;
}

async function handleCommand(state: ChatState, raw: string): Promise<HandleCommandResult> {
  const [cmd, ...rest] = raw.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/help": printHelp(); return {};
    case "/quit": case "/exit": return { quit: true };
    case "/peers": case "/status": {
      const status = await fetchStatus(state.relayUrl, state.token);
      await printPeersTable(state, status);
      if (status.outgoing.length > 0) {
        print("");
        print(c.bold("open tickets"));
        for (const t of status.outgoing) print(`  → ${t.to_peer}  ${c.dim(t.status)}  ${c.dim(t.ticket_id)}`);
      }
      return {};
    }
    case "/use": {
      if (!arg) { print("usage: /use <peer>"); return {}; }
      state.peer = arg;
      state.conversationId = null;
      print(`peer set to ${state.peer}; new conversation on next question`);
      return {};
    }
    case "/new": {
      state.conversationId = null;
      print("new conversation on next question");
      return {};
    }
    case "/timeout": {
      const n = Number(arg);
      if (!Number.isInteger(n) || n <= 0 || n > 240) {
        print("usage: /timeout <seconds>  (1..240)");
        return {};
      }
      state.timeoutSeconds = n;
      print(`timeout set to ${n}s`);
      return {};
    }
    default:
      print(`unknown command: ${cmd}. type /help`);
      return {};
  }
}

function prompt(state: ChatState): string {
  const peer = state.peer ?? "-";
  const conv = state.conversationId ? state.conversationId.slice(0, 8) : "-";
  return `doucopy ${state.self}→${peer} [${conv}]> `;
}

export async function runChat(): Promise<void> {
  const { loadConfig } = await import("../../daemon/dist/config.js") as {
    loadConfig: () => { relay_url: string; token: string; self_peer: string };
  };
  const config = loadConfig();
  const state: ChatState = {
    relayUrl: config.relay_url,
    token: config.token,
    self: config.self_peer,
    peer: null,
    conversationId: null,
    timeoutSeconds: ASK_WAIT_SECONDS,
  };

  // Best-effort status probe so the user sees available peers up front.
  try {
    const status = await fetchStatus(state.relayUrl, state.token);
    print(c.bold(`doucopy chat`) + c.dim(`  ${state.relayUrl}`));
    await printPeersTable(state, status);
    const remotePeers = status.peers.filter((p) => p.name !== state.self);
    if (remotePeers.length === 1) {
      state.peer = remotePeers[0].name;
      print("");
      print(`auto-selected peer: ${c.cyan(state.peer)}`);
    } else if (remotePeers.length > 1) {
      print("");
      print(c.dim("use `/use <peer>` to pick one"));
    }
  } catch (err) {
    print(`could not reach the relay: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  print("type /help for commands, /quit to exit");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdout.isTTY,
  });
  rl.on("SIGINT", () => rl.close());
  try {
    while (true) {
      let line: string;
      try {
        line = await rl.question(prompt(state));
      } catch {
        break;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith("/")) {
        const res = await handleCommand(state, trimmed);
        if (res.quit) break;
      } else {
        await handleAsk(state, trimmed);
      }
    }
  } finally {
    rl.close();
  }
  print("bye");
}
