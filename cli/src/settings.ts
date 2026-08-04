import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { detectResponders, responderHarnessDisabledReason, writeConfig, type HarnessKind } from "./setup.js";
import { RESPONDER_DAEMON_UNSUPPORTED, responderDaemonSupported, startDaemon, stopDaemon } from "./launchd.js";

export type FsWriteMode = "workspace_only" | "custom";
export type ShellMode = "off" | "deny_patterns" | "open";

export interface RestrictionsSettings {
  fs_write: { mode: FsWriteMode; allow: string[] };
  fs_read: { deny: string[] };
  shell: { mode: ShellMode; deny: string[] };
}

export interface DoucopyConfigFile {
  relay_url?: string;
  self_peer?: string;
  token?: string;
  memory_sources?: unknown;
  responder?: {
    harness?: HarnessKind;
    binary?: string;
    cursor_agent_binary?: string;
    workspace_dir?: string;
    response_timeout_seconds?: number;
    max_concurrent?: number;
    model?: string;
    persona?: string;
    extra_args?: string[];
  };
  restrictions?: {
    fs_write?: { mode?: FsWriteMode; allow?: string[] };
    fs_read?: { deny?: string[] };
    shell?: { mode?: ShellMode; deny?: string[] };
  };
  redact?: { literals?: string[]; patterns?: string[] };
  keep_awake?: {
    enabled?: boolean;
    confirm_days?: number;
    confirm_grace_hours?: number;
  };
  [key: string]: unknown;
}

export interface KeepAwakeSettings {
  enabled: boolean;
  confirm_days: number;
  confirm_grace_hours: number;
}

export const DEFAULT_KEEP_AWAKE_SETTINGS: KeepAwakeSettings = {
  enabled: true,
  confirm_days: 3,
  confirm_grace_hours: 24,
};

export function keepAwakeFromConfig(config: DoucopyConfigFile): KeepAwakeSettings {
  return {
    enabled: config.keep_awake?.enabled ?? DEFAULT_KEEP_AWAKE_SETTINGS.enabled,
    confirm_days: config.keep_awake?.confirm_days ?? DEFAULT_KEEP_AWAKE_SETTINGS.confirm_days,
    confirm_grace_hours:
      config.keep_awake?.confirm_grace_hours ?? DEFAULT_KEEP_AWAKE_SETTINGS.confirm_grace_hours,
  };
}

export function applyKeepAwake(config: DoucopyConfigFile, keepAwake: KeepAwakeSettings): DoucopyConfigFile {
  return {
    ...config,
    keep_awake: {
      enabled: keepAwake.enabled,
      confirm_days: keepAwake.confirm_days,
      confirm_grace_hours: keepAwake.confirm_grace_hours,
    },
  };
}

export function summarizeKeepAwake(k: KeepAwakeSettings): string {
  if (!k.enabled) return "off (machine may idle-sleep)";
  if (k.confirm_days <= 0) return "on, no periodic confirm";
  return `on, confirm every ${k.confirm_days}d (grace ${k.confirm_grace_hours}h)`;
}

export const SAFE_RESTRICTIONS: RestrictionsSettings = {
  fs_write: { mode: "workspace_only", allow: [] },
  fs_read: { deny: [] },
  shell: { mode: "off", deny: [] },
};

export function configPath(home: string): string {
  return path.join(home, ".doucopy", "config.json");
}

export function readConfigFile(home: string): DoucopyConfigFile | null {
  const file = configPath(home);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as DoucopyConfigFile;
  } catch {
    return null;
  }
}

export function restrictionsFromConfig(config: DoucopyConfigFile | null): RestrictionsSettings {
  if (!config?.restrictions) {
    return {
      fs_write: { ...SAFE_RESTRICTIONS.fs_write, allow: [] },
      fs_read: { deny: [] },
      shell: { ...SAFE_RESTRICTIONS.shell, deny: [] },
    };
  }
  return {
    fs_write: {
      mode: config.restrictions.fs_write?.mode ?? "workspace_only",
      allow: [...(config.restrictions.fs_write?.allow ?? [])],
    },
    fs_read: {
      deny: [...(config.restrictions.fs_read?.deny ?? [])],
    },
    shell: {
      mode: config.restrictions.shell?.mode ?? "off",
      deny: [...(config.restrictions.shell?.deny ?? [])],
    },
  };
}

