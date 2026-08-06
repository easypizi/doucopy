import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import { checkForUpdate, type UpdateCheckResult } from "../../update-check.js";
import { FooterHints } from "../components/FooterHints.js";
import { APP_VERSION, theme } from "../theme.js";

export function UpdatesScreen({
  home,
  inputActive,
  onResult,
}: {
  home: string;
  inputActive: boolean;
  onResult?: (r: UpdateCheckResult) => void;
}) {
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [busy, setBusy] = useState(false);

  const runCheck = useCallback(
    (force: boolean) => {
      setBusy(true);
      try {
        const r = checkForUpdate(home, APP_VERSION, { force });
        setResult(r);
        onResult?.(r);
      } finally {
        setBusy(false);
      }
    },
    [home, onResult],
  );

  useEffect(() => {
    runCheck(false);
  }, [runCheck]);

  useInput(
    (_input, key) => {
      if (key.return && !busy) runCheck(true);
    },
    { isActive: inputActive && !busy },
  );

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color={theme.accent}>
        Updates
      </Text>
      {busy && !result ? <Text color={theme.dim}>Checking npm…</Text> : null}
      {result ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Current: <Text bold>{result.current}</Text>
          </Text>
          <Text>
            Latest:{" "}
            <Text bold color={result.updateAvailable ? theme.warn : theme.ok}>
              {result.latest ?? "(unknown)"}
            </Text>
            {result.fromCache ? <Text color={theme.dim}> (cached)</Text> : null}
          </Text>
          <Text color={theme.dim}>
            Checked: {new Date(result.checkedAt).toLocaleString()}
          </Text>
          {result.error ? <Text color={theme.err}>Check error: {result.error}</Text> : null}
          {result.updateAvailable ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.warn} bold>
                Update available → v{result.latest}
              </Text>
              <Text>Run in a terminal:</Text>
              <Text color={theme.highlight}> npm i -g doucopy@latest</Text>
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text color={theme.ok}>You are on the latest published version.</Text>
            </Box>
          )}
        </Box>
      ) : null}
      <FooterHints hints="Enter re-check now · Tab leave" />
    </Box>
  );
}
