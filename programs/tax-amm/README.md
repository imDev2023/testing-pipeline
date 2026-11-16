# Aviary Tax AMM

A strategy for [Pipeline](https://github.com/MetalLegBob/pipeline)'s router: constant-product markets that take a buy tax and a sell tax in one chosen mint, the tax side, whichever way a trade goes.
Every tax is capped by a limit compiled into the program and can only move inside a range fixed when the market is created, by an optional tax authority that can also renounce.
Liquidity is seeded once and locked for good.
The tax is booked in the market's vault and paid out with `distribute` to the market's tax recipients and its burn, after the suite share.

The full rules are in [`docs/spec/tax-amm.md`](../../docs/spec/tax-amm.md), and the terms (tax side, tax authority, tax recipient, suite share, virtual reserve) in [`GLOSSARY.md`](../../GLOSSARY.md).

## Open to change

Every rule below is a default chosen for Pipeline's author to review, and each is one he may change.
To change one, name its ID from the [decision register](../../docs/decisions.md) in an issue, in a comment on a pull request, or in a message to the repo's owner.
Each block in the register says what else was weighed, the one place the value lives and what changing it takes.

| Area | Decisions |
| --- | --- |
| Pricing and the tax | [TAX-01](../../docs/decisions.md#tax-01-pricing-and-where-the-tax-is-taken) pricing and where the tax is taken, [TAX-02](../../docs/decisions.md#tax-02-tax-side) tax side, [TAX-15](../../docs/decisions.md#tax-15-exact-out) exact-out refused, [TAX-19](../../docs/decisions.md#tax-19-rounding) rounding |
| Limits compiled into the program | [TAX-03](../../docs/decisions.md#tax-03-highest-tax) highest tax (10%), [TAX-06](../../docs/decisions.md#tax-06-suite-share) suite share (10% of the tax), [TAX-07](../../docs/decisions.md#tax-07-suite-treasury) suite treasury, [TAX-08](../../docs/decisions.md#tax-08-number-of-recipients) up to four recipients, [TAX-16](../../docs/decisions.md#tax-16-mint-rules) mint rules |
| Who may change a market | [TAX-04](../../docs/decisions.md#tax-04-rates-and-their-ranges) rates and their ranges, [TAX-05](../../docs/decisions.md#tax-05-tax-authority) tax authority, [TAX-38](../../docs/decisions.md#tax-38-what-renouncing-leaves-in-the-market-state) renouncing, [TAX-39](../../docs/decisions.md#tax-39-emptying-a-recipient-slot-that-is-still-owed) emptying a slot still owed |
| Where the tax goes | [TAX-09](../../docs/decisions.md#tax-09-recipients-and-the-burn) recipients and the burn, [TAX-10](../../docs/decisions.md#tax-10-payout) payout, [TAX-43](../../docs/decisions.md#tax-43-which-tax-slots-distribute-pays) to [TAX-46](../../docs/decisions.md#tax-46-the-suite-treasury-and-the-slot-numbers-in-the-idl) how `distribute` pays, [TAX-48](../../docs/decisions.md#tax-48-the-burns-own-action) the burn's own action |
| Liquidity | [TAX-11](../../docs/decisions.md#tax-11-locked-liquidity) locked liquidity, [TAX-12](../../docs/decisions.md#tax-12-the-seed) the seed, [TAX-13](../../docs/decisions.md#tax-13-virtual-reserve) virtual reserve, [TAX-14](../../docs/decisions.md#tax-14-two-mints) two mints, [TAX-41](../../docs/decisions.md#tax-41-how-metadata-describes-seeding-from-another-program) and [TAX-42](../../docs/decisions.md#tax-42-how-a-seed-request-is-checked) seeding from another program |
| Accounts and layout | [TAX-17](../../docs/decisions.md#tax-17-market-addresses) market addresses, [TAX-29](../../docs/decisions.md#tax-29-program-id) program id, [TAX-30](../../docs/decisions.md#tax-30-the-market-states-layout) the market state's layout, [TAX-33](../../docs/decisions.md#tax-33-creating-the-vaults) creating the vaults, [TAX-35](../../docs/decisions.md#tax-35-the-vault-authority-in-a-swap) the vault authority in a swap |
| The containment hook | [TAX-18](../../docs/decisions.md#tax-18-counters-for-the-containment-hook) counters for the hook's unlock |
| Metadata, IDL and errors | [TAX-20](../../docs/decisions.md#tax-20-custom-actions-and-metadata) custom actions and metadata, [TAX-34](../../docs/decisions.md#tax-34-idl-and-typescript-client) IDL and client, [TAX-37](../../docs/decisions.md#tax-37-the-tax-cap-and-the-suite-share-in-the-idl) constants in the IDL, [TAX-31](../../docs/decisions.md#tax-31-how-a-refused-market-is-reported), [TAX-36](../../docs/decisions.md#tax-36-how-a-refused-seed-or-trade-is-reported) and [TAX-40](../../docs/decisions.md#tax-40-how-a-refused-tax-authority-action-is-reported) how refusals are reported |
| Safety and testing | [TAX-21](../../docs/decisions.md#tax-21-mainnet-upgrade-policy) mainnet upgrade policy, [TAX-22](../../docs/decisions.md#tax-22-security-contact) security contact, [TAX-23](../../docs/decisions.md#tax-23-compute-ceilings) compute ceilings, [TAX-24](../../docs/decisions.md#tax-24-invariants) invariants, [TAX-28](../../docs/decisions.md#tax-28-expected-canary-warns) expected Canary warns, [TAX-49](../../docs/decisions.md#tax-49-the-maths-re-checks-the-creation-rules) to [TAX-52](../../docs/decisions.md#tax-52-what-every-holder-can-exit-means-on-a-tax-market) proofs and fuzzing |
| Shared bar for every program | [BAR-20](../../docs/decisions.md#bar-20-verified-builds-of-our-programs) verified builds, [BAR-21](../../docs/decisions.md#bar-21-published-source-and-licence) published source, [BAR-22](../../docs/decisions.md#bar-22-strategy-metadata) metadata, [BAR-23](../../docs/decisions.md#bar-23-upgrade-authority-on-devnet) upgrade authority, [BAR-26](../../docs/decisions.md#bar-26-external-audits) no external audit, [SUITE-20](../../docs/decisions.md#suite-20-names-of-the-on-chain-products) the name |

## On devnet

Not deployed yet.
The program id is `J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t` ([TAX-29](../../docs/decisions.md#tax-29-program-id)); the first deploy, its registration with the router and the demo market are recorded in [`deployments/devnet.json`](../../deployments/devnet.json) once they happen.
It stays upgradeable on devnet under one project upgrade authority, and Aviary shows it as upgradeable by a single key, like anyone else's strategy.

## Using it

- **Metadata**: [`metadata.json`](metadata.json), Pipeline's `pipeline-strategy-metadata/1`, describes market creation (`init`), seeding from another program (`seed_liquidity`) and every custom action, so a terminal can build each transaction with Pipeline's SDK.
- **IDL and client**: the Anchor IDL is [`idl/tax_amm.json`](idl/tax_amm.json), and [`scripts/client/`](scripts/client/) is a TypeScript client generated from it with Codama.
- **Demo**: [`scripts/demo.ts`](scripts/demo.ts) creates, seeds, trades and pays out markets built from the metadata, on a local validator or on devnet; [`docs/toolchain.md`](../../docs/toolchain.md) says how to build, test and run it.
- **Security**: report a vulnerability through this repo's [private vulnerability reporting](https://github.com/imDev2023/testing-pipeline/security/advisories/new).
  The program has had internal reviews only, and no external audit.

Licensed Apache-2.0, as is the whole on-chain workspace ([`programs/LICENSE`](../LICENSE)).
