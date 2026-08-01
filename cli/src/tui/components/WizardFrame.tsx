import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { theme } from "../theme.js";
import { FooterHints } from "./FooterHints.js";

export function WizardFrame({
  title,
  step,
  total,
  children,
  hints = "Enter continue · Esc back",
}: {
  title: string;
  step: number;
  total: number;
  children: ReactNode;
  hints?: string;
}) {
  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold>
        {title}{" "}
        <Text color={theme.dim}>
          ({step}/{total})
        </Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
      <FooterHints hints={hints} />
    </Box>
  );
}
