import { Box, Text } from "ink";
import { SCREEN_LABELS, SCREENS, type ScreenId } from "../types.js";
import { theme } from "../theme.js";

export function TabBar({ active }: { active: ScreenId }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {SCREENS.map((id) => {
          const selected = id === active;
          return (
            <Box key={id} marginRight={1}>
              <Text
                backgroundColor={selected ? theme.tabActiveBg : undefined}
                color={selected ? theme.tabActiveFg : theme.dim}
                bold={selected}
              >
                {" "}
                {SCREEN_LABELS[id]}{" "}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Text color={theme.dim}>{"─".repeat(Math.min(72, SCREENS.length * 12))}</Text>
    </Box>
  );
}
