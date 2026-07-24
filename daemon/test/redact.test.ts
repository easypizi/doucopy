import { describe, expect, it } from "vitest";
import { applyRedactions, compileRedactRules, REDACTED_MARK } from "../src/redact.js";

describe("compileRedactRules", () => {
  it("throws on an invalid user pattern", () => {
    expect(() => compileRedactRules({ patterns: ["[unclosed"] })).toThrow();
  });

  it("skips empty literals and patterns", () => {
    const rules = compileRedactRules({ literals: [""], patterns: [""] });
    const { text, redactedCount } = applyRedactions("plain text", rules);
    expect(text).toBe("plain text");
    expect(redactedCount).toBe(0);
  });
});

describe("applyRedactions", () => {
  it("redacts user literals case-insensitively and escapes regex metacharacters", () => {
    const rules = compileRedactRules({ literals: ["Acme Corp (internal)"] });
    const { text, redactedCount } = applyRedactions(
      "We shipped this for ACME CORP (INTERNAL) last month.",
      rules,
    );
    expect(text).toBe(`We shipped this for ${REDACTED_MARK} last month.`);
    expect(redactedCount).toBe(1);
  });

  it("redacts user regex patterns", () => {
    const rules = compileRedactRules({ patterns: ["project-\\w+"] });
    const { text, redactedCount } = applyRedactions("project-alpha and project-beta", rules);
    expect(text).toBe(`${REDACTED_MARK} and ${REDACTED_MARK}`);
    expect(redactedCount).toBe(2);
  });

  it("redacts built-in secret formats without any user config", () => {
    const rules = compileRedactRules();
    const samples = [
      "key sk-abcdefghij0123456789 end",
      "token ghp_abcdefghij0123456789 end",
      "aws AKIAABCDEFGHIJKLMNOP end",
      "slack xoxb-1234567890-abc end",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef12345 end",
    ];
    for (const sample of samples) {
      const { text, redactedCount } = applyRedactions(sample, rules);
      expect(redactedCount, sample).toBeGreaterThan(0);
      expect(text, sample).toContain(REDACTED_MARK);
    }
  });

  it("redacts multi-line private key blocks", () => {
    const rules = compileRedactRules();
    const input = [
      "before",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA",
      "-----END RSA PRIVATE KEY-----",
      "after",
    ].join("\n");
    const { text } = applyRedactions(input, rules);
    expect(text).toBe(`before\n${REDACTED_MARK}\nafter`);
  });

  it("leaves clean text untouched", () => {
    const rules = compileRedactRules({ literals: ["secret-name"] });
    const { text, redactedCount } = applyRedactions("nothing to hide here", rules);
    expect(text).toBe("nothing to hide here");
    expect(redactedCount).toBe(0);
  });
});
