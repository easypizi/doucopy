/**
 * ASCII output mode (`DOUCOPY_ASCII=1`) for terminals without font fallback.
 *
 * The legacy Windows console host draws Consolas without fallback, so check
 * marks, half circles and rounded box corners come out as blanks or boxes.
 * Folding happens on the way to the stream, after Ink has already measured
 * layout, so every replacement must stay exactly one character wide.
 */

const ASCII_FOLD: Record<string, string> = {
  // Status chips and markers
  "●": "*",
  "○": "o",
  "◌": "!",
  "◐": "/",
  "◑": "\\",
  "◆": "*",
  "★": "*",
  "✓": "+",
  "×": "x",
  // Punctuation and separators
  "·": "-",
  "…": ".",
  "—": "-",
  "–": "-",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "«": '"',
  "»": '"',
  // Arrows
  "←": "<",
  "→": ">",
  "↑": "^",
  "↓": "v",
  // Box drawing: single, bold, double and rounded corners
  "─": "-",
  "━": "-",
  "═": "-",
  "│": "|",
  "┃": "|",
  "║": "|",
  "┌": "+",
  "┐": "+",
  "└": "+",
  "┘": "+",
  "┏": "+",
  "┓": "+",
  "┗": "+",
  "┛": "+",
  "╔": "+",
  "╗": "+",
  "╚": "+",
  "╝": "+",
  "├": "+",
  "┤": "+",
  "┬": "+",
  "┴": "+",
  "┼": "+",
  "╭": "+",
  "╮": "+",
  "╯": "+",
  "╰": "+",
};

const FOLD_RE = new RegExp(`[${Object.keys(ASCII_FOLD).join("")}]`, "g");

/** Replace decorative glyphs with single-width ASCII. Leaves text (incl. Cyrillic) alone. */
export function asciiFold(text: string): string {
  return text.replace(FOLD_RE, (ch) => ASCII_FOLD[ch] ?? ch);
}

export function asciiModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DOUCOPY_ASCII?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Method syntax on purpose: bivariant params accept both process.stdout and test doubles. */
interface FoldableStream {
  write(chunk: unknown, ...rest: unknown[]): boolean;
}

/** Wrap `stream.write` with the fold. Returns an undo function. Buffers pass through untouched. */
export function installAsciiFold(stream: FoldableStream): () => void {
  const original = stream.write.bind(stream);
  stream.write = (chunk: unknown, ...rest: unknown[]) =>
    original(typeof chunk === "string" ? asciiFold(chunk) : chunk, ...rest);
  return () => {
    stream.write = original;
  };
}

/** Install the fold on stdout and stderr when the env asks for it. */
export function applyAsciiOutputMode(
  env: NodeJS.ProcessEnv = process.env,
  streams: FoldableStream[] = [process.stdout, process.stderr],
): boolean {
  if (!asciiModeEnabled(env)) return false;
  for (const stream of streams) installAsciiFold(stream);
  return true;
}
