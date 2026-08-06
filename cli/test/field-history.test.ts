import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pushHistory, readHistory } from "../src/field-history.js";

describe("field-history", () => {
  it("starts empty and pushes newest-first unique values", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-hist-"));
    expect(readHistory(home)).toEqual({ relay_urls: [], peer_names: [], heroku_apps: [] });

    pushHistory(home, { relay_url: "https://a.example.com", peer_name: "alice" });
    pushHistory(home, { relay_url: "https://b.example.com", peer_name: "bob" });
    pushHistory(home, { relay_url: "https://a.example.com", heroku_app: "my-app" });

    const hist = readHistory(home);
    expect(hist.relay_urls).toEqual(["https://a.example.com", "https://b.example.com"]);
    expect(hist.peer_names).toEqual(["bob", "alice"]);
    expect(hist.heroku_apps).toEqual(["my-app"]);

    const raw = JSON.parse(readFileSync(path.join(home, ".doucopy", "field-history.json"), "utf8"));
    expect(raw.invite).toBeUndefined();
    expect(raw.token).toBeUndefined();
  });

  it("caps each list at 10", () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-hist-cap-"));
    for (let i = 0; i < 12; i += 1) {
      pushHistory(home, { peer_name: `peer-${i}` });
    }
    expect(readHistory(home).peer_names).toHaveLength(10);
    expect(readHistory(home).peer_names[0]).toBe("peer-11");
  });
});
