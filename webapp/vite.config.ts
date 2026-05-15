import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
