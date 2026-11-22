# Containment hook

The containment hook, published under the name in the program's embedded `security.txt`, the only place it lives since the hook is not a strategy and has no metadata ([SUITE-20](../../docs/decisions.md#suite-20-names-of-the-on-chain-products)), is a Token-2022 transfer hook for tokens launched on [Pipeline](https://github.com/MetalLegBob/pipeline)'s router.
While a token is contained, every transfer of it must go into or come out of its one home market, a tax AMM market: it can be bought and sold there and nowhere else, and it cannot be sent from one wallet to another.
Once the home market has collected the unlock goal in tax, or the unlock deadline passes, anyone can unlock it: the hook removes itself and the token becomes an ordinary Token-2022 token.
One program serves every contained token.

The full rules are in [`docs/spec/containment-hook.md`](../../docs/spec/containment-hook.md), and the terms (contained token, home market, unlock goal, unlock deadline) in [`GLOSSARY.md`](../../GLOSSARY.md).

## Open to change

Every rule below is a default chosen for Pipeline's author to review, and each is one he may change.
To change one, name its ID from the [decision register](../../docs/decisions.md) in an issue, in a comment on a pull request, or in a message to the repo's owner.
Each block in the register says what else was weighed, the one place the value lives and what changing it takes.

| Area | Decisions |
| --- | --- |
| What containment allows | [HOOK-01](../../docs/decisions.md#hook-01-transfers-while-contained) transfers while contained, [HOOK-02](../../docs/decisions.md#hook-02-integrator-fees-on-sells) integrator fees on sells, [HOOK-13](../../docs/decisions.md#hook-13-how-the-hook-decides) how the hook decides |
| The home market | [HOOK-03](../../docs/decisions.md#hook-03-one-home-market) one home market, [HOOK-04](../../docs/decisions.md#hook-04-which-markets-can-be-a-home-market) which markets can be one, [HOOK-27](../../docs/decisions.md#hook-27-where-the-tax-amms-address-comes-from) where the tax AMM's address comes from |
| Binding a token | [HOOK-12](../../docs/decisions.md#hook-12-mint-rules-at-binding) mint rules at binding, [HOOK-24](../../docs/decisions.md#hook-24-who-pays-for-a-binding) who pays, [HOOK-25](../../docs/decisions.md#hook-25-binding-in-its-own-transaction) binding in its own transaction |
| The unlock | [HOOK-05](../../docs/decisions.md#hook-05-unlock-goal) unlock goal, [HOOK-06](../../docs/decisions.md#hook-06-where-the-goal-is-counted) where it is counted, [HOOK-07](../../docs/decisions.md#hook-07-who-sets-the-goal-and-the-deadline) who sets the goal and the deadline, [HOOK-08](../../docs/decisions.md#hook-08-a-deadline-is-required) a deadline is required, [HOOK-09](../../docs/decisions.md#hook-09-longest-deadline) the longest deadline (90 days), [HOOK-23](../../docs/decisions.md#hook-23-the-edges-of-the-unlock-terms) the edges of the terms |
| Who unlocks, and how | [HOOK-10](../../docs/decisions.md#hook-10-who-triggers-the-unlock) who triggers it, [HOOK-11](../../docs/decisions.md#hook-11-what-the-unlock-does) what it does, [HOOK-30](../../docs/decisions.md#hook-30-who-signs-unlock) who signs, [HOOK-31](../../docs/decisions.md#hook-31-a-second-unlock) a second unlock, [HOOK-32](../../docs/decisions.md#hook-32-how-the-unlock-says-what-made-it-due) how it says what made it due, [HOOK-34](../../docs/decisions.md#hook-34-the-deadline-without-the-market-state) the deadline without the market state |
| Where its values live | [HOOK-21](../../docs/decisions.md#hook-21-where-its-policy-values-live) one config module, [`src/config.rs`](src/config.rs) |
| Launching a contained token | [HOOK-14](../../docs/decisions.md#hook-14-launching-a-contained-token) launching, [HOOK-26](../../docs/decisions.md#hook-26-the-launch-scripts-own-choices) the script's own choices, [HOOK-29](../../docs/decisions.md#hook-29-the-launch-scripts-seed-and-trades) its seed and trades, [HOOK-33](../../docs/decisions.md#hook-33-the-launch-scripts-unlock) its unlock, [HOOK-35](../../docs/decisions.md#hook-35-the-launch-scripts-rehearsal-of-the-devnet-launch) several tokens in one run, [HOOK-38](../../docs/decisions.md#hook-38-how-the-launch-script-checks-a-home-markets-conformance) its conformance checks, [HOOK-39](../../docs/decisions.md#hook-39-which-refusals-the-launch-script-lands-on-chain) the refusals it lands on chain |
| Safety and testing | [HOOK-15](../../docs/decisions.md#hook-15-mainnet-upgrade-policy) frozen before mainnet, [HOOK-16](../../docs/decisions.md#hook-16-compute-ceilings) compute ceilings, [HOOK-37](../../docs/decisions.md#hook-37-what-binds-ceiling-counts) what `bind`'s ceiling counts, [HOOK-18](../../docs/decisions.md#hook-18-invariants) invariants, [HOOK-36](../../docs/decisions.md#hook-36-how-the-fuzzer-judges-the-hooks-invariants) how the fuzzer judges them, [HOOK-19](../../docs/decisions.md#hook-19-framework) framework, [HOOK-28](../../docs/decisions.md#hook-28-execute-stays-in-anchor) `Execute` stays in Anchor, [HOOK-22](../../docs/decisions.md#hook-22-expected-canary-warns) expected Canary warns |
| In Aviary | [HOOK-17](../../docs/decisions.md#hook-17-in-aviary) the containment panel and the Unlock button |
| Shared bar for every program | [BAR-11](../../docs/decisions.md#bar-11-conformance) conformance, [BAR-20](../../docs/decisions.md#bar-20-verified-builds-of-our-programs) verified builds, [BAR-21](../../docs/decisions.md#bar-21-published-source-and-licence) published source, [BAR-23](../../docs/decisions.md#bar-23-upgrade-authority-on-devnet) upgrade authority, [BAR-26](../../docs/decisions.md#bar-26-external-audits) no external audit |
| Going to devnet | [BAR-42](../../docs/decisions.md#bar-42-how-a-program-is-deployed-to-devnet) how a program is deployed to devnet, [BAR-14](../../docs/decisions.md#bar-14-devnet-demo) the devnet demo, [HOOK-20](../../docs/decisions.md#hook-20-a-second-devnet-token) a second devnet token, [HOOK-40](../../docs/decisions.md#hook-40-the-devnet-demos-contained-tokens-and-their-record) the devnet demo's tokens and record, [HOOK-41](../../docs/decisions.md#hook-41-pipelines-fee-in-the-token-on-devnet) Pipeline's fee in the token on devnet |

## On devnet

Deployed on devnet on 2026-11-22.
The hook is not a strategy, so it is never registered with Pipeline's router; its home markets are the tax AMM's.

| | |
| --- | --- |
| Program | `aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv` |
| Verified build | executable hash `f6ac2df343a63b7acf351152d2106eb3ee2ea517a8815aed2165ae7aba4cdd98`, the `solana-verify` Docker build of `77b6ddc` on `main`, recorded in [`deployments/devnet.json`](../../deployments/devnet.json) ([BAR-20](../../docs/decisions.md#bar-20-verified-builds-of-our-programs), [BAR-42](../../docs/decisions.md#bar-42-how-a-program-is-deployed-to-devnet)) |
| Upgrade authority | `Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe`, the project's one devnet upgrade authority ([BAR-23](../../docs/decisions.md#bar-23-upgrade-authority-on-devnet)); frozen before any mainnet use ([HOOK-15](../../docs/decisions.md#hook-15-mainnet-upgrade-policy)) |
| Demo tokens | three contained tokens launched by the script ([HOOK-40](../../docs/decisions.md#hook-40-the-devnet-demos-contained-tokens-and-their-record)): `AQSAyaGKsgrGqDDhA6ijW6cfuPwQkkcToSBWQBMFuk9v` against wrapped SOL, unlocked by its deadline; `64qicrEzu17dTHgikB9HtaJznqTwz7w2jCGi4V2FUwgW` against wrapped SOL, unlocked by its goal; `2e1iecsWF5aHFsuKCgUi5j5DW7wXyWRnsBMTkDHBmcXR`, quoted in an SPL Token mint of ours so that Pipeline's fee is taken in the token and swept through the hook ([HOOK-41](../../docs/decisions.md#hook-41-pipelines-fee-in-the-token-on-devnet)), still contained; every signature and address is in [`deployments/devnet-demo-containment-hook.json`](../../deployments/devnet-demo-containment-hook.json) |
| Conformance | [`conformance/devnet/`](conformance/devnet/), `pipeline-check` 0.3.0 on each home market while contained and after the unlock: 13 pass, 0 warn, 0 fail, `exact_out_refund` skipped ([HOOK-38](../../docs/decisions.md#hook-38-how-the-launch-script-checks-a-home-markets-conformance)) |

To check the deploy yourself, with `solana-verify` 0.5.2 or later and Docker, rebuild the commit as the deploy did, from an export of it and with the image it pinned, and compare the two hashes:

```sh
git archive 77b6ddc programs | tar -x -C /tmp/containment-hook-77b6ddc
solana-verify build /tmp/containment-hook-77b6ddc/programs --library-name containment_hook --arch v3 \
  --base-image solanafoundation/solana-verifiable-build@sha256:12fd4c0a0790f0fc41ef74b0cdb6bccc167ba6137eb1adb749bac649481c86bd
solana-verify get-executable-hash /tmp/containment-hook-77b6ddc/programs/target/deploy/containment_hook.so
solana-verify get-program-hash -u devnet aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv
```

## Using it

- **Launching a contained token**: [`scripts/launch.ts`](scripts/launch.ts) creates the mint with the hook, creates its tax AMM home market, binds it, seeds it, trades it with Pipeline's SDK and, if asked, unlocks it, on a local validator or on devnet; [`docs/toolchain.md`](../../docs/toolchain.md), "Containment hook", says how.
- **Hook accounts**: every transfer of a contained token needs the hook program, its validation account `["extra-account-metas", mint]` and its config `["config", mint]`, read-only, which Token-2022's client resolves from the validation account (`resolveExtraAccountMetasForExecute` in `@solana-program/token-2022`); neither Pipeline client resolves them.
- **IDL and client**: the Anchor IDL is [`idl/containment_hook.json`](idl/containment_hook.json), and [`scripts/client/`](scripts/client/) is a TypeScript client generated from it with Codama.
- **Security**: report a vulnerability through this repo's [private vulnerability reporting](https://github.com/imDev2023/testing-pipeline/security/advisories/new).
  The program has had internal reviews only, and no external audit.

Licensed Apache-2.0, as is the whole on-chain workspace ([`programs/LICENSE`](../LICENSE)).
