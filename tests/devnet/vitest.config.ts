import { defineConfig } from "vitest/config";

// Each test file runs its own `wrangler dev` and spends devnet SOL, so they run one at a time.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 10 * 60_000, hookTimeout: 5 * 60_000 } });
