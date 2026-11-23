// The web app's unit tests: `@/` resolves to src/, as tsconfig's paths say, so a component's tests
// import it as the pages do.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
