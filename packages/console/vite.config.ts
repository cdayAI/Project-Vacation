import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Build configuration.
 *
 * There is no CSS pipeline beyond what Vite does natively: no preprocessor, no
 * utility framework, no CSS-in-JS. The whole visual system is two plain files
 * in src/theme, and keeping it that way is the point (ADR 0014).
 */
export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
