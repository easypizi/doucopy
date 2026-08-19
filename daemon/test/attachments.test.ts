import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeInboxAttachments } from "../src/attachments.js";

describe("writeInboxAttachments", () => {
  it("writes files under inbox/ and returns relative paths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-attach-"));
    const paths = writeInboxAttachments(dir, [
      { name: "notes.md", content: "hello peer" },
      { name: "a.ts", content: "export const n = 1;\n" },
    ]);
    expect(paths).toEqual(["inbox/notes.md", "inbox/a.ts"]);
    expect(readFileSync(path.join(dir, "inbox", "notes.md"), "utf8")).toBe("hello peer");
    expect(readFileSync(path.join(dir, "inbox", "a.ts"), "utf8")).toBe("export const n = 1;\n");
  });

  it("returns empty for missing attachments", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-attach-"));
    expect(writeInboxAttachments(dir, undefined)).toEqual([]);
    expect(writeInboxAttachments(dir, [])).toEqual([]);
  });

  it("rejects path traversal names", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doucopy-attach-"));
    expect(() =>
      writeInboxAttachments(dir, [{ name: "../escape.txt", content: "x" }]),
    ).toThrow(/unsafe attachment name/);
  });
});