export function applyRestrictions(config: DoucopyConfigFile, restrictions: RestrictionsSettings): DoucopyConfigFile {
  return {
    ...config,
    restrictions: {
      fs_write: {
        mode: restrictions.fs_write.mode,
        allow: [...restrictions.fs_write.allow],
      },
      fs_read: { deny: [...restrictions.fs_read.deny] },
      shell: {
        mode: restrictions.shell.mode,
        deny: [...restrictions.shell.deny],
      },
    },
  };
}

export function applyResponderField(
  config: DoucopyConfigFile,
  field: "model" | "persona",
  value: string | undefined,
): DoucopyConfigFile {
  const responder = { ...(config.responder ?? {}) };
  if (value === undefined || value.trim() === "") {
    delete responder[field];
  } else {
    responder[field] = value.trim();
  }
  return { ...config, responder };
}

export function applyHarness(config: DoucopyConfigFile, harness: HarnessKind): DoucopyConfigFile {
  const responder = { ...(config.responder ?? {}) };
  responder.harness = harness;
  responder.binary = harness;
  if (harness === "cursor-agent") {
    responder.cursor_agent_binary = responder.cursor_agent_binary ?? "cursor-agent";
  } else {
    delete responder.cursor_agent_binary;
  }
  return { ...config, responder };
}

export function applyRedactLiterals(config: DoucopyConfigFile, literals: string[]): DoucopyConfigFile {
  const redact = { ...(config.redact ?? {}) };
  redact.literals = [...literals];
  if (redact.patterns === undefined) redact.patterns = [];
  return { ...config, redact };
}

export function summarizeRestrictions(r: RestrictionsSettings): string {
  const write =
    r.fs_write.mode === "workspace_only"
      ? "write=workspace_only"
      : `write=custom(${r.fs_write.allow.join(", ") || "none"})`;
  const read = `read_deny=${r.fs_read.deny.length > 0 ? r.fs_read.deny.join(", ") : "(built-in only)"}`;
  const shell =
    r.shell.mode === "deny_patterns"
      ? `shell=deny_patterns(${r.shell.deny.join(", ") || "none"})`
      : `shell=${r.shell.mode}`;
  return `${write}, ${read}, ${shell}`;
}

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const WRITE_ALLOW_PRESETS = [
  "~/Desktop",
  "~/Documents",
  "~/Downloads",
  "~/Movies",
  "~/Music",
  "~/Pictures",
  "~/Public",
  "/tmp",
] as const;

export const READ_DENY_PRESETS = [
  "~/Documents",
  "~/Downloads",
  "~/Desktop",
  "~/Library",
  "~/Movies",
  "~/Pictures",
  "~/.gnupg",
  "~/.config",
  "~/.kube",
  "~/.docker",
  "~/.npm",
  "~/.local",
  "~/Dropbox",
  "~/Library/CloudStorage",
] as const;

export const SHELL_DENY_PRESETS = [
  "rm",
  "sudo",
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "chmod",
  "chown",
  "kill",
  "pkill",
  "git push",
  "git commit",
  "brew",
  "npm publish",
  "npx",
  "pip",
  "docker",
  "kubectl",
  "heroku",
  "osascript",
  "open",
] as const;

export const REDACT_LITERAL_PRESETS = [
  "password",
  "secret",
  "api_key",
  "token",
  "Bearer",
  "sk-",
  "AKIA",
] as const;

async function pickPresetsWithCustom(
  message: string,
  presets: readonly string[],
  current: string[],
): Promise<string[]> {
  const currentSet = new Set(current);
  const picked = await checkbox<string>({
    message: `${message} (space to toggle, enter to confirm)`,
    choices: presets.map((p) => ({ value: p, name: p, checked: currentSet.has(p) })),
  });
  const extras = current.filter((v) => !(presets as readonly string[]).includes(v));
  const merged = new Set<string>([...picked, ...extras]);
  let addMore = await select<"done" | "custom">({
    message: `${message}: add custom values?`,
    choices: [
      { value: "done", name: "Done (use selection above)" },
      { value: "custom", name: "Add custom values..." },
    ],
    default: extras.length > 0 ? "custom" : "done",
  });
  while (addMore === "custom") {
    const extraRaw = await input({
      message: "Custom values (comma-separated)",
      default: extras.join(", "),
    });
    for (const v of splitCsv(extraRaw)) merged.add(v);
    addMore = await select<"done" | "custom">({
      message: "Add more custom values?",
      choices: [
        { value: "done", name: "Done" },
        { value: "custom", name: "Add more..." },
      ],
      default: "done",
    });
  }
  return Array.from(merged);
}

