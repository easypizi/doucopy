import { describe, expect, it } from "vitest";
import {
  AttachmentValidationError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  normalizeAttachments,
} from "../src/attachments.js";

describe("normalizeAttachments", () => {
  it("returns undefined for missing or empty", () => {
    expect(normalizeAttachments(undefined)).toBeUndefined();
    expect(normalizeAttachments([])).toBeUndefined();
  });

  it("accepts a valid attachment", () => {
    expect(normalizeAttachments([{ name: "a.md", content: "hi" }])).toEqual([
      { name: "a.md", content: "hi" },
    ]);
  });

  it("rejects path separators, empty content, null bytes, and oversize", () => {
    expect(() => normalizeAttachments([{ name: "a/b.md", content: "x" }])).toThrow(
      AttachmentValidationError,
    );
    expect(() => normalizeAttachments([{ name: "ok", content: "" }])).toThrow(/empty/);
    expect(() => normalizeAttachments([{ name: "ok", content: "a\0b" }])).toThrow(/null/);
    expect(() =>
      normalizeAttachments([{ name: "big", content: "x".repeat(MAX_ATTACHMENT_BYTES + 1) }]),
    ).toThrow(/exceeds/);
  });

  it("rejects too many files and duplicate names", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
      name: `f${i}.txt`,
      content: "x",
    }));
    expect(() => normalizeAttachments(many)).toThrow(/at most/);
    expect(() =>
      normalizeAttachments([
        { name: "Same.MD", content: "a" },
        { name: "same.md", content: "b" },
      ]),
    ).toThrow(/duplicate/);
  });
});
