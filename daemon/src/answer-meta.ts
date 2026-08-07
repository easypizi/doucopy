export type VerdictLevel = "yes" | "no" | "partial";

export interface AnswerMeta {
  answered?: VerdictLevel;
  refused?: "yes" | "no";
}

export interface ParsedAnswer {
  answer: string;
  answered?: VerdictLevel;
  refused?: "yes" | "no";
}

const META_BLOCK =
  /(?:^|\n)---doucopy-meta---\s*\n([\s\S]*?)\n---end---\s*$/i;

function parseLevel(raw: string | undefined): VerdictLevel | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "yes" || v === "no" || v === "partial") return v;
  return undefined;
}

function parseYn(raw: string | undefined): "yes" | "no" | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "yes" || v === "no") return v;
  return undefined;
}

/** Strip and parse the responder meta trailer. Missing trailer → plain answer. */
export function parseAnswerMeta(raw: string): ParsedAnswer {
  const text = raw.replace(/\s+$/u, "");
  const match = text.match(META_BLOCK);
  if (!match) return { answer: text.trimEnd() };
  const body = match[1] ?? "";
  const answered = parseLevel(body.match(/^\s*answered:\s*(\S+)/im)?.[1]);
  const refused = parseYn(body.match(/^\s*refused:\s*(\S+)/im)?.[1]);
  const answer = text.slice(0, match.index).trimEnd();
  return { answer, answered, refused };
}
