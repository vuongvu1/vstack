import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 60_000,
    include: ["src/**/*.test.ts", "server/**/*.test.ts"],
  },
});
