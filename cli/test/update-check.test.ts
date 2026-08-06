import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkForUpdate, isNewerVersion, readUpdateCache } from "../src/update-check.js";

describe("isNewerVersion", () => {
  it("compares semver-ish strings", () => {
    expect(isNewerVersion("2.4.7", "2.4.6")).toBe(true);
    expect(isNewerVersion("2.4.6", "2.4.6")).toBe(false);
    expect(isNewerVersion("2.4.5", "2.4.6")).toBe(false);
    expect(isNewerVersion("3.0.0", "2.9.9")).toBe(true);
  });
});

describe("checkForUpdate", () => {
  it("fetches and caches latest", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-upd-"));
    const r1 = checkForUpdate(home, "2.4.0", {
      force: true,
      npmView: () => ({ ok: true, stdout: "2.4.6\n", stderr: "" }),
      now: 1000,
    });
    expect(r1.updateAvailable).toBe(true);
    expect(r1.latest).toBe("2.4.6");
    expect(r1.fromCache).toBe(false);

    const r2 = checkForUpdate(home, "2.4.0", {
      force: false,
      ttlMs: 60_000,
      npmView: () => ({ ok: true, stdout: "9.9.9\n", stderr: "" }),
      now: 2000,
    });
    expect(r2.fromCache).toBe(true);
    expect(r2.latest).toBe("2.4.6");
    expect(readUpdateCache(home)?.latest).toBe("2.4.6");
  });

  it("reports up to date", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-upd2-"));
    const r = checkForUpdate(home, "2.4.6", {
      force: true,
      npmView: () => ({ ok: true, stdout: "2.4.6", stderr: "" }),
    });
    expect(r.updateAvailable).toBe(false);
  });
});
