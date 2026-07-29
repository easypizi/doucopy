import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fetchStatus, joinRelay, normalizeRelayUrl } from "./api.js";
import { installDaemon } from "./launchd.js";
import { areAllSkillsInstalled, installGlobalSkills, type SkillsClient } from "./skills.js";
import {
  defaultConfig,
  detectAskers,
  detectResponders,
  discoverMemorySources,
  mergeClaudeMcp,
  mergeCodexToml,
  mergeMcpJson,
  writeConfig,
  writeDefaultPolicy,
  type DetectedResponders,
  type HarnessKind,
} from "./setup.js";

const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
type ResponderChoice = HarnessKind | "asker-only";
const ASKER_ORDER: readonly SkillsClient[] = ["cursor", "claude"];
type Client = "cursor" | "claude" | "codex";
const CLIENT_ORDER: readonly Client[] = ["cursor", "claude", "codex"];

interface Flags {
  relayUrl?: string;
  invite?: string;
  name?: string;
  harness?: ResponderChoice;
  askers?: Client[];
  skills?: boolean;
  neverReveal?: string[];
  askerOnly?: boolean;
  yes?: boolean;
}

function parseFlags(argv: string[]): Flags {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      harness: { type: "string" },
      askers: { type: "string" },
      "no-skills": { type: "boolean" },
      "never-reveal": { type: "string" },
      "asker-only": { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
  const flags: Flags = {};
  if (positionals[0]) flags.relayUrl = positionals[0];
  if (positionals[1]) flags.invite = positionals[1];
  if (values.name !== undefined) flags.name = String(values.name);
  if (values.harness !== undefined) {
    const h = String(values.harness);
    if (!["cursor-agent", "claude", "codex", "asker-only"].includes(h)) {
      throw new Error(`--harness must be cursor-agent | claude | codex | asker-only, got ${h}`);
    }
    flags.harness = h as ResponderChoice;
  }
  if (values.askers !== undefined) {
    flags.askers = String(values.askers)
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is Client => CLIENT_ORDER.includes(s as Client));
  }
  if (values["no-skills"]) flags.skills = false;
  if (values["never-reveal"] !== undefined) {
    flags.neverReveal = String(values["never-reveal"])
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (values["asker-only"]) flags.askerOnly = true;
  if (values.yes) flags.yes = true;
  if (flags.askerOnly && flags.harness && flags.harness !== "asker-only") {
    throw new Error("--asker-only conflicts with --harness");
  }
  if (flags.askerOnly) flags.harness = "asker-only";
  return flags;
}

function defaultName(): string {
  const raw = hostname().replace(/\.local$/, "");
  const sanitised = raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return NAME_PATTERN.test(sanitised) ? sanitised : "";
}

// Reads the existing connection (if any) so the wizard can offer a
// reconfigure flow without asking for relay-url and invite again. Returns
// null on any parse/shape issue — we always fall back cleanly to the full
// flow instead of surfacing config errors here.
interface ExistingConnection {
  relayUrl: string;
  peer: string;
  token: string;
}

export function readExistingConnection(home: string): ExistingConnection | null {
  const file = path.join(home, ".doucopy/config.json");
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const relayUrl = typeof raw.relay_url === "string" ? raw.relay_url : "";
    const peer = typeof raw.self_peer === "string" ? raw.self_peer : "";
    const token = typeof raw.token === "string" ? raw.token : "";
    if (!relayUrl || !peer || !token) return null;
    return { relayUrl, peer, token };
  } catch {
    return null;
  }
}

// Draft state: after the user typed the (usually annoying to re-enter) relay
// URL and invite but before the wizard finished, we persist them so a
// retry can prefill the same values. Invites are HMAC-signed with a TTL on
// the relay side, so reusing one within its TTL is legitimate.
interface JoinDraft {
  relay_url: string;
  invite: string;
  saved_at: number;
}

const DRAFT_TTL_MS = 48 * 60 * 60 * 1000;

function draftPath(home: string): string {
  return path.join(home, ".doucopy/join-draft.json");
}

export function readDraft(home: string, now: number = Date.now()): { relayUrl: string; invite: string } | null {
  const file = draftPath(home);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<JoinDraft>;
    if (typeof raw.relay_url !== "string" || typeof raw.invite !== "string" || typeof raw.saved_at !== "number") {
      clearDraft(home);
      return null;
    }
    if (now - raw.saved_at > DRAFT_TTL_MS) {
      clearDraft(home);
      return null;
    }
    return { relayUrl: raw.relay_url, invite: raw.invite };
  } catch {
    clearDraft(home);
    return null;
  }
}

export function writeDraft(home: string, relayUrl: string, invite: string, now: number = Date.now()): void {
  const file = draftPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const draft: JoinDraft = { relay_url: relayUrl, invite, saved_at: now };
  writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
}

export function clearDraft(home: string): void {
  rmSync(draftPath(home), { force: true });
}

