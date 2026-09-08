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
    // @grpc/grpc-js is CJS and does internal relative requires (e.g.
    // require('./call-credentials')) that resolve against its real
    // node_modules location - Vite's SSR handling breaks that (confirmed
    // live: "Cannot find module './call-credentials'" resolving against
    // the test file's directory instead of node_modules). This deprecated
    // field is the only one of the three documented options that actually
    // fixes it on Vitest 2.1.9 - both suggested replacements
    // (server.deps.external and deps.optimizer.ssr.exclude) were tried and
    // confirmed live to still fail the same way.
    deps: {
      external: [/@grpc\/grpc-js/],
    },
    include: ["server/**/*.test.ts", "server/**/*.test.tsx", "server/**/*.spec.ts", "client/src/**/*.test.ts", "client/src/**/*.spec.ts", "client/src/**/*.test.tsx"],
    // Server-side tests that render console components need a DOM; they still
    // reach the real router and real PostgreSQL.
    environmentMatchGlobs: [
      ["client/src/**/*.test.tsx", "jsdom"],
      ["server/**/*.test.tsx", "jsdom"],
    ],
  },
});
