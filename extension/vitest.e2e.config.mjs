// End to end: real Chromium with the unpacked extension and the native host (Mac).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { dir: "..", include: ["extension/test/**/*.e2e.test.mjs"], testTimeout: 120_000 },
});
