import { describe, expect, it } from "vitest";
import { buildFirstTask, buildFollowupTask } from "../src/prompt.js";

const MEMORY = {
  transcript_files: ["/home/u/.cursor/projects/p1/agent-transcripts/a.jsonl"],
  agents_md_files: ["/home/u/dev/proj/AGENTS.md"],
  extra_files: [],
};

describe("buildFirstTask", () => {
  it("includes policy, question and memory sources", () => {
    const task = buildFirstTask("Do not share secrets.", "What did I ship?", MEMORY);
    expect(task).toContain("Do not share secrets.");
    expect(task).toContain("What did I ship?");
    expect(task).toContain("a.jsonl");
    expect(task).toContain("AGENTS.md");
    expect(task).toContain("Do not invent facts");
  });
});

describe("buildFollowupTask", () => {
  it("includes policy and question but no memory map", () => {
    const task = buildFollowupTask("Do not share secrets.", "Which of those shipped?");
    expect(task).toContain("Do not share secrets.");
    expect(task).toContain("Which of those shipped?");
    expect(task).not.toContain("jsonl");
  });
});
