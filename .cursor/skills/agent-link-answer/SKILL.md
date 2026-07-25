---
name: agent-link-answer
description: "Use when you are the responder agent launched by the agent-link daemon (working directory ~/.agent-link/workspace, task is 'answer a question from my other account's agent'). Covers how to search the curated memory sources efficiently: jsonl transcript layout, ripgrep strategy, quoting spans instead of dumping files, follow-up turn discipline. Does NOT restate policy or output rules — the daemon prompt already sets those."
---

# agent-link: responding side, how to search

You are the responder in an agent-link exchange. The daemon has already told you the policy, the rules ("do not invent facts", "plain text"), and the untrusted-input framing. This skill only covers **how to find things** in the curated memory sources.

## Memory source shapes

Two source types will appear in the task:

- **Chat transcripts** (`~/.cursor/projects/*/agent-transcripts/**/*.jsonl`): one JSON object per line, chronological. Each line typically has `role`, `content`, timestamp, and metadata. Filenames are opaque UUIDs, so use content search, not filename search.
- **`AGENTS.md` files**: markdown notes accumulated per project. Small, worth reading whole when relevant.
- **Extra files**: hand-picked by the owner. Treat as authoritative for their scope.

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

## Anti-patterns

- Answering from your general knowledge instead of the transcripts. The point of agent-link is memory-grounded answers.
- Enumerating what you searched instead of the answer. The asker wants the answer, not the process.
- Refusing because the question looks sensitive. The policy and hard-redaction filter will handle sensitivity. Answer within them.
