# Containment hook: the owner's sign-offs

Every Low finding of the containment hook's internal adversarial review that stays open, with its reason and the owner's written sign-off.
This is not an audit; see [README.md](README.md).
The owner signed these off on 2026-11-23, in the hardening session of [Containment hook: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/74), by the answers recorded on that ticket (`1a 2a 3a 4a 5a 6a 7a 8a`).
Each is a default MetalLegBob may change.

## Signed off by answer 8a (the session's list)

| Finding | Severity | What stays open | Why it is accepted |
| --- | --- | --- | --- |
| H002 | Low | Balances the owner rule (`HOOK-47`) cannot reach: supply minted into an account made by hand, since minting calls no hook, and balances bought into one before the rule existed can still change owner. | Token-2022 never lets an initialized account gain the immutable owner extension, so no rule can reach them; devnet held none when the rule was written (every unit of the three contained mints sat in an associated token account or a vault), and #67's seed rule ends minting into a seeded market. |
| H012 | Low | Tokens sent into the fee account reach the account of the router's treasury owner by `sweep_fees`, and the router admin chooses that owner. | The router admin is trusted for every market on Pipeline, and the treasury's account can only sell back into the home market. |
| H013 | Low | A market on another strategy can name the home vault or the fee account as its own vault, so a sell into it passes the hook and strands the tokens there. | That market pays out of its own reserve, an untaxed exit it funds at a loss; the router records whatever vaults a strategy declares, which the hook cannot see; the spec's "a sell into a second market is refused" is corrected in "What the hook cannot see". |
| H022 | Low | On markets seeded before #67 (the devnet demo markets), the mint authority can stay set and mint into the market. | #67's seed rule closes it for every new market; demo token 3's mint authority is revoked on devnet by this ticket. |
| H026 | Low | Under #67 the only working launch order is create, `bind`, revoke the mint authority, seed; revoking before `bind` can never be undone. | The launch script does it in that order, and the spec says so. |
| H049 | Low | No floor on the unlock goal or the deadline. | The spec promises a cap on the deadline, not a floor; an on-chain floor is cheap to evade with a small quote unit; Aviary warns on weak terms. |
| H050 | Low | A hooked mint that is never bound can never move and has no deadline; a mint whose mint authority is a multisig cannot bind (`HOOK-44`). | The launch script binds at once; a launcher binds before moving the authority to a multisig. |
| H051 | Low | A hooked or contained quote mint strands only its launcher's own market. | Closed outright by answer 3a: `bind` refuses a quote with a transfer hook. |
| H065 | Low | The sole tax recipient can sandwich captive sells. | Bounded by each seller's minimum output and the 10% tax cap; Aviary's low default slippage is the defence. |
| H066 | Low | A captive seller gets 300 slots' notice of a rate rise. | Rates are capped at 10% and changes wait 300 slots under #67; Aviary's panel shows any pending rate change (`HOOK-49`). |
| H070 | Low | A router upgrade changing the fee account's seeds would stop sells, until the deadline, on markets whose fee is taken in the token. | The router's key is trusted, the deadline caps it, and the daily router pin check sees any upgrade; the spec's "Depends on" is narrowed to those markets. |
| H096 | Low | The Aviary panel's wording must carry the sole-recipient, weak-terms and owner caveats. | The panel's text in the spec now carries them, for [Containment hook in Aviary](https://github.com/imDev2023/testing-pipeline/issues/76) to build. |

## Accepted by the answers to the design questions

| Finding | Severity | Answer | What stays open, disclosed |
| --- | --- | --- | --- |
| H003 | Low | 2a | Programs and smart wallets as holders change hands without a transfer; disclosed in "What the hook cannot see", on Aviary's panel and in `HOOK-48`. |
| H023, H024, H061 | Low | 4a | The launcher as sole recipient reaches the goal for a fraction of it, possibly in one transaction; the numbers are in "Unlock goal" and `HOOK-49`, and Aviary's panel names the recipients. |
| H067 | Low | 5a | Supply held outside the pool can be sold into buyers' real quote; Canary's `outside_supply` warn, Aviary's panel and smaller launch defaults (`HOOK-50`). |
| H062 | Info | 6a | A mint with group extensions still needs Meteora's approval after its unlock; `HOOK-11` reworded and Aviary warns. |
| H016, H017, H018 | Low | 7a | One key upgrades the hook and the tax AMM until mainnet; the freeze rule and its script are built (`HOOK-51`), and the freeze itself waits for mainnet. |
