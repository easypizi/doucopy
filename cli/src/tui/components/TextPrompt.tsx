import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import { useHoldKeyCapture } from "../key-capture.js";
import { theme } from "../theme.js";

export function TextPrompt({
  label,
  initial = "",
  placeholder,
  validate,
  mask = false,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial?: string;
  placeholder?: string;
  validate?: (value: string) => string | true;
  /** When true, show * instead of characters (secrets). */
  mask?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useHoldKeyCapture(true);

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent}>{label}</Text>
      <Box>
        <Text>{"> "}</Text>
        <TextInput
          value={value}
          placeholder={placeholder}
          mask={mask ? "*" : undefined}
          onChange={(v) => {
            setValue(v);
            setError(null);
          }}
          onSubmit={(v) => {
            const check = validate?.(v) ?? true;
            if (check !== true) {
              setError(check);
              return;
            }
            onSubmit(v);
          }}
        />
      </Box>
      {error ? <Text color={theme.err}>{error}</Text> : <Text color={theme.dim}>Enter submit · Esc cancel</Text>}
    </Box>
  );
}
