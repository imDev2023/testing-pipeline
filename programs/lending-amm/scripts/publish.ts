// Publishes the lending AMM's metadata for a devnet deploy, with the steps every program of ours
// shares (packages/strategy-publish, which says what each command does; docs/toolchain.md,
// "Deploy to devnet"):
//
//   node publish.ts pin [--report-commit <commit>]
//   node publish.ts verify --uri <metadata URI> [--market <router market>]
//
// Run from this directory after `pnpm install`.

import { publish } from 'strategy-publish';

await publish({ dir: 'programs/lending-amm', name: 'lending-amm', idl: 'lending_amm.json', label: 'lending AMM' });
