import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { theme } from "../theme.js";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export function SelectModal<T extends string>({
  title,
  description,
  options,
  initial,
  onSelect,
  onCancel,
}: {
  title: string;
  description?: string;
  options: SelectOption<T>[];
  initial?: T;
  onSelect: (value: T) => void;
  onCancel: () => void;
}) {
  const enabled = options.filter((o) => !o.disabled);
  const start = Math.max(
    0,
    enabled.findIndex((o) => o.value === initial),
  );
  const [idx, setIdx] = useState(start < 0 ? 0 : start);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) setIdx((i) => (i <= 0 ? enabled.length - 1 : i - 1));
    if (key.downArrow) setIdx((i) => (i >= enabled.length - 1 ? 0 : i + 1));
    if (key.return && enabled[idx]) onSelect(enabled[idx].value);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        {title}
      </Text>
      {description ? (
        <Box marginY={1}>
          <Text color={theme.dim}>{description}</Text>
        </Box>
      ) : null}
      {enabled.map((o, i) => (
        <Text key={o.value} color={i === idx ? theme.highlight : undefined} inverse={i === idx}>
          {i === idx ? "> " : "  "}
          {o.label}
        </Text>
      ))}
      <Text color={theme.dim}>↑↓ · Enter · Esc cancel</Text>
    </Box>
  );
}
