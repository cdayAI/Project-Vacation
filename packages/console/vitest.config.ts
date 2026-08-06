import { defineConfig } from "vitest/config";

/**
 * Test configuration.
 *
 * jsdom rather than a real browser: the accessibility assertions here are the
 * machine-detectable half of WCAG, and axe-core runs happily against jsdom.
 * The half that needs a real browser — focus order that is technically valid
 * but wrong, a live region that announces at the wrong moment — is a manual
 * pass, recorded as such in the handover rather than implied to be covered
 * here. See ADR 0014.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    globals: false,
    setupFiles: ["src/test/setup.ts"],
    restoreMocks: true,
    testTimeout: 20_000,
  },
});