function responderChoices(detected: DetectedResponders): { value: ResponderChoice; name: string; disabled?: string | false }[] {
  const asDetected = (present: boolean) => (present ? undefined : "(not found on PATH)");
  return [
    { value: "cursor-agent", name: "cursor-agent", disabled: asDetected(detected.cursor) },
    { value: "claude", name: "claude", disabled: asDetected(detected.claude) },
    { value: "codex", name: "codex", disabled: asDetected(detected.codex) },
    { value: "asker-only", name: "asker-only (do not answer, just ask others)" },
  ];
}

async function askRelayUrl(flag: string | undefined, interactive: boolean, prefill?: string): Promise<string> {
  if (flag) return normalizeRelayUrl(flag);
  if (!interactive) {
    if (prefill) return normalizeRelayUrl(prefill);
    throw new Error("relay URL required (positional or --yes without prompting)");
  }
  const raw = await input({
    message: "Relay URL:",
    default: prefill,
    validate: (v) => (v.trim().length > 0 ? true : "required"),
  });
  return normalizeRelayUrl(raw.trim());
}

async function askInvite(flag: string | undefined, interactive: boolean, prefill?: string): Promise<string> {
  if (flag) return flag;
  if (!interactive) {
    if (prefill) return prefill;
    throw new Error("invite code required");
  }
  return input({
    message: "Invite code:",
    default: prefill,
    validate: (v) => (v.trim().length > 0 ? true : "required"),
  });
}

async function askName(flag: string | undefined, interactive: boolean): Promise<string> {
  if (flag) {
    if (!NAME_PATTERN.test(flag)) throw new Error(`--name must match ${NAME_PATTERN}`);
    return flag;
  }
  if (!interactive) throw new Error("peer name required (--name)");
  return input({
    message: "Peer name for this machine (letters, digits, . _ -):",
    default: defaultName(),
    validate: (v) => (NAME_PATTERN.test(v.trim()) ? true : "must match [A-Za-z0-9._-]{1,64}"),
  });
}

async function askAskers(flag: Client[] | undefined, detected: ReturnType<typeof detectAskers>, interactive: boolean): Promise<Client[]> {
  if (flag) return flag;
  if (!interactive) {
    // Default: everything detected.
    return CLIENT_ORDER.filter((c) => detected[c]);
  }
  const chosen = await checkbox<Client>({
    message: "Where should you be able to ask peers? (spacebar to toggle)",
    choices: [
      { value: "cursor", name: "Cursor", checked: detected.cursor },
      { value: "claude", name: "Claude Code", checked: detected.claude },
      { value: "codex", name: "OpenAI Codex CLI", checked: detected.codex },
    ],
  });
  return chosen;
}

async function askResponder(flag: ResponderChoice | undefined, detected: DetectedResponders, interactive: boolean): Promise<ResponderChoice> {
  if (flag) return flag;
  if (!interactive) {
    if (detected.cursor) return "cursor-agent";
    if (detected.claude) return "claude";
    if (detected.codex) return "codex";
    return "asker-only";
  }
  return select<ResponderChoice>({
    message: "Which harness should answer questions from other peers?",
    choices: responderChoices(detected),
    default: detected.cursor ? "cursor-agent" : detected.claude ? "claude" : detected.codex ? "codex" : "asker-only",
  });
}

async function askSkillsInstall(flag: boolean | undefined, clients: Client[], home: string, interactive: boolean): Promise<boolean> {
  if (flag !== undefined) return flag;
  const skillClients = clients.filter((c): c is SkillsClient => c === "cursor" || c === "claude");
  if (skillClients.length === 0) return false;
  // Skip the prompt entirely when nothing would change — the wizard
  // announces the current state instead of asking a redundant question.
  if (areAllSkillsInstalled(home, skillClients)) {
    if (interactive) {
      console.log(`skills already up to date in ${skillClients.map((c) => `~/.${c}/skills`).join(" and ")}`);
    }
    return false;
  }
  if (!interactive) return true;
  return confirm({
    message: `Install (or update) doucopy skills globally into ${skillClients.map((c) => `~/.${c}/skills`).join(" and ")}?`,
    default: true,
  });
}

