import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyHarness,
  applyRedactLiterals,
  applyResponderField,
  applyRestrictions,
  isModelValidForHarness,
  modelPresetsFor,
  readConfigFile,
  restrictionsFromConfig,
  SAFE_RESTRICTIONS,
  summarizeRestrictions,
  writeRestrictionsToHome,
} from "../src/settings.js";
import { defaultConfig, discoverMemorySources, writeConfig } from "../src/setup.js";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "doucopy-settings-"));
}

describe("settings helpers", () => {
  it("defaults missing restrictions to the safe profile", () => {
    const r = restrictionsFromConfig({ self_peer: "x" });
    expect(r).toEqual(SAFE_RESTRICTIONS);
    expect(summarizeRestrictions(r)).toContain("write=workspace_only");
    expect(summarizeRestrictions(r)).toContain("shell=off");
  });

  it("round-trips restrictions through config write/read", () => {
    const home = makeHome();
    writeConfig(home, defaultConfig("https://r.example.com", "mbp", "tok", discoverMemorySources(home)));
    const next = {
      fs_write: { mode: "custom" as const, allow: ["~/Desktop"] },
      fs_read: { deny: ["~/Documents/finance"] },
      shell: { mode: "deny_patterns" as const, deny: ["rm", "curl"] },
    };
    writeRestrictionsToHome(home, next);
    const loaded = restrictionsFromConfig(readConfigFile(home));
    expect(loaded).toEqual(next);
  });

  it("applies model, persona, harness and redact literals", () => {
    const home = makeHome();
    writeConfig(home, defaultConfig("https://r.example.com", "mbp", "tok", { agents_md_roots: [], extra_files: [] }));
    let config = readConfigFile(home)!;
    config = applyResponderField(config, "model", "composer-2.5");
    config = applyResponderField(config, "persona", "brief, Russian");
    config = applyHarness(config, "claude");
    config = applyRedactLiterals(config, ["Acme", "Yellowstone"]);
    config = applyRestrictions(config, {
      fs_write: { mode: "workspace_only", allow: [] },
      fs_read: { deny: [] },
      shell: { mode: "open", deny: [] },
    });
    writeConfig(home, config);
    const reloaded = readConfigFile(home)!;
    expect(reloaded.responder?.model).toBe("composer-2.5");
    expect(reloaded.responder?.persona).toBe("brief, Russian");
    expect(reloaded.responder?.harness).toBe("claude");
    expect(reloaded.responder?.binary).toBe("claude");
    expect(reloaded.redact?.literals).toEqual(["Acme", "Yellowstone"]);
    expect(reloaded.restrictions?.shell?.mode).toBe("open");
    const raw = JSON.parse(readFileSync(path.join(home, ".doucopy/config.json"), "utf8")) as {
      responder: { cursor_agent_binary?: string };
    };
    expect(raw.responder.cursor_agent_binary).toBeUndefined();
  });

  it("clears persona when set to empty", () => {
    const config = applyResponderField(
      { responder: { persona: "x", model: "m" } },
      "persona",
      "  ",
    );
    expect(config.responder?.persona).toBeUndefined();
    expect(config.responder?.model).toBe("m");
  });

  it("exposes per-harness model presets", () => {
    expect(modelPresetsFor("cursor-agent")).toContain("composer-2.5");
    expect(modelPresetsFor("claude")).toEqual(expect.arrayContaining(["sonnet", "opus", "haiku"]));
    expect(modelPresetsFor("codex")).toEqual(expect.arrayContaining(["gpt-5.6-sol", "gpt-5.6-terra"]));
    expect(modelPresetsFor("claude")).not.toContain("composer-2.5");
    expect(modelPresetsFor("cursor-agent")).not.toContain("sonnet");
  });

  it("detects when a model is invalid for a harness after a switch", () => {
    expect(isModelValidForHarness("composer-2.5", "cursor-agent")).toBe(true);
    expect(isModelValidForHarness("composer-2.5", "claude")).toBe(false);
    expect(isModelValidForHarness("sonnet", "claude")).toBe(true);
    expect(isModelValidForHarness(undefined, "codex")).toBe(true);
    expect(isModelValidForHarness("", "codex")).toBe(true);
  });
});
