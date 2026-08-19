import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Attachment } from "./types.js";

const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Materialize asker attachments under conversationWorkspace/inbox/.
 * Names were already validated on the relay; re-check basename safety here.
 * Returns relative paths (inbox/<name>) for the prompt.
 */
export function writeInboxAttachments(
  conversationWorkspace: string,
  attachments: Attachment[] | undefined,
): string[] {
  if (!attachments || attachments.length === 0) return [];
  const inboxDir = path.join(conversationWorkspace, "inbox");
  mkdirSync(inboxDir, { recursive: true });
  const relativePaths: string[] = [];
  for (const file of attachments) {
    const name = file.name.trim();
    if (!NAME_RE.test(name) || name.includes("..") || name.includes("/") || name.includes("\\")) {
      throw new Error(`refusing unsafe attachment name: ${file.name}`);
    }
    const dest = path.join(inboxDir, name);
    if (path.dirname(dest) !== inboxDir) {
      throw new Error(`refusing attachment path escape: ${file.name}`);
    }
    writeFileSync(dest, file.content, { encoding: "utf8", mode: 0o600 });
    relativePaths.push(path.posix.join("inbox", name));
  }
  return relativePaths;
}
