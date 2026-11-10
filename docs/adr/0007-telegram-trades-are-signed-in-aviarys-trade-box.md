# A trade that starts in Telegram is signed in Aviary's own trade box

Aviary's Telegram bot never builds, shows or sends a transaction: its Buy and Sell buttons are plain links to Aviary's market page with the swap filled in, and the trader signs there in their own wallet.
A Mini App inside Telegram was ruled out because it needs a second way to connect wallets (WalletConnect or wallet deep links, since Telegram's browser has no wallet), to be built, tested and kept working on every wallet beside the web app's own.
A link that opens the wallet with the transaction ready (a Solana Pay transaction request or a Solana Action) was ruled out because the wallet then shows only its own preview, so Aviary's fee breakdown and the tick box for a failed exit test could not be guaranteed to appear before signing; Phantom's documentation also says it has discontinued Blinks.
A bot that holds keys is out of scope for the whole suite.
Decided by the owner in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32) on 2026-11-10.

## Consequences

- Every before-signing rule lives in one place, the trade box: the integrator fee and its breakdown, the simulation before every signature, and the exit-test notice apply to a trade from Telegram without a second implementation.
- The bot holds no key and no signing code, so the worst a leaked bot token can do is send false messages; the bot's links therefore never leave Aviary's own origin.
- A phone costs the trader more taps: Telegram's in-app browser has no wallet, so the market page offers to reopen itself inside Phantom, Solflare or Backpack.
- The trade link carries only the market's mints and an amount, so Aviary cannot tell which chat a trade came from.
- A Mini App can be added later as another front to the same trade box without changing this decision; a wallet-direct link would reopen it.
