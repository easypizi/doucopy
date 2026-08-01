import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

export function ConfirmModal({
  title,
  body,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (key.escape || input === "n" || input === "N") onCancel();
    if (key.return || input === "y" || input === "Y") onConfirm();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={danger ? theme.err : theme.accent} paddingX={1}>
      <Text color={danger ? theme.err : theme.accent} bold>
        {title}
      </Text>
      {body ? <Text>{body}</Text> : null}
      <Text color={theme.dim}>Enter/Y confirm · Esc/N cancel</Text>
    </Box>
  );
}
