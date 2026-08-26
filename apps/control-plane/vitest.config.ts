import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
const templateRoot = path.resolve(import.meta.dirname);
export default defineConfig({
  root: templateRoot,
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["server/testEnvironment.ts"],
    fileParallelism: false,
    include: ["server/**/*.test.ts", "server/**/*.test.tsx", "server/**/*.spec.ts", "client/src/**/*.test.ts", "client/src/**/*.spec.ts", "client/src/**/*.test.tsx"],
    // Server-side tests that render console components need a DOM; they still
    // reach the real router and real PostgreSQL.
    environmentMatchGlobs: [
      ["client/src/**/*.test.tsx", "jsdom"],
      ["server/**/*.test.tsx", "jsdom"],
    ],
  },
});
