import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renamePeer } from "../src/rename-peer.js";

describe("renamePeer", () => {
  it("mints invite with current token then rejoins under new name", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-rename-"));
    const invites: string[] = [];
    const joins: Array<{ invite: string; name: string }> = [];
    const written: unknown[] = [];

    const result = await renamePeer(
      home,
      {
        relay_url: "https://relay.example.com",
        self_peer: "old-name",
        token: "tok-old",
      },
      "new-name",
      {
        requestInvite: async (_url, token) => {
          expect(token).toBe("tok-old");
          invites.push("minted");
          return { invite: "ali1.minted", expires_at: Date.now() + 3600_000 };
        },
        joinRelay: async (_url, invite, name) => {
          joins.push({ invite, name });
          return { peer: name, token: "tok-new" };
        },
        writeConfig: (_home, config) => {
          written.push(config);
          return "config.json";
        },
        detectAskers: () => ({ cursor: false, claude: false, codex: false }),
        pushHistory: () => ({ relay_urls: [], peer_names: ["new-name"], heroku_apps: [] }),
      },
    );

    expect(invites).toEqual(["minted"]);
    expect(joins).toEqual([{ invite: "ali1.minted", name: "new-name" }]);
    expect(result).toMatchObject({ peer: "new-name", token: "tok-new" });
    expect(written[0]).toMatchObject({ self_peer: "new-name", token: "tok-new" });
  });

  it("uses provided invite without minting", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "doucopy-rename-inv-"));
    let minted = false;
    await renamePeer(
      home,
      { relay_url: "https://r.example.com", token: "t", self_peer: "a" },
      "b",
      {
        invite: "ali1.manual",
        requestInvite: async () => {
          minted = true;
          return { invite: "x", expires_at: 1 };
        },
        joinRelay: async (_u, invite, name) => {
          expect(invite).toBe("ali1.manual");
          return { peer: name, token: "tok" };
        },
        writeConfig: () => "c",
        detectAskers: () => ({ cursor: false, claude: false, codex: false }),
        pushHistory: () => ({ relay_urls: [], peer_names: [], heroku_apps: [] }),
      },
    );
    expect(minted).toBe(false);
  });
});
