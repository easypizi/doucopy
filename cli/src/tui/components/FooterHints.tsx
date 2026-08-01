import { Box, Text } from "ink";
import { theme } from "../theme.js";

export function FooterHints({ hints }: { hints: string }) {
  return (
    <Box
      borderStyle="single"
      borderColor={theme.borderDim}
      paddingX={1}
      marginTop={1}
      width="100%"
    >
      <Text color={theme.dim}>{hints}</Text>
    </Box>
  );
}
