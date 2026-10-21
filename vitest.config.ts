import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000, pool: "forks" },
});