async function editRestrictionsInteractive(current: RestrictionsSettings): Promise<RestrictionsSettings> {
  console.log(`Current restrictions: ${summarizeRestrictions(current)}`);
  const writeMode = await select<FsWriteMode>({
    message: "File write mode",
    choices: [
      { value: "workspace_only", name: "workspace_only (safe default: only ~/.doucopy/workspace)" },
      { value: "custom", name: "custom (workspace + extra folders)" },
    ],
    default: current.fs_write.mode,
  });
  let allow: string[] = [];
  if (writeMode === "custom") {
    allow = await pickPresetsWithCustom(
      "Extra write-allow folders",
      WRITE_ALLOW_PRESETS,
      current.fs_write.allow,
    );
  }
  const readDeny = await pickPresetsWithCustom(
    "Extra read-deny folders (~/.ssh, ~/.aws, ~/.doucopy secrets always denied)",
    READ_DENY_PRESETS,
    current.fs_read.deny,
  );
  const shellMode = await select<ShellMode>({
    message: "Shell mode",
    choices: [
      { value: "off", name: "off (safe default)" },
      { value: "deny_patterns", name: "deny_patterns (allow shell except listed)" },
      { value: "open", name: "open (shell allowed)" },
    ],
    default: current.shell.mode,
  });
  let shellDeny: string[] = [];
  if (shellMode === "deny_patterns") {
    shellDeny = await pickPresetsWithCustom(
      "Shell deny patterns",
      SHELL_DENY_PRESETS,
      current.shell.deny,
    );
  }
  return {
    fs_write: { mode: writeMode, allow },
    fs_read: { deny: readDeny },
    shell: { mode: shellMode, deny: shellDeny },
  };
}

/** Model ids offered in settings, keyed by responder harness. */
export const MODEL_PRESETS: Record<HarnessKind, readonly string[]> = {
  "cursor-agent": [
    "composer-2.5",
    "composer-2.5-fast",
    "auto",
    "gpt-5",
    "sonnet-4-thinking",
  ],
  claude: ["sonnet", "opus", "haiku", "fable", "claude-sonnet-5", "claude-opus-4-8"],
  codex: [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.2",
  ],
};

export function modelPresetsFor(harness: HarnessKind): readonly string[] {
  return MODEL_PRESETS[harness];
}

export function isModelValidForHarness(model: string | undefined, harness: HarnessKind): boolean {
  if (model === undefined || model.trim() === "") return true;
  return (MODEL_PRESETS[harness] as readonly string[]).includes(model);
}

const PERSONA_PRESETS = [
  { id: "concise", label: "Concise, friendly", value: "Reply concisely with a friendly tone. Cite files or dates when helpful." },
  { id: "detailed", label: "Detailed with reasoning", value: "Show short reasoning and cite the source (file path, date, transcript)." },
  { id: "bullet", label: "Bullet points only", value: "Answer using short bullet points only. No preamble. Cite sources when helpful." },
  { id: "strict", label: "Strict factual", value: "Answer only from the listed memory sources. If unknown, say you do not know. No speculation." },
  { id: "teacher", label: "Teach / explain", value: "Explain clearly as if teaching a teammate. Use short examples. Cite where the fact came from." },
] as const;

async function pickModel(current: string | undefined, harness: HarnessKind): Promise<string> {
  const CUSTOM = "__custom__";
  const DEFAULT = "__default__";
  const presets = modelPresetsFor(harness);
  const currentIsPreset = current !== undefined && (presets as readonly string[]).includes(current);
  const initial = current === undefined || current === "" ? DEFAULT : currentIsPreset ? current : CUSTOM;
  const choice = await select<string>({
    message: `Responder model (${harness})`,
    choices: [
      { value: DEFAULT, name: "(harness default)" },
      ...presets.map((m) => ({ value: m, name: m })),
      { value: CUSTOM, name: "Custom..." },
    ],
    default: initial,
  });
  if (choice === DEFAULT) return "";
  if (choice !== CUSTOM) return choice;
  return input({
    message: "Custom model id",
    default: currentIsPreset ? "" : current ?? "",
  });
}

