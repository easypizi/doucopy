import fg from "fast-glob";
import path from "node:path";
import type { DaemonConfig } from "./config.js";
import type { ConversationStore } from "./conversations.js";
import type { QuestionHandler } from "./poller.js";
import { buildFirstTask, buildFollowupTask, type MemoryMap } from "./prompt.js";
import { createChat, runTask, type RunnerOptions } from "./runner.js";

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
): QuestionHandler {
  const runnerOpts: RunnerOptions = {
    binary: config.responder.cursor_agent_binary,
    workspaceDir: config.responder.workspace_dir,
    timeoutMs: config.responder.response_timeout_seconds * 1000,
    model: config.responder.model,
  };

  return async (question) => {
    try {
      let chatId = store.get(question.conversation_id);
      const isFirstTurn = chatId === null;
      if (chatId === null) {
        chatId = await createChat(runnerOpts);
      }
      const task = isFirstTurn
        ? buildFirstTask(policy, question.question, collectMemory(config))
        : buildFollowupTask(policy, question.question);
      const result = await runTask(runnerOpts, chatId, task);
      if (result.answer !== undefined) store.set(question.conversation_id, chatId);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `responder failed: ${message.slice(0, 500)}` };
    }
  };
}
