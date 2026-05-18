import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Sync the app's displayed version to the module's VERSION file, so the
// number in the toolbar always matches the module the webapp ships with.
const appVersion = readFileSync(resolve(__dirname, "../VERSION"), "utf8").trim();

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  // Relative asset paths so the bundle works at any URL prefix Viam
  // serves it from (single_machine apps live under a machine-keyed path).
  base: "./",
  // Build directly into the apps/ directory so the module tarball picks
  // it up. Empty before each build so stale hashed asset files don't
  // accumulate.
  build: {
    outDir: "../apps/variable-tools-scope",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
