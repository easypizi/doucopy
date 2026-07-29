import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrateLegacyHome } from "../src/migrate.js";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "doucopy-migrate-"));
}

describe("migrateLegacyHome", () => {
  it("renames ~/.agent-link to ~/.doucopy, preserving contents", () => {
    const home = makeHome();
    const legacy = path.join(home, ".agent-link");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "config.json"), '{"self_peer":"work"}');

    expect(migrateLegacyHome(home)).toBe(true);

    expect(existsSync(legacy)).toBe(false);
    const migrated = path.join(home, ".doucopy", "config.json");
    expect(existsSync(migrated)).toBe(true);
    expect(readFileSync(migrated, "utf8")).toContain("work");
  });

  it("rewrites a stale ~/.agent-link path inside the migrated config.json", () => {
    const home = makeHome();
    const legacy = path.join(home, ".agent-link");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      path.join(legacy, "config.json"),
      JSON.stringify({ responder: { workspace_dir: "~/.agent-link/workspace" } }),
    );

    expect(migrateLegacyHome(home)).toBe(true);

    const config = JSON.parse(readFileSync(path.join(home, ".doucopy/config.json"), "utf8")) as {
      responder: { workspace_dir: string };
    };
    expect(config.responder.workspace_dir).toBe("~/.doucopy/workspace");
  });

  it("is a no-op when there is no legacy directory", () => {
    const home = makeHome();
    expect(migrateLegacyHome(home)).toBe(false);
    expect(existsSync(path.join(home, ".doucopy"))).toBe(false);
  });

  it("does not touch an existing ~/.doucopy even if legacy is also present", () => {
    const home = makeHome();
    const legacy = path.join(home, ".agent-link");
    const current = path.join(home, ".doucopy");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "config.json"), "legacy");
    mkdirSync(current, { recursive: true });
    writeFileSync(path.join(current, "config.json"), "current");

    expect(migrateLegacyHome(home)).toBe(false);

    expect(existsSync(legacy)).toBe(true);
    expect(readFileSync(path.join(current, "config.json"), "utf8")).toBe("current");
  });
});
