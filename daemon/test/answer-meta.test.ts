import { describe, expect, it } from "vitest";
import { parseAnswerMeta } from "../src/answer-meta.js";

describe("parseAnswerMeta", () => {
  it("returns plain text when no trailer", () => {
    expect(parseAnswerMeta("just an answer")).toEqual({ answer: "just an answer" });
  });

  it("strips trailer and parses verdict fields", () => {
    const raw = [
      "Here is the answer.",
      "",
      "---doucopy-meta---",
      "answered: partial",
      "refused: no",
      "---end---",
    ].join("\n");
    expect(parseAnswerMeta(raw)).toEqual({
      answer: "Here is the answer.",
      answered: "partial",
      refused: "no",
    });
  });

  it("parses refused yes", () => {
    const raw = "Blocked.\n---doucopy-meta---\nanswered: no\nrefused: yes\n---end---\n";
    expect(parseAnswerMeta(raw)).toEqual({
      answer: "Blocked.",
      answered: "no",
      refused: "yes",
    });
  });

  it("ignores unknown verdict values", () => {
    const raw = "x\n---doucopy-meta---\nanswered: maybe\nrefused: nah\n---end---";
    expect(parseAnswerMeta(raw)).toEqual({ answer: "x" });
  });
});
