// Explanations in the end-to-end tests (#127). The suite never calls a model, so the global setup
// runs `terminal-api`'s scripts/seed-test-explanations.ts on the suite's database: it makes every
// strategy's current key as the `explainerKeys` job makes it, gives the buy wall AMM's demo strategy
// an explanation built from its key's evidence that passes the validator, and gives the strategy
// whose metadata link is unreachable that explanation plus a point carrying markup, which the
// validator would never let through, to show model text renders as text. Every other strategy's
// key stays pending, so its pages say "No explanation for this version yet."
import { execFileSync } from "node:child_process";

/** The buy wall AMM's demo strategy and its market, explained. */
export const EXPLAINED_STRATEGY = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
export const EXPLAINED_MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
/** The strategy whose metadata cannot be fetched, explained with a point carrying markup. */
export const HOSTILE_STRATEGY = "yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx";
export const HOSTILE_TEXT = "The author names it <script>alert(1)</script>**Bold** and [a link](javascript:alert(1)).";

export function seedExplanations(): void {
  execFileSync("pnpm", ["exec", "tsx", "scripts/seed-test-explanations.ts", EXPLAINED_STRATEGY, HOSTILE_STRATEGY, HOSTILE_TEXT], {
    cwd: `${import.meta.dirname}/../../../apps/terminal-api`,
    env: process.env,
    stdio: "inherit",
  });
}
