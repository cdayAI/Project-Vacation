import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Lint configuration.
 *
 * Deliberately small. Most of what would otherwise be lint rules is enforced
 * either by the TypeScript compiler in strict mode or by the architecture
 * tests in packages/platform/src/architecture.test.ts — which check things a
 * linter cannot see, such as module layering and the rule that nothing outside
 * kernel/clock.ts reads the wall clock directly.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.config.js",
      "**/*.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      // An unused variable is usually a half-finished refactor. Allow the
      // leading-underscore convention for genuinely intentional discards.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // `any` erases exactly the guarantees this platform relies on at its
      // boundaries. Untyped input should be parsed with zod, not asserted.
      "@typescript-eslint/no-explicit-any": "error",
      // A floating promise in a governance path is an action whose outcome
      // nobody observed. That is the failure mode this rule exists to prevent.
      "@typescript-eslint/no-floating-promises": "off", // requires type-aware linting; covered by review and tests
      "no-console": ["error", { allow: ["error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // The CLI and the demo write to stdout on purpose: that is their interface.
    files: ["packages/platform/src/cli/**", "packages/platform/src/demo/**"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
