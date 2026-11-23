// Publishes the buy wall AMM's metadata for a devnet deploy, with the steps every program of ours
// shares (packages/strategy-publish, which says what each command does; docs/toolchain.md,
// "Deploy to devnet"):
//
//   node publish.ts pin [--report-commit <commit>]
//   node publish.ts verify --uri <metadata URI> [--market <router market>]
//
// Run from this directory after `pnpm install`.

import { publish } from 'strategy-publish';

await publish({ dir: 'programs/buy-wall-amm', name: 'buy-wall-amm', idl: 'buy_wall_amm.json', label: 'buy wall AMM' });
