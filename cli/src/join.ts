import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, homedir, userInfo } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fetchStatus, joinRelay, normalizeRelayUrl } from "./api.js";
import { installDaemon } from "./launchd.js";
import { areAllSkillsInstalled, installGlobalSkills, type SkillsClient } from "./skills.js";
import {
  applyRestrictions,
  promptRestrictionsStep,
  readConfigFile,
  restrictionsFromConfig,
  SAFE_RESTRICTIONS,
  type RestrictionsSettings,
} from "./settings.js";
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

function sanitizePeerName(raw: string): string {
  const sanitised = raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return NAME_PATTERN.test(sanitised) ? sanitised : "";
}

function defaultName(): string {
  return sanitizePeerName(hostname().replace(/\.local$/, ""));
}

function peerNameChoices(): { value: string; name: string }[] {
  const host = defaultName();
  let user = "";
  try {
    user = sanitizePeerName(userInfo().username);
  } catch {
    user = "";
  }
  const choices: { value: string; name: string }[] = [];
  const seen = new Set<string>();
  const add = (value: string, name: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    choices.push({ value, name });
  };
  if (host) add(host, `${host} (hostname)`);
  if (user) {
    add(user, `${user} (username)`);
    add(`${user}-mbp`, `${user}-mbp`);
    add(`${user}-home`, `${user}-home`);
    add(`${user}-work`, `${user}-work`);
  }
  add("personal", "personal");
  add("work", "work");
  add("home", "home");
  add("laptop", "laptop");
  add("__custom__", "Custom...");
  return choices;
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
  const choices = peerNameChoices();
  const picked = await select<string>({
    message: "Peer name for this machine",
    choices,
    default: defaultName() || choices[0]?.value,
  });
  if (picked !== "__custom__") return picked;
  return input({
    message: "Custom peer name (letters, digits, . _ -):",
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

const NEVER_REVEAL_PRESETS = [
  { value: "password", name: "password" },
  { value: "secret", name: "secret" },
  { value: "api_key", name: "api_key" },
  { value: "token", name: "token" },
  { value: "Bearer", name: "Bearer" },
  { value: "sk-", name: "sk- (OpenAI-style keys)" },
  { value: "AKIA", name: "AKIA (AWS access key prefix)" },
  { value: "private key", name: "private key" },
  { value: "ssh-rsa", name: "ssh-rsa" },
] as const;

async function askNeverReveal(flag: string[] | undefined, interactive: boolean, asker: boolean): Promise<string[]> {
  if (flag) return flag;
  if (asker) return [];
  if (!interactive) return [];
  const action = await select<"skip" | "pick" | "custom">({
    message: "Anything the responder must never reveal?",
    choices: [
      { value: "skip", name: "Skip (nothing extra)" },
      { value: "pick", name: "Pick from common presets" },
      { value: "custom", name: "Type custom values only" },
    ],
    default: "skip",
  });
  if (action === "skip") return [];
  let picked: string[] = [];
  if (action === "pick") {
    picked = await checkbox<string>({
      message: "Never-reveal literals (space to toggle)",
      choices: NEVER_REVEAL_PRESETS.map((p) => ({ value: p.value, name: p.name })),
    });
  }
  const wantCustom = action === "custom"
    ? true
    : await confirm({
        message: "Add custom never-reveal values?",
        default: false,
      });
  if (!wantCustom) return picked;
  const raw = await input({
    message: "Custom never-reveal values (comma-separated)",
    default: "",
  });
  const custom = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set([...picked, ...custom]));
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

  let restrictions: RestrictionsSettings = {
    fs_write: { mode: SAFE_RESTRICTIONS.fs_write.mode, allow: [] },
    fs_read: { deny: [] },
    shell: { mode: SAFE_RESTRICTIONS.shell.mode, deny: [] },
  };
  if (!askerOnly && interactive) {
    const chosen = await promptRestrictionsStep(restrictionsFromConfig(readConfigFile(home)), {
      allowSkip: true,
      skipLabel: "Skip (safe default: workspace writes only, shell off)",
    });
    if (chosen !== "skip") restrictions = chosen;
  }

  const result = await finalizeJoin(home, {
    relayUrl,
    peer,
    token,
    askers,
    responder,
    wantSkills,
    neverReveal,
    restrictions,
  });
  for (const line of result.messages) console.log(line);
  if (!result.ok) {
    for (const line of result.errors) console.error(line);
    process.exitCode = 1;
  }
}

export type JoinClient = Client;
export type JoinResponderChoice = ResponderChoice;

export interface JoinFinalizeInput {
  relayUrl: string;
  peer: string;
  token: string;
  askers: Client[];
  responder: ResponderChoice;
  wantSkills: boolean;
  neverReveal: string[];
  restrictions: RestrictionsSettings;
}

export interface JoinFinalizeResult {
  ok: boolean;
  messages: string[];
  errors: string[];
}

/** Shared by interactive join and the Ink Setup wizard. */
export async function finalizeJoin(home: string, input: JoinFinalizeInput): Promise<JoinFinalizeResult> {
  const messages: string[] = [];
  const errors: string[] = [];
  const askerOnly = input.responder === "asker-only";
  const discovery = discoverMemorySources(home);
  if (discovery.agents_md_roots.length > 0) {
    messages.push(`memory roots: ${discovery.agents_md_roots.join(", ")}`);
  }
  let base = defaultConfig(input.relayUrl, input.peer, input.token, discovery, home) as {
    responder: {
      harness?: HarnessKind;
      binary?: string;
      cursor_agent_binary?: string;
      model?: string;
    };
    restrictions?: RestrictionsSettings;
  };
  if (!askerOnly) {
    const harness = input.responder as HarnessKind;
    base.responder.harness = harness;
    base.responder.binary = harness;
    if (harness === "cursor-agent") {
      base.responder.model = "composer-2.5";
    } else {
      delete base.responder.cursor_agent_binary;
      delete base.responder.model;
    }
    base = applyRestrictions(base, input.restrictions) as typeof base;
  }
  const configFile = writeConfig(home, base);
  messages.push(`wrote ${configFile}`);
  if (writeDefaultPolicy(home, input.neverReveal)) messages.push("wrote default ~/.doucopy/policy.md");

  if (input.askers.includes("cursor")) messages.push(`updated ${mergeMcpJson(home, input.relayUrl, input.token)}`);
  if (input.askers.includes("claude")) messages.push(`updated ${mergeClaudeMcp(home, input.relayUrl, input.token)}`);
  if (input.askers.includes("codex")) messages.push(`updated ${mergeCodexToml(home, input.relayUrl, input.token)}`);

  if (input.wantSkills) {
    const skillClients = input.askers.filter((c): c is SkillsClient => c === "cursor" || c === "claude");
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
      messages.push(`skills (${skillClients.join(" and ")}): ${summary}`);
    }
  }

  if (askerOnly) {
    clearDraft(home);
    messages.push("asker-only mode: responder daemon not installed");
    messages.push("restart your coding agent (Cursor / Claude Code / Codex) so it picks up the doucopy MCP server");
    messages.push('run "doucopy chat" to start asking peers');
    return { ok: true, messages, errors };
  }

  installDaemon(home);
  messages.push("installed and started the responder daemon");

  for (let i = 0; i < 15; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const status = await fetchStatus(input.relayUrl, input.token);
      if (status.self_online) {
        clearDraft(home);
        messages.push("daemon is online, setup complete");
        messages.push("restart your coding agent (Cursor / Claude Code / Codex) so it picks up the doucopy MCP server");
        messages.push('run "doucopy chat" to open the terminal REPL, or "doucopy policy" to edit the filter');
        return { ok: true, messages, errors };
      }
    } catch {
      // relay may briefly reject while the daemon warms up, keep waiting
    }
  }
  errors.push("daemon did not come online within 30s, check: doucopy logs");
  return { ok: false, messages, errors };
}

export { peerNameChoices, defaultName, NAME_PATTERN, NEVER_REVEAL_PRESETS };
