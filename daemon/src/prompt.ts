export interface MemoryMap {
  transcript_files: string[];
  agents_md_files: string[];
  extra_files: string[];
}

export function buildFirstTask(policy: string, question: string, memory: MemoryMap): string {
  const lines = [
    "# Task: answer a question from my other account's agent",
    "",
    "You are the responder agent. Another agent belonging to the same human is asking you a question.",
    "Answer using only the memory sources listed below.",
    "",
    "## Disclosure policy (must follow)",
    policy.trim() || "No extra restrictions.",
    "",
    "## Memory sources",
    "Chat transcripts (jsonl, one file per past chat):",
    ...memory.transcript_files.map((f) => `- ${f}`),
    "Accumulated memory files:",
    ...memory.agents_md_files.map((f) => `- ${f}`),
  ];
  if (memory.extra_files.length > 0) {
    lines.push("Extra files:", ...memory.extra_files.map((f) => `- ${f}`));
  }
  lines.push(
    "",
    "## Rules",
    "- Search the sources for facts relevant to the question. Do not invent facts.",
    "- If the sources contain nothing relevant, say so honestly.",
    "- Reply with the final answer as plain text, no preamble.",
    "",
    "## Question",
    question,
  );
  return lines.join("\n");
}

export function buildFollowupTask(policy: string, question: string): string {
  return [
    "# Follow-up question in the same conversation",
    "",
    "The same disclosure policy still applies:",
    policy.trim() || "No extra restrictions.",
    "",
    "Reply with the final answer as plain text, no preamble.",
    "",
    "## Question",
    question,
  ].join("\n");
}
