import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    include: [
      "relay/test/**/*.test.ts",
      "daemon/test/**/*.test.ts",
      "cli/test/**/*.test.ts",
      "cli/test/**/*.test.tsx",
    ],
  },
});
