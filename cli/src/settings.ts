import { confirm, input, select } from "@inquirer/prompts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { detectResponders, writeConfig, type HarnessKind } from "./setup.js";
import { startDaemon, stopDaemon } from "./launchd.js";

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
  [key: string]: unknown;
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
  let allow = current.fs_write.allow;
  if (writeMode === "custom") {
    const raw = await input({
      message: "Extra write-allow folders (comma-separated, e.g. ~/Desktop)",
      default: allow.join(", "),
    });
    allow = splitCsv(raw);
  } else {
    allow = [];
  }
  const readRaw = await input({
    message: "Extra read-deny folders (comma-separated, empty for none). ~/.ssh ~/.aws ~/.doucopy always denied.",
    default: current.fs_read.deny.join(", "),
  });
  const shellMode = await select<ShellMode>({
    message: "Shell mode",
    choices: [
      { value: "off", name: "off (safe default)" },
      { value: "deny_patterns", name: "deny_patterns (allow shell except listed)" },
      { value: "open", name: "open (shell allowed)" },
    ],
    default: current.shell.mode,
  });
  let shellDeny = current.shell.deny;
  if (shellMode === "deny_patterns") {
    const raw = await input({
      message: "Shell deny patterns (comma-separated, e.g. rm, curl, git push)",
      default: shellDeny.join(", "),
    });
    shellDeny = splitCsv(raw);
  } else {
    shellDeny = [];
  }
  return {
    fs_write: { mode: writeMode, allow },
    fs_read: { deny: splitCsv(readRaw) },
    shell: { mode: shellMode, deny: shellDeny },
  };
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
  while (section === "menu" || section === "restrictions" || section === "filtering" || section === "model" || section === "persona" || section === "harness") {
    const restrictions = restrictionsFromConfig(config);
    console.log("");
    console.log(`Peer: ${config.self_peer ?? "?"} @ ${config.relay_url ?? "?"}`);
    console.log(`Restrictions: ${summarizeRestrictions(restrictions)}`);
    console.log(`Model: ${config.responder?.model ?? "(harness default)"}`);
    console.log(`Persona: ${config.responder?.persona?.trim() ? config.responder.persona : "(none)"}`);
    console.log(`Harness: ${config.responder?.harness ?? "cursor-agent"}`);
    console.log(`Redact literals: ${(config.redact?.literals ?? []).join(", ") || "(none)"}`);

    section = await select({
      message: "Settings section",
      choices: [
        { value: "restrictions", name: "Restrictions (write folders, read blocklist, shell)" },
        { value: "filtering", name: "Filtering (policy.md + redact literals)" },
        { value: "model", name: "Model" },
        { value: "persona", name: "Persona (response style)" },
        { value: "harness", name: "Harness" },
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
      const literalsRaw = await input({
        message: "Redact literals (comma-separated, stripped from every answer)",
        default: (config.redact?.literals ?? []).join(", "),
      });
      config = applyRedactLiterals(config, splitCsv(literalsRaw));
      dirty = true;
      section = "menu";
      continue;
    }
    if (section === "model") {
      const model = await input({
        message: "Responder model id (empty = harness default)",
        default: config.responder?.model ?? "",
      });
      config = applyResponderField(config, "model", model);
      dirty = true;
      section = "menu";
      continue;
    }
    if (section === "persona") {
      const persona = await input({
        message: "Persona / response style (empty to clear)",
        default: config.responder?.persona ?? "",
      });
      config = applyResponderField(config, "persona", persona);
      dirty = true;
      section = "menu";
      continue;
    }
    if (section === "harness") {
      const detected = detectResponders();
      const harness = await select<HarnessKind>({
        message: "Responder harness",
        choices: [
          { value: "cursor-agent", name: "cursor-agent", disabled: detected.cursor ? false : "(not found on PATH)" },
          { value: "claude", name: "claude", disabled: detected.claude ? false : "(not found on PATH)" },
          { value: "codex", name: "codex", disabled: detected.codex ? false : "(not found on PATH)" },
        ],
        default: config.responder?.harness ?? "cursor-agent",
      });
      config = applyHarness(config, harness);
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

/** Non-interactive helper used by tests and join --yes path. */
export function writeRestrictionsToHome(home: string, restrictions: RestrictionsSettings): string {
  const existing = readConfigFile(home);
  if (!existing) throw new Error(`no config at ${configPath(home)}`);
  return writeConfig(home, applyRestrictions(existing, restrictions));
}
