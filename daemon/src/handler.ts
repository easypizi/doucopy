import fg from "fast-glob";
import path from "node:path";
import { normalizeTranscriptGlobs, resolveHarness, type DaemonConfig } from "./config.js";
import type { ConversationStore } from "./conversations.js";
import { createHarness, type Harness, type HarnessOptions } from "./harness.js";
import { isPaused, pausedUntil } from "./paused.js";
import {
  buildPermissions,
  claudeSettingsArg,
  logRestrictionsSummary,
  materializeCursorPermissions,
} from "./permissions.js";
import type { QuestionHandler } from "./poller.js";
import { readPolicy } from "./policy.js";
import { buildFirstTask, buildFollowupTask, type MemoryMap } from "./prompt.js";
import { applyRedactions, compileRedactRules } from "./redact.js";
import { safeDirName } from "./workspace.js";

function collectMemory(config: DaemonConfig): MemoryMap {
  const globs = normalizeTranscriptGlobs(config.memory_sources.transcripts_glob);
  const transcript_files = fg.sync(globs, { absolute: true });
  const agents_md_files = config.memory_sources.agents_md_roots.flatMap((root) =>
    fg.sync(path.join(root, "**/AGENTS.md"), { absolute: true }),
  );
  return { transcript_files, agents_md_files, extra_files: config.memory_sources.extra_files };
}

export function createHandler(
  config: DaemonConfig,
  store: ConversationStore,
  policyPath: string,
  injectedHarness?: Harness,
): QuestionHandler {
  const { kind, binary } = resolveHarness(config);
  const harness = injectedHarness ?? createHarness(kind);
  const baseRunnerOpts: HarnessOptions = {
    binary,
    workspaceDir: config.responder.workspace_dir,
    timeoutMs: config.responder.response_timeout_seconds * 1000,
    model: config.responder.model,
    extraArgs: config.responder.extra_args,
  };

  // Deterministic post-filter: runs in daemon code, outside the LLM, so the
  // asking agent cannot talk its way around it. Rules come from two sources:
  // the `## Never reveal` section of policy.md (single documented place for
  // users) and the legacy `redact` field in config.json (still honoured for
  // back-compat). Re-parsed per question so edits to policy.md take effect
  // without a daemon restart.
  const redactResult = (parsedNeverReveal: { literals: string[]; patterns: string[] }, result: { answer?: string; error?: string }) => {
    const rules = compileRedactRules({
      literals: [...(config.redact?.literals ?? []), ...parsedNeverReveal.literals],
      patterns: [...(config.redact?.patterns ?? []), ...parsedNeverReveal.patterns],
    });
    const out = { ...result };
    if (out.answer !== undefined) {
      const { text, redactedCount } = applyRedactions(out.answer, rules);
      out.answer = text;
      if (redactedCount > 0) {
        console.error(`redacted ${redactedCount} match(es) from an outgoing answer`);
      }
    }
    if (out.error !== undefined) {
      out.error = applyRedactions(out.error, rules).text;
    }
    return out;
  };

  return async (question) => {
    const parsedPolicy = readPolicy(policyPath);
    if (isPaused(question.from_peer)) {
      const until = pausedUntil(question.from_peer);
      const suffix = typeof until === "number" ? ` until ${new Date(until).toISOString()}` : "";
      return redactResult(parsedPolicy.neverReveal, { error: `peer paused${suffix}` });
    }
    const conversationWorkspace = path.join(
      config.responder.workspace_dir,
      safeDirName(question.conversation_id),
    );
    const perms = buildPermissions(config, conversationWorkspace);
    logRestrictionsSummary(perms);
    if (kind === "cursor-agent") {
      materializeCursorPermissions(conversationWorkspace, perms);
    }
    const runnerOpts: HarnessOptions = {
      ...baseRunnerOpts,
      workspaceDir: conversationWorkspace,
      claudeSettingsJson: kind === "claude" ? claudeSettingsArg(perms) : undefined,
      codexSandbox: kind === "codex" ? perms.codexSandbox : undefined,
    };
    const promptOpts = {
      persona: config.responder.persona,
      restrictions: perms.restrictions,
      writeRoots: perms.writeRoots,
    };
    try {
      const existingSessionId = store.get(question.conversation_id);
      const isFirstTurn = existingSessionId === null;
      const ctx = {
        fromPeer: question.from_peer,
        conversationId: question.conversation_id,
        hops: question.hops,
      };
      const task = isFirstTurn
        ? buildFirstTask(parsedPolicy.text, question.question, collectMemory(config), ctx, promptOpts)
        : buildFollowupTask(parsedPolicy.text, question.question, ctx, promptOpts);
      const result = isFirstTurn
        ? await harness.runFirstTask(runnerOpts, task)
        : await harness.runFollowupTask(runnerOpts, existingSessionId as string, task);
      if (result.answer !== undefined) {
        // First turn: persist the sessionId the harness discovered/created.
        // Follow-up: keep the existing id; harnesses do not re-emit it.
        const nextId = isFirstTurn ? result.sessionId : existingSessionId;
        if (nextId) store.set(question.conversation_id, nextId);
      }
      return redactResult(parsedPolicy.neverReveal, { answer: result.answer, error: result.error });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return redactResult(parsedPolicy.neverReveal, { error: `responder failed: ${message.slice(0, 500)}` });
    }
  };
}
