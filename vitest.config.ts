import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // RBAC assertions hit the same Express app/DB sequentially — running
    // route checks in parallel workers isn't necessary for a permission
    // sweep and just adds flakiness risk against a single Postgres instance.
    fileParallelism: false,
  },
});
