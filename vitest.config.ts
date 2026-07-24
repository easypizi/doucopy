import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["relay/test/**/*.test.ts", "daemon/test/**/*.test.ts"],
  },
});
