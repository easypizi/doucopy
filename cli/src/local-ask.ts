import { mkdirSync } from "node:fs";
import path from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { DoucopyConfigFile } from "./settings.js";
import { binaryOnPath, mergeDiscoveredMemory } from "./setup.js";

export type LocalHarnessKind = "cursor-agent" | "claude" | "codex";

export interface LocalAskInput {
  home: string;
  question: string;
  conversationId?: string | null;
  config: DoucopyConfigFile;
  /** Injected for tests. */
  runFirst?: (opts: LocalRunnerOpts, task: string) => Promise<LocalAskResult>;
  runFollowup?: (opts: LocalRunnerOpts, sessionId: string, task: string) => Promise<LocalAskResult>;
}

export interface LocalAskResult {
  answer?: string;
  error?: string;
  conversationId: string;
  sessionId?: string;
}

export interface LocalRunnerOpts {
  binary: string;
  workspaceDir: string;
  timeoutMs: number;
  model?: string;
  kind: LocalHarnessKind;
}

const sessions = new Map<string, string>();

export function resolveLocalHarness(config: DoucopyConfigFile): {
  kind: LocalHarnessKind;
  binary: string;
  timeoutMs: number;
  model?: string;
} | { error: string } {
  const kind = (config.responder?.harness ?? "cursor-agent") as LocalHarnessKind;
  if (kind !== "cursor-agent" && kind !== "claude" && kind !== "codex") {
    return { error: `unsupported local harness: ${String(kind)}` };
  }
  const binary =
    config.responder?.binary
    ?? (kind === "cursor-agent" ? config.responder?.cursor_agent_binary : undefined)
    ?? (kind === "cursor-agent" ? "cursor-agent" : kind);
  if (!binaryOnPath(binary) && !(kind === "cursor-agent" && (binaryOnPath("cursor-agent") || binaryOnPath("agent")))) {
    return {
      error: `Local harness binary not found (${binary}). Configure harness in Setup/Settings.`,
    };
  }
  const resolvedBinary =
    kind === "cursor-agent" && !binaryOnPath(binary)
      ? binaryOnPath("agent")
        ? "agent"
        : "cursor-agent"
      : binary;
  const timeoutSec = config.responder?.response_timeout_seconds ?? 120;
  return {
    kind,
    binary: resolvedBinary,
    timeoutMs: Math.max(10, timeoutSec) * 1000,
    model: config.responder?.model,
  };
}

function buildLocalTask(home: string, question: string, config: DoucopyConfigFile): string {
  const mem = config.memory_sources as
    | { agents_md_roots?: string[]; extra_files?: string[]; skill_roots?: string[] }
    | undefined;
  const merged = mergeDiscoveredMemory(home, mem ?? {});
  const lines = [
    "You are the local coding agent on this machine (doucopy Chat local mode).",
    "Answer the user's question helpfully and concisely.",
    "Do not invent peer or relay context.",
    "You may use your harness's built-in memories and normally configured MCP tools.",
    "Never paste secrets or MCP env values into your answer.",
    "",
    "## Curated memory on this machine",
    "Extra files:",
    ...(merged.extra_files.length ? merged.extra_files.map((f) => `- ${f}`) : ["- (none)"]),
    "Skill / plan / rule roots (search as needed):",
    ...(merged.skill_roots.length ? merged.skill_roots.map((f) => `- ${f}`) : ["- (none)"]),
    "AGENTS.md roots:",
    ...(merged.agents_md_roots.length ? merged.agents_md_roots.map((f) => `- ${f}`) : ["- (none)"]),
    "",
    "## Question",
    question.trim(),
  ];
  return lines.join("\n");
}

async function defaultRunFirst(opts: LocalRunnerOpts, task: string): Promise<LocalAskResult> {
  const { createHarness } = await import("../../daemon/dist/harness.js");
  const harness = createHarness(opts.kind);
  const result = await harness.runFirstTask(
    {
      binary: opts.binary,
      workspaceDir: opts.workspaceDir,
      timeoutMs: opts.timeoutMs,
      model: opts.model,
    },
    task,
  );
  return {
    answer: result.answer,
    error: result.error,
    conversationId: "",
    sessionId: result.sessionId,
  };
}

async function defaultRunFollowup(
  opts: LocalRunnerOpts,
  sessionId: string,
  task: string,
): Promise<LocalAskResult> {
  const { createHarness } = await import("../../daemon/dist/harness.js");
  const harness = createHarness(opts.kind);
  const result = await harness.runFollowupTask(
    {
      binary: opts.binary,
      workspaceDir: opts.workspaceDir,
      timeoutMs: opts.timeoutMs,
      model: opts.model,
    },
    sessionId,
    task,
  );
  return {
    answer: result.answer,
    error: result.error,
    conversationId: "",
    sessionId: result.sessionId ?? sessionId,
  };
}

function harnessFromConfig(config: DoucopyConfigFile): {
  kind: LocalHarnessKind;
  binary: string;
  timeoutMs: number;
  model?: string;
} {
  const kind = (config.responder?.harness ?? "cursor-agent") as LocalHarnessKind;
  const binary =
    config.responder?.binary
    ?? (kind === "cursor-agent" ? config.responder?.cursor_agent_binary : undefined)
    ?? (kind === "cursor-agent" ? "cursor-agent" : kind);
  const timeoutSec = config.responder?.response_timeout_seconds ?? 120;
  return {
    kind,
    binary,
    timeoutMs: Math.max(10, timeoutSec) * 1000,
    model: config.responder?.model,
  };
}

/** Ask the local configured responder harness (no relay). */
export async function localAsk(input: LocalAskInput): Promise<LocalAskResult> {
  const conversationId = input.conversationId?.trim() || uuidv7();
  const usingInjected = Boolean(input.runFirst || input.runFollowup);
  if (!usingInjected) {
    const resolved = resolveLocalHarness(input.config);
    if ("error" in resolved) {
      return { error: resolved.error, conversationId };
    }
  }

  const resolved = harnessFromConfig(input.config);
  if (resolved.kind !== "cursor-agent" && resolved.kind !== "claude" && resolved.kind !== "codex") {
    return { error: `unsupported local harness: ${String(resolved.kind)}`, conversationId };
  }

  const workspaceDir = path.join(input.home, ".doucopy", "local-chat", conversationId);
  mkdirSync(workspaceDir, { recursive: true });

  const runnerOpts: LocalRunnerOpts = {
    binary: resolved.binary,
    workspaceDir,
    timeoutMs: resolved.timeoutMs,
    model: resolved.model,
    kind: resolved.kind,
  };
  const task = buildLocalTask(input.home, input.question, input.config);
  const existingSession = sessions.get(conversationId);
  const runFirst = input.runFirst ?? defaultRunFirst;
  const runFollowup = input.runFollowup ?? defaultRunFollowup;

  const result = existingSession
    ? await runFollowup(runnerOpts, existingSession, task)
    : await runFirst(runnerOpts, task);

  if (result.sessionId) sessions.set(conversationId, result.sessionId);

  return {
    answer: result.answer,
    error: result.error,
    conversationId,
    sessionId: result.sessionId ?? existingSession,
  };
}

/** Test helper. */
export function clearLocalAskSessions(): void {
  sessions.clear();
}
