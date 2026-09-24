import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Mobile performance (perf/slo.yaml): initial JS ≤170KB gzip, route
    // chunks ≤90KB gzip. Vendor splitting keeps the landing paint light on
    // Nigerian 3G/4G; console code loads per-route via React.lazy in App.tsx.
    target: "es2020",
    cssCodeSplit: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "wouter"],
          "vendor-query": ["@tanstack/react-query"],
        },
      },
    },
  },
  server: {
    host: true,
    allowedHosts: process.env.UMOJA_DEV_ALLOWED_HOSTS?.split(",").map(value => value.trim()).filter(Boolean) ?? ["localhost", "127.0.0.1"],
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
