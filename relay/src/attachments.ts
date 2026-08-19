import type { Attachment } from "./types.js";

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 512 * 1024;
export const MAX_ATTACHMENT_NAME_LEN = 128;
/**
 * Cap on attachment bytes waiting in one peer's inbox. The relay keeps queued
 * questions in memory, so an offline peer must not be able to fill the dyno.
 */
export const MAX_PEER_QUEUED_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Total UTF-8 size of an attachment set. */
export function attachmentsByteSize(attachments: Attachment[] | undefined): number {
  if (!attachments) return 0;
  let total = 0;
  for (const file of attachments) total += utf8ByteLength(file.content);
  return total;
}

/** Validate and normalize asker→responder text attachments. Throws AttachmentValidationError. */
export function normalizeAttachments(raw: unknown): Attachment[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new AttachmentValidationError("attachments must be an array");
  }
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_ATTACHMENTS) {
    throw new AttachmentValidationError(`at most ${MAX_ATTACHMENTS} attachments allowed`);
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  const out: Attachment[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new AttachmentValidationError("each attachment must be an object with name and content");
    }
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const content = typeof rec.content === "string" ? rec.content : null;

    if (!name || name.length > MAX_ATTACHMENT_NAME_LEN || !NAME_RE.test(name) || name.includes("..")) {
      throw new AttachmentValidationError(
        `attachment name must be 1–${MAX_ATTACHMENT_NAME_LEN} chars of [A-Za-z0-9._-] (no path separators)`,
      );
    }
    if (content === null) {
      throw new AttachmentValidationError(`attachment "${name}": content must be a UTF-8 string`);
    }
    if (content.length === 0) {
      throw new AttachmentValidationError(`attachment "${name}": content must not be empty`);
    }
    if (content.includes("\0")) {
      throw new AttachmentValidationError(`attachment "${name}": content must not contain null bytes`);
    }
    const bytes = utf8ByteLength(content);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentValidationError(
        `attachment "${name}": content exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
      );
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new AttachmentValidationError(`duplicate attachment name "${name}"`);
    }
    seen.add(key);
    totalBytes += bytes;
    if (totalBytes > MAX_ATTACHMENTS_TOTAL_BYTES) {
      throw new AttachmentValidationError(
        `attachments total size exceeds ${MAX_ATTACHMENTS_TOTAL_BYTES} bytes`,
      );
    }
    out.push({ name, content });
  }

  return out;
}
