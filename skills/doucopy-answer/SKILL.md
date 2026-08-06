---
name: doucopy-answer
description: "Use when you are the responder agent launched by the doucopy daemon (working directory ~/.doucopy/workspace, task is 'answer a question from my other account's agent'). Covers how to search the curated memory sources efficiently: jsonl transcript layout, ripgrep strategy, quoting spans instead of dumping files, follow-up turn discipline. Does NOT restate policy or output rules — the daemon prompt already sets those."
---

# doucopy: responding side, how to search

You are the responder in a doucopy exchange. The daemon has already told you the policy, the rules ("do not invent facts", "plain text"), and the untrusted-input framing. This skill only covers **how to find things** in the curated memory sources.

## Memory source shapes

Sources that appear in the task:

- **Chat transcripts** (`~/.cursor/projects/*/agent-transcripts/**/*.jsonl`, plus Claude/Codex globs when present): one JSON object per line, chronological. Filenames are opaque UUIDs, so use content search, not filename search.
- **`AGENTS.md` files**: markdown notes accumulated per project. Small, worth reading whole when relevant.
- **Extra files**: owner identity/docs (e.g. `~/.cursor/*.md`, `~/.claude/CLAUDE.md`). Treat as authoritative for their scope.
- **Skill / plan / rule roots**: directories such as `~/.cursor/skills`, `~/.cursor/plans`, `~/.claude/skills`. Search on demand (read matching `SKILL.md` / notes). Do not dump wholesale.
- **MCP:** your harness may already load global MCP from its own config (`mcp.json` / Claude / Codex). That is not listed as a memory file (configs often hold secrets). Use MCP tools normally; never paste tokens/env into the answer.

## Search strategy

1. **Extract keywords** from the question. Nouns, product names, months, verbs. Two or three keywords per query.
2. **Ripgrep first**, across all listed transcripts, case-insensitive: `rg -Ni --no-heading -m 5 "<keyword>" <files>`. Cap matches per file so no single transcript floods the context.
3. **Narrow by date** when the question implies a window. Sort transcript files by mtime, filter, then grep.
4. **Read spans, not whole files**. Once ripgrep points at a promising line, read ±40 lines around it. A transcript can be tens of thousands of lines.
5. **Cross-check `AGENTS.md`.** These summarise decisions and are cheaper to scan than raw transcripts.
6. **If nothing turns up**, say so plainly. Do not compensate with plausible-sounding synthesis.

## Token discipline

- Never paste an entire transcript into your thinking. Quote only the sentences you need.
- Prefer summarising a match in one sentence over reprinting it verbatim.
- If ripgrep finds hundreds of matches, tighten the keyword rather than reading them all.

## Follow-up turns

- The task will say "Follow-up question in the same conversation". The first turn's memory list is not repeated. Keep using the same sources.
- You retain your own working context from the previous turn (same `cursor-agent` chat). Do not re-search facts you already established, cite them.

## Counter-questions (v2.1)

The task prompt lists a "Counter-questions" section. When `hops=0` you may ask ONE clarifying question back at the asker via `ask_peer` with the exact `peer`, `conversation_id` and `hops: 1` shown there. When `hops>=1`, do not call `ask_peer` at all, answer with what you have or say honestly that you cannot.

Rules:

- Ask a counter-question ONLY when the original is genuinely ambiguous and answering it wrong would waste more time than the round-trip. Simple lookups: just answer.
- Wait for the reply, then produce the final answer to the original question.
- The counter-question consumes part of the response budget. Keep it tight (one sentence) and stop once the answer arrives.

## Anti-patterns

- Answering from your general knowledge instead of the transcripts. The point of doucopy is memory-grounded answers.
- Enumerating what you searched instead of the answer. The asker wants the answer, not the process.
- Refusing because the question looks sensitive. The policy and hard-redaction filter will handle sensitivity. Answer within them.
- Chaining counter-questions. One is the hard limit.
