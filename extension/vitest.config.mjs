// Unit tests for extension/ and host/ (host tests use vitest globals: they sit outside this package).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    dir: "..",
    include: ["extension/test/**/*.test.mjs", "host/test/**/*.test.mjs"],
    exclude: ["**/node_modules/**", "**/*.e2e.test.mjs"],
    globals: true,
    testTimeout: 20_000,
  },
});