async function askNeverReveal(flag: string[] | undefined, interactive: boolean, asker: boolean): Promise<string[]> {
  if (flag) return flag;
  if (asker) return [];
  if (!interactive) return [];
  const raw = await input({
    message: "Anything the responder must never reveal? (comma-separated, empty to skip)",
    default: "",
  });
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function runJoin(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const interactive = Boolean(process.stdin.isTTY) && !flags.yes;
  const home = homedir();

  // Reconfigure fast-path: when the machine is already connected and the
  // caller did not force fresh credentials, offer to reuse the existing
  // (relay-url, peer, token) triple. Verify the token is still valid before
  // committing, otherwise fall through to the full flow.
  let reuseExisting = false;
  let existingPeer: string | undefined;
  let existingToken: string | undefined;
  const existing = readExistingConnection(home);
  if (existing && !flags.relayUrl && !flags.invite) {
    if (interactive) {
      reuseExisting = await confirm({
        message: `Found existing connection to ${existing.relayUrl} as "${existing.peer}". Reuse it and just tweak settings?`,
        default: true,
      });
    } else if (flags.yes) {
      reuseExisting = true;
    }
    if (reuseExisting) {
      try {
        await fetchStatus(existing.relayUrl, existing.token);
        existingPeer = existing.peer;
        existingToken = existing.token;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`existing token no longer valid (${message.split("\n")[0]}), starting a fresh join`);
        reuseExisting = false;
      }
    }
  }

  let relayUrl: string;
  let peer: string;
  let token: string;
  if (reuseExisting && existingPeer && existingToken) {
    relayUrl = normalizeRelayUrl(existing!.relayUrl);
    peer = existingPeer;
    token = existingToken;
  } else {
    const draft = existing ? null : readDraft(home);
    relayUrl = await askRelayUrl(flags.relayUrl, interactive, draft?.relayUrl);
    const invite = await askInvite(flags.invite, interactive, draft?.invite);
    // Persist a draft as soon as we have the two annoying-to-retype values,
    // so a Ctrl-C between here and the end of join lets the next run prefill.
    writeDraft(home, relayUrl, invite);
    const name = await askName(flags.name, interactive);
    const joined = await joinRelay(relayUrl, invite, name);
    token = joined.token;
    peer = joined.peer;
    console.log(`joined the relay as "${peer}"`);
  }

  const askers = await askAskers(flags.askers, detectAskers(home), interactive);
  const responder = await askResponder(flags.harness, detectResponders(), interactive);
  const askerOnly = responder === "asker-only";
  const wantSkills = await askSkillsInstall(flags.skills, askers, home, interactive);
  const neverReveal = await askNeverReveal(flags.neverReveal, interactive, askerOnly);

  const discovery = discoverMemorySources(home);
  if (discovery.agents_md_roots.length > 0) {
    console.log(`memory roots: ${discovery.agents_md_roots.join(", ")}`);
  }
  const base = defaultConfig(relayUrl, peer, token, discovery) as {
    responder: { harness?: HarnessKind; binary?: string; cursor_agent_binary?: string };
  };
  if (!askerOnly) {
    const harness = responder as HarnessKind;
    base.responder.harness = harness;
    base.responder.binary = harness;
    if (harness !== "cursor-agent") delete base.responder.cursor_agent_binary;
  }
  const configPath = writeConfig(home, base);
  console.log(`wrote ${configPath}`);
  if (writeDefaultPolicy(home, neverReveal)) console.log("wrote default ~/.doucopy/policy.md");

  if (askers.includes("cursor")) console.log(`updated ${mergeMcpJson(home, relayUrl, token)}`);
  if (askers.includes("claude")) console.log(`updated ${mergeClaudeMcp(home, relayUrl, token)}`);
  if (askers.includes("codex")) console.log(`updated ${mergeCodexToml(home, relayUrl, token)}`);

  if (wantSkills) {
    const skillClients = askers.filter((c): c is SkillsClient => c === "cursor" || c === "claude");
    if (skillClients.length > 0) {
      const result = installGlobalSkills({ home, clients: skillClients });
      const installed = result.filter((r) => r.status === "installed").length;
      const updated = result.filter((r) => r.status === "updated").length;
      const unchanged = result.filter((r) => r.status === "unchanged").length;
      const parts: string[] = [];
      if (installed > 0) parts.push(`${installed} installed`);
      if (updated > 0) parts.push(`${updated} updated`);
      if (unchanged > 0) parts.push(`${unchanged} already up to date`);
      const summary = parts.length > 0 ? parts.join(", ") : "no changes";
      console.log(`skills (${skillClients.join(" and ")}): ${summary}`);
    }
  }

  if (askerOnly) {
    clearDraft(home);
    console.log("asker-only mode: responder daemon not installed");
    console.log("restart your coding agent (Cursor / Claude Code / Codex) so it picks up the doucopy MCP server");
    console.log(`run "doucopy chat" to start asking peers`);
    return;
  }

  installDaemon(home);
  console.log("installed and started the responder daemon");

  for (let i = 0; i < 15; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const status = await fetchStatus(relayUrl, token);
      if (status.self_online) {
        clearDraft(home);
        console.log("daemon is online, setup complete");
        console.log("restart your coding agent (Cursor / Claude Code / Codex) so it picks up the doucopy MCP server");
        console.log(`run "doucopy chat" to open the terminal REPL, or "doucopy policy" to edit the filter`);
        return;
      }
    } catch {
      // relay may briefly reject while the daemon warms up, keep waiting
    }
  }
  console.error("daemon did not come online within 30s, check: doucopy logs");
  process.exitCode = 1;
}