async function pickPersona(current: string | undefined): Promise<string> {
  const CUSTOM = "__custom__";
  const NONE = "__none__";
  const match = PERSONA_PRESETS.find((p) => p.value === current);
  const initial = current === undefined || current.trim() === "" ? NONE : match?.id ?? CUSTOM;
  const choice = await select<string>({
    message: "Persona / response style",
    choices: [
      { value: NONE, name: "(none)" },
      ...PERSONA_PRESETS.map((p) => ({ value: p.id, name: p.label })),
      { value: CUSTOM, name: "Custom..." },
    ],
    default: initial,
  });
  if (choice === NONE) return "";
  if (choice === CUSTOM) {
    return input({
      message: "Custom persona (single line)",
      default: match ? "" : current ?? "",
    });
  }
  const preset = PERSONA_PRESETS.find((p) => p.id === choice);
  return preset ? preset.value : "";
}

async function pickRedactLiterals(current: string[]): Promise<string[]> {
  return pickPresetsWithCustom(
    "Redact literals (stripped from every answer)",
    REDACT_LITERAL_PRESETS,
    current,
  );
}

function openPolicyEditor(home: string): void {
  const dir = path.join(home, ".doucopy");
  const file = path.join(dir, "policy.md");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      "You are answering an agent from another account of the same human circle.\n\n## Never reveal\n\n- \n",
    );
  }
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? "nano";
  if (!process.stdin.isTTY) {
    console.log(`policy file: ${file}`);
    return;
  }
  const res = spawnSync(editor, [file], { stdio: "inherit" });
  if (res.error) {
    console.error(`could not launch ${editor}: ${res.error.message}`);
    console.log(`edit this file manually: ${file}`);
  }
}

/**
 * Interactive restrictions + optional filtering prompts shared by join and settings.
 * Returns null when the user skips (join skip = keep safe default / leave unchanged).
 */
export async function promptRestrictionsStep(
  current: RestrictionsSettings,
  opts: { allowSkip: boolean; skipLabel?: string } = { allowSkip: false },
): Promise<RestrictionsSettings | "skip"> {
  if (opts.allowSkip) {
    const action = await select<"edit" | "skip">({
      message: "Configure responder restrictions?",
      choices: [
        { value: "edit", name: "Configure now" },
        { value: "skip", name: opts.skipLabel ?? "Skip (keep safe default: workspace writes only, shell off)" },
      ],
      default: "skip",
    });
    if (action === "skip") return "skip";
  }
  return editRestrictionsInteractive(current);
}

