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

  /**
   * The dev server proxies `/api` to the platform.
   *
   * The console asks for a same-origin `/api` (see api/client.ts), which is
   * correct in a deployment where something in front serves both. In
   * development there is nothing in front, so without this the console loads,
   * renders its shell, and every screen reports the platform unreachable —
   * which looks like a broken platform rather than a missing proxy.
   *
   * `PV_HTTP_PORT` is the same variable `pnpm api` reads, so moving the API
   * moves the proxy with it rather than leaving the two to disagree.
   */
  server: {
    proxy: {
      // No path rewrite: the platform serves these routes at `/api` itself
      // (api/server.ts registers `/api/runs`, `/api/approvals`, and the rest),
      // so stripping the prefix here would 404 every one of them.
      "/api": {
        target: `http://127.0.0.1:${process.env.PV_HTTP_PORT ?? 8080}`,
        changeOrigin: false,
      },
    },
  },

  build: {
    target: "es2022",
    sourcemap: true,
  },
});
