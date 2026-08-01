import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { theme } from "../theme.js";

export function Panel({
  title,
  children,
  flexGrow,
  dim,
  width,
}: {
  title?: string;
  children: ReactNode;
  flexGrow?: number;
  dim?: boolean;
  width?: number | string;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={dim ? theme.dim : theme.accent}
      paddingX={1}
      paddingY={0}
      flexGrow={flexGrow}
      width={width}
    >
      {title ? (
        <Text color={theme.accent} bold>
          {title}
        </Text>
      ) : null}
      {children}
    </Box>
  );
}