export async function runSettings(home: string = homedir()): Promise<void> {
  let config = readConfigFile(home);
  if (!config) {
    throw new Error(`no config at ${configPath(home)}. Run "doucopy join" first.`);
  }

  let dirty = false;
  let section: string | undefined = "menu";
  while (
    section === "menu"
    || section === "restrictions"
    || section === "filtering"
    || section === "model"
    || section === "persona"
    || section === "harness"
    || section === "keep_awake"
  ) {
    const restrictions = restrictionsFromConfig(config);
    const keepAwake = keepAwakeFromConfig(config);
    console.log("");
    console.log(`Peer: ${config.self_peer ?? "?"} @ ${config.relay_url ?? "?"}`);
    console.log(`Restrictions: ${summarizeRestrictions(restrictions)}`);
    console.log(`Model: ${config.responder?.model ?? "(harness default)"}`);
    console.log(`Persona: ${config.responder?.persona?.trim() ? config.responder.persona : "(none)"}`);
    console.log(`Harness: ${config.responder?.harness ?? "cursor-agent"}`);
    console.log(`Keep awake: ${summarizeKeepAwake(keepAwake)}`);
    console.log(`Redact literals: ${(config.redact?.literals ?? []).join(", ") || "(none)"}`);

    section = await select({
      message: "Settings section",
      choices: [
        { value: "restrictions", name: "Restrictions (write folders, read blocklist, shell)" },
        { value: "filtering", name: "Filtering (policy.md + redact literals)" },
        { value: "model", name: "Model" },
        { value: "persona", name: "Persona (response style)" },
        { value: "harness", name: "Harness" },
        { value: "keep_awake", name: "Keep awake (prevent sleep while answering)" },
        { value: "done", name: "Save and finish" },
      ],
    });

    if (section === "restrictions") {
      const next = await editRestrictionsInteractive(restrictions);
      config = applyRestrictions(config, next);
      dirty = true;
      section = "menu";
      continue;
    }
    if (section === "filtering") {
      const openPolicy = await confirm({
        message: "Open ~/.doucopy/policy.md in $EDITOR?",
        default: true,
      });
      if (openPolicy) openPolicyEditor(home);
      const literals = await pickRedactLiterals(config.redact?.literals ?? []);
      config = applyRedactLiterals(config, literals);
      dirty = true;
      section = "menu";
      continue;
    }
    if (section === "model") {
      const harness = config.responder?.harness ?? "cursor-agent";
      const model = await pickModel(config.responder?.model, harness);
      config = applyResponderField(config, "model", model);
      dirty = true;
      section = "menu";
      continue;
    }
    if (section === "persona") {
      const persona = await pickPersona(config.responder?.persona);
      config = applyResponderField(config, "persona", persona);
      dirty = true;
      section = "menu";
      continue;
    }
    if (section === "harness") {
      const detected = detectResponders();
      const previous = config.responder?.harness ?? "cursor-agent";
      const disabledFor = (present: boolean) => responderHarnessDisabledReason(present) ?? false;
      const harness = await select<HarnessKind>({
        message: "Responder harness",
        choices: [
          { value: "cursor-agent", name: "cursor-agent", disabled: disabledFor(detected.cursor) },
          { value: "claude", name: "claude", disabled: disabledFor(detected.claude) },
          { value: "codex", name: "codex", disabled: disabledFor(detected.codex) },
        ],
        default: previous,
      });
      config = applyHarness(config, harness);
      if (harness !== previous && !isModelValidForHarness(config.responder?.model, harness)) {
        console.log(`Model "${config.responder?.model ?? ""}" is not valid for ${harness}. Pick a new one.`);
        const model = await pickModel(undefined, harness);
        config = applyResponderField(config, "model", model);
      }
      dirty = true;
      section = "menu";
      continue;
    }
    if (section === "keep_awake") {
      const current = keepAwakeFromConfig(config);
      const enabled = await confirm({
        message: "Prevent idle sleep while the responder daemon runs?",
        default: current.enabled,
      });
      let confirm_days = 0;
      let confirm_grace_hours = current.confirm_grace_hours;
      if (enabled) {
        const daysRaw = await input({
          message: "Ask every N days whether to keep it (0 = never ask)",
          default: String(current.confirm_days),
          validate: (v) => {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0) return "enter a non-negative integer";
            return true;
          },
        });
        confirm_days = Number(daysRaw);
        if (confirm_days > 0) {
          const graceRaw = await input({
            message: "Hours to wait for an answer before stopping the daemon",
            default: String(current.confirm_grace_hours),
            validate: (v) => {
              const n = Number(v);
              if (!Number.isFinite(n) || n <= 0) return "enter a positive number";
              return true;
            },
          });
          confirm_grace_hours = Number(graceRaw);
        }
      }
      config = applyKeepAwake(config, { enabled, confirm_days, confirm_grace_hours });
      dirty = true;
      section = "menu";
      continue;
    }
  }

  if (dirty) {
    const file = writeConfig(home, config);
    console.log(`wrote ${file}`);
  } else {
    console.log("no changes");
  }

  if (dirty && process.stdin.isTTY) {
    if (!responderDaemonSupported()) {
      console.log(RESPONDER_DAEMON_UNSUPPORTED);
    } else {
      const restart = await confirm({
        message: "Restart the responder daemon now so changes take effect?",
        default: true,
      });
      if (restart) {
        try {
          stopDaemon(home);
          startDaemon(home);
          console.log("daemon restarted");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`could not restart daemon: ${message}`);
          console.log('run "doucopy restart" manually');
        }
      } else {
        console.log('run "doucopy restart" when you want the daemon to reload config');
      }
    }
  }
}

/** Non-interactive helper used by tests and join --yes path. */
export function writeRestrictionsToHome(home: string, restrictions: RestrictionsSettings): string {
  const existing = readConfigFile(home);
  if (!existing) throw new Error(`no config at ${configPath(home)}`);
  return writeConfig(home, applyRestrictions(existing, restrictions));
}
