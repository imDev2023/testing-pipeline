// Devnet help's four parts, in one content file, because which faucets work changes
// (docs/spec/pipescope-screens.md, "Fees and Devnet help").
//
// Checked on 2026-11-22 (#113): faucet.solana.com and faucet.circle.com answered 200, and Circle's
// faucet offers Solana Devnet; the public RPC faucet answered `requestAirdrop` with 410, "The RPC
// faucet is closed on this cluster"; the devnet USDC mint below is a live SPL Token mint with 6
// decimals. The wallets' steps follow each wallet's own help pages on that day (Phantom: Testnet
// Mode under Developer Settings; Solflare: Network under Settings; Backpack: Developer Mode under
// Preferences); they were not tried in the apps. Check them again whenever this page changes.

export const CHECKED_ON = "2026-11-22";

export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export type HelpLink = { label: string; href: string };

export const WALLETS: { name: string; steps: string[] }[] = [
  { name: "Phantom", steps: ["Open Settings, then Developer Settings.", "Turn on Testnet Mode.", "Choose Solana Devnet."] },
  { name: "Solflare", steps: ["Open Settings.", "Choose Network.", "Choose Devnet."] },
  { name: "Backpack", steps: ["Open Settings, then Preferences.", "Turn on Developer Mode.", "In the network selector, choose Solana Devnet."] },
];

export const SOL_FAUCET: HelpLink = { label: "Solana's faucet", href: "https://faucet.solana.com" };

export const USDC_FAUCET: HelpLink = { label: "Circle's faucet", href: "https://faucet.circle.com" };

export const DIFFERENCES: string[] = [
  "There are no dollar prices: every amount and price is in the market's own tokens, and devnet tokens have no value.",
  "A strategy's author can upgrade its program at any time, and an upgrade can leave the older markets of that strategy unreadable, so they can no longer be traded through Pipeline.",
  "Nothing here says anything about a later mainnet version of the same program: what was read and measured on devnet holds only for the code deployed on devnet.",
];
