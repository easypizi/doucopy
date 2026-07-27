import fg from "fast-glob";
import path from "node:path";
import { resolveHarness, type DaemonConfig } from "./config.js";
import type { ConversationStore } from "./conversations.js";
import { createHarness, type Harness, type HarnessOptions } from "./harness.js";
import { isPaused, pausedUntil } from "./paused.js";
import type { QuestionHandler } from "./poller.js";
import { buildFirstTask, buildFollowupTask, type MemoryMap } from "./prompt.js";
import { applyRedactions, compileRedactRules } from "./redact.js";
import { safeDirName } from "./workspace.js";

function collectMemory(config: DaemonConfig): MemoryMap {
  const transcript_files = fg.sync(config.memory_sources.transcripts_glob, { absolute: true });
  const agents_md_files = config.memory_sources.agents_md_roots.flatMap((root) =>
    fg.sync(path.join(root, "**/AGENTS.md"), { absolute: true }),
  );
  return { transcript_files, agents_md_files, extra_files: config.memory_sources.extra_files };
}

export function createHandler(
  config: DaemonConfig,
  store: ConversationStore,
  policy: string,
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
  const redactRules = compileRedactRules(config.redact);

  // Deterministic post-filter: runs in daemon code, outside the LLM, so the
  // asking agent cannot talk its way around it.
  const redactResult = (result: { answer?: string; error?: string }) => {
    const out = { ...result };
    if (out.answer !== undefined) {
      const { text, redactedCount } = applyRedactions(out.answer, redactRules);
      out.answer = text;
      if (redactedCount > 0) {
        console.error(`redacted ${redactedCount} match(es) from an outgoing answer`);
      }
    }
    if (out.error !== undefined) {
      out.error = applyRedactions(out.error, redactRules).text;
    }
    return out;
  };

  return async (question) => {
    if (isPaused(question.from_peer)) {
      const until = pausedUntil(question.from_peer);
      const suffix = typeof until === "number" ? ` until ${new Date(until).toISOString()}` : "";
      return redactResult({ error: `peer paused${suffix}` });
    }
    const runnerOpts: HarnessOptions = {
      ...baseRunnerOpts,
      workspaceDir: path.join(
        config.responder.workspace_dir,
        safeDirName(question.conversation_id),
      ),
    };
    try {
      let chatId = store.get(question.conversation_id);
      const isFirstTurn = chatId === null;
      if (chatId === null) {
        chatId = await harness.createSession(runnerOpts);
      }
      const ctx = {
        fromPeer: question.from_peer,
        conversationId: question.conversation_id,
        hops: question.hops,
      };
      const task = isFirstTurn
        ? buildFirstTask(policy, question.question, collectMemory(config), ctx)
        : buildFollowupTask(policy, question.question, ctx);
      const result = await harness.runTask(runnerOpts, chatId, task);
      if (result.answer !== undefined) store.set(question.conversation_id, chatId);
      return redactResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return redactResult({ error: `responder failed: ${message.slice(0, 500)}` });
    }
  };
}
