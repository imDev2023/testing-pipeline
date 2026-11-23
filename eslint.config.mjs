// ESLint for Aviary's TypeScript (the `terminal` CI job, `pnpm terminal:lint`). It covers only the
// terminal's packages; the on-chain workspace's scripts and the keeper are checked by their own jobs.
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const TERMINAL = ["apps/terminal-api/**/*.ts", "apps/terminal-web/**/*.{ts,tsx}", "packages/terminal-db/**/*.ts", "packages/terminal-explainer/**/*.ts", "packages/terminal-indexer/**/*.ts", "tests/terminal-e2e/**/*.ts", "tests/devnet/**/*.ts"];

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/.open-next/**", "**/.wrangler/**", "**/test-results/**", "**/next-env.d.ts"] },
  {
    files: TERMINAL,
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["apps/terminal-web/**/*.tsx", "apps/terminal-web/**/*.ts"],
    plugins: { "@next/next": nextPlugin, "react-hooks": reactHooks },
    settings: { next: { rootDir: "apps/terminal-web" } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...reactHooks.configs.recommended.rules,
    },
  },
);
