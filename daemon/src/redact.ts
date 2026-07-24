export interface RedactConfig {
  literals: string[];
  patterns: string[];
}

export const REDACTED_MARK = "[redacted]";

// Always-on patterns for common secret formats. These run on every answer
// regardless of user configuration, so a leaked key never leaves the machine.
const BUILTIN_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style API keys
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub personal access tokens (classic)
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key ids
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileRedactRules(config?: Partial<RedactConfig>): RegExp[] {
  const rules = [...BUILTIN_PATTERNS];
  for (const literal of config?.literals ?? []) {
    if (literal.length === 0) continue;
    rules.push(new RegExp(escapeRegExp(literal), "gi"));
  }
  for (const pattern of config?.patterns ?? []) {
    if (pattern.length === 0) continue;
    // Throws on an invalid regex: config errors must fail fast at startup.
    rules.push(new RegExp(pattern, "gi"));
  }
  return rules;
}

export function applyRedactions(
  text: string,
  rules: RegExp[],
): { text: string; redactedCount: number } {
  let redactedCount = 0;
  let out = text;
  for (const rule of rules) {
    out = out.replace(rule, () => {
      redactedCount += 1;
      return REDACTED_MARK;
    });
  }
  return { text: out, redactedCount };
}
