import { existsSync, readFileSync } from "node:fs";

// Everything the responder needs from ~/.agent-link/policy.md:
//   - `text`: the whole file, forwarded verbatim as the policy prompt to
//     the answering harness. If the file is missing we pass an empty string
//     so the default builtin behaviour applies.
//   - `neverReveal`: parsed from the `## Never reveal` section (or its
//     synonyms), used as extra redaction rules on the *outgoing* answer.
//     Bullet lines become case-insensitive literal matches, bullets wrapped
//     in slashes (`/.../`) become regex patterns.
//
// Users edit this file in place with any editor; the daemon re-reads it on
// every question, so there's no restart step.
export interface ParsedPolicy {
  text: string;
  neverReveal: {
    literals: string[];
    patterns: string[];
  };
}

const HEADING_RE = /^\s*#{1,6}\s+(.+?)\s*$/;
const NEVER_REVEAL_HEADINGS = new Set([
  "never reveal",
  "never reveal:",
  "do not reveal",
  "never disclose",
]);

export function parsePolicy(source: string): ParsedPolicy {
  const literals: string[] = [];
  const patterns: string[] = [];
  const lines = source.split("\n");
  let inSection = false;
  for (const rawLine of lines) {
    const headingMatch = rawLine.match(HEADING_RE);
    if (headingMatch) {
      const heading = headingMatch[1].trim().toLowerCase();
      inSection = NEVER_REVEAL_HEADINGS.has(heading);
      continue;
    }
    if (!inSection) continue;
    const bullet = rawLine.match(/^\s*[-*+]\s+(.*\S)\s*$/);
    if (!bullet) continue;
    const item = bullet[1];
    // Regex form: /body/ or /body/flags — but we always run case-insensitive
    // globally in compileRedactRules, so the trailing flags are cosmetic.
    const asRegex = item.match(/^\/(.+)\/[a-z]*$/i);
    if (asRegex) {
      patterns.push(asRegex[1]);
    } else {
      literals.push(item);
    }
  }
  return { text: source, neverReveal: { literals, patterns } };
}

export function readPolicy(policyPath: string): ParsedPolicy {
  if (!existsSync(policyPath)) return { text: "", neverReveal: { literals: [], patterns: [] } };
  return parsePolicy(readFileSync(policyPath, "utf8"));
}
