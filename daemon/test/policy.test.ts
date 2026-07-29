import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePolicy, readPolicy } from "../src/policy.js";

function tmpFile(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "doucopy-policy-"));
  const file = path.join(dir, "policy.md");
  writeFileSync(file, contents);
  return file;
}

describe("parsePolicy", () => {
  it("returns the full source as text", () => {
    const source = "You are a responder.\n\nRules: be brief.\n";
    expect(parsePolicy(source).text).toBe(source);
  });

  it("returns an empty rule set when there is no Never reveal section", () => {
    const source = "Just a policy.\n";
    expect(parsePolicy(source).neverReveal).toEqual({ literals: [], patterns: [] });
  });

  it("collects bullet items from a `## Never reveal` section into literals", () => {
    const source = [
      "You are a responder.",
      "",
      "## Never reveal",
      "",
      "- Acme Corp",
      "- codename yellowstone",
      "",
      "## Something else",
      "- ignored",
    ].join("\n");
    const parsed = parsePolicy(source);
    expect(parsed.neverReveal.literals).toEqual(["Acme Corp", "codename yellowstone"]);
    expect(parsed.neverReveal.patterns).toEqual([]);
  });

  it("recognises `/regex/` bullets as patterns", () => {
    const source = [
      "## Never reveal",
      "",
      "- Acme Corp",
      "- /internal-project-\\d+/",
      "- /sk-[a-z0-9]+/i",
    ].join("\n");
    const parsed = parsePolicy(source);
    expect(parsed.neverReveal.literals).toEqual(["Acme Corp"]);
    expect(parsed.neverReveal.patterns).toEqual(["internal-project-\\d+", "sk-[a-z0-9]+"]);
  });

  it("supports synonym headings and different bullet markers", () => {
    const source = [
      "### Do not reveal",
      "",
      "* Acme",
      "+ Widget",
      "- Gadget",
    ].join("\n");
    const parsed = parsePolicy(source);
    expect(parsed.neverReveal.literals).toEqual(["Acme", "Widget", "Gadget"]);
  });

  it("stops collecting once a new heading starts", () => {
    const source = [
      "## Never reveal",
      "- keep me",
      "## Follow-up",
      "- drop me",
    ].join("\n");
    expect(parsePolicy(source).neverReveal.literals).toEqual(["keep me"]);
  });
});

describe("readPolicy", () => {
  it("returns empty policy when the file does not exist", () => {
    const parsed = readPolicy("/nonexistent/policy.md");
    expect(parsed.text).toBe("");
    expect(parsed.neverReveal).toEqual({ literals: [], patterns: [] });
  });

  it("reads and parses a real file on disk", () => {
    const file = tmpFile(["## Never reveal", "- Acme"].join("\n"));
    expect(readPolicy(file).neverReveal.literals).toEqual(["Acme"]);
  });
});
