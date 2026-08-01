import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { theme } from "../theme.js";
import { TextPrompt } from "./TextPrompt.js";

export function ListEditor({
  title,
  presets,
  current,
  onSave,
  onCancel,
}: {
  title: string;
  presets: readonly string[];
  current: string[];
  onSave: (next: string[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(current));
  const extras = useMemo(
    () => current.filter((v) => !(presets as readonly string[]).includes(v)),
    [current, presets],
  );
  const rows = useMemo(() => [...presets, ...extras.filter((e) => !presets.includes(e))], [presets, extras]);
  const [idx, setIdx] = useState(0);
  const [adding, setAdding] = useState(false);

  useInput(
    (input, key) => {
      if (adding) return;
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow) setIdx((i) => (i <= 0 ? rows.length : i - 1));
      if (key.downArrow) setIdx((i) => (i >= rows.length ? 0 : i + 1));
      if (input === " " && idx < rows.length) {
        const item = rows[idx]!;
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(item)) next.delete(item);
          else next.add(item);
          return next;
        });
      }
      if (key.return) {
        if (idx === rows.length) setAdding(true);
        else onSave([...selected]);
      }
      if (input === "a") setAdding(true);
    },
    { isActive: !adding },
  );

  if (adding) {
    return (
      <TextPrompt
        label="Custom value"
        onCancel={() => setAdding(false)}
        onSubmit={(v) => {
          const trimmed = v.trim();
          if (trimmed) {
            setSelected((prev) => new Set([...prev, trimmed]));
          }
          setAdding(false);
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        {title}
      </Text>
      {rows.map((item, i) => (
        <Text key={item} inverse={i === idx} color={i === idx ? theme.highlight : undefined}>
          {i === idx ? "> " : "  "}
          [{selected.has(item) ? "x" : " "}] {item}
        </Text>
      ))}
      <Text inverse={idx === rows.length} color={idx === rows.length ? theme.highlight : theme.dim}>
        {idx === rows.length ? "> " : "  "}+ Add custom…
      </Text>
      <Text color={theme.dim}>Space toggle · Enter save · a custom · Esc cancel</Text>
    </Box>
  );
}
