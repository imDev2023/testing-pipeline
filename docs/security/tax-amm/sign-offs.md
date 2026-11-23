# Tax AMM: the owner's sign-offs

The engineering and security bar accepts a Low finding only with the owner's written sign-off, recorded in the report ([`docs/spec/README.md`, Internal adversarial review](../../spec/README.md#internal-adversarial-review)).
These are the findings of the internal adversarial review of the tax AMM ([README.md](README.md)) left open as accepted Lows.
This is not an audit; the findings are described in [round-1.md](round-1.md) and [round-2.md](round-2.md).

## Accepted Lows

Rows from round 1: signed off by the owner on 2026-11-22 (answer 5a on [#67](https://github.com/imDev2023/testing-pipeline/issues/67), and its addendum for H039 and H071).
Rows from round 2: signed off by the owner on 2026-11-23 (recorded on #67).
Each is a default MetalLegBob may change.

| ID | What remains open | Why it is accepted | What would change it |
| --- | --- | --- | --- |
| H025 | A recipient whose own token account requires memos, or is frozen, can't be paid; only its own slot waits | Each slot pays separately, so nothing else stops; only quote mints can keep a freeze authority (`TAX-58`) | A memo sent before each payout, a change to `distribute`'s accounts |
| R02 | Under `TAX-39` (answer 3a) such a slot can't be handed to another wallet while it is owed, so a recipient that turns on required memos pins itself to its slot, at a share the authority can cut to 1 basis point, until it turns them off | Answer 3a named this cost when it was chosen; the slot earns next to nothing meanwhile and no one else's tax is touched | The same memo change as H025 |
| H026 | A contained mint used as the tax side of a market other than its home market refuses every transfer, so that market can't trade | Closed for every foreign hook by answer 1a; such a market never books tax, so nothing is stranded | None needed |
| H028 | A hook acting as tax authority inside a router transaction | Closed by answers 1a (only the containment hook runs, and it never acts as a tax authority) and 2a (a change of rates waits 300 slots) | None needed |
| H030 | A hook could behave differently in simulation than in execution | Only the containment hook can run now, and the program has no simulation-dependent branch; simulation trust is Canary's side | None needed |
| H034 | The router is every market's only exit, and its id is compiled in | Pipeline's permissionless router is the product's premise; `sos_h001` pins the compiled id, and the spec states the dependency | A router that stopped serving markets, or a mainnet build with another router id |
| H035 | A tax recipient sandwiches a trade more cheaply than an outsider, since most of its tax comes back to it | The rate flip it added is gone with answer 2a; what remains is the friction a recipient doesn't pay, visible in its share | A per-trade cap on recipients' own trades, which the program can't identify |
| H036 | Tokens held outside the market when it is seeded sell into the curve first; on a market with a virtual reserve they can take everything buyers paid in, and a holder's largest sale the real reserve covers may then be dust | No mint authority survives the seed (answer 1a), so that supply is fixed and readable before anyone buys; the spec's "Locked for good" says so | A rule on how much supply may sit outside the seed, which the program can't see |
| H086 | Supply kept back or pre-mined sells into the curve and takes quote in proportion, as in any constant-product pool | The same as H036 | The same as H036 |
| H037 | An upgrade lowering `MAX_TAX_BPS` would block swaps or `set_taxes` on markets above the new cap | The upgrade key is trusted (H039); the spec says an upgrade never lowers it, and the release gate catches a stored rate above it | A frozen program |
| H039 | One upgrade key upgrades every suite program on devnet, so one upgrade could change anything in every market | Devnet only; freezing the program before mainnet is on the mainnet checklist | Freezing the program |
| Rollback | A rollback to a build from before the pending rates ignores a pending change, and rolling forward applies it at the next swap or `set_taxes`, inside its range and the cap | Only the upgrade key can cause it, which H039 already trusts with every market; the spec says a rollback should come with the authorities re-setting their rates | Freezing the program |
| H044 | A compromised tax authority can't be rotated (`TAX-05`) | A change of rates now waits 300 slots, so the holder can renounce in that window and cancel it; `set_recipients` can't redirect owed tax (answer 3a) | A two-step rotation of the tax authority |
| H055 | The seeder sets the opening price and can trade first | The price is the seeder's own, the market's terms are bound by the seed (answer 4a), and later buyers see the reserves | An optional delay before the first swap |
| H056 | A market's recorded age is its creation, not its opening | No funds at risk; 52 reserved bytes remain if an opening stamp is wanted | An opening slot and time in the reserved bytes |
| H061 | A recipient that closes its token account after each payout makes the next `distribute` caller pay its rent again | The keeper caps what it pays, and anyone may simply not pay that slot | A minimum owed amount for a payout that creates an account |
| H062 | Anyone can create Created markets naming any seeder, which stay forever with no funds | The creator pays the rent, the seed now binds the terms (answer 4a), and Aviary lists open markets | Closing a never-seeded market after a while |
| H071 | `SUITE_TREASURY` and devnet USDC in `QUOTE_MINTS` are compiled in with no check of the cluster | Devnet only; a mainnet build must name mainnet's treasury and USDC before it is frozen, on the mainnet checklist | A cluster feature that refuses the devnet values at build time |
| H076 | A recipient wallet ground for many bumps can push its own creating payout past the default compute limit | Any caller can raise the compute limit; the ceilings leave bump searches out | None needed |
| H080 | A creator's own hook could refuse its own seed | Only the containment hook can run, and its authority only clears it; the seed reverts whole | None needed |
| H092 | Look-alike markets for the same pair can route traders to a live authority and a wide range | Rates are capped at 10% and a change waits 300 slots (answer 2a); showing the terms is Aviary's side | Aviary's market page and quote showing the terms |
| H096 | A live authority can raise rates inside their public range before an exit wave | A change now waits 300 slots, public on chain, and stays inside a range fixed at creation | A narrower range, the creator's choice |

## Info, not gated

H050 (the tax rounds up, so a dust trade pays above the cap by under one unit, stated in the spec), H082 (buy and sell tax are named by the tax side; interfaces label rates by direction) and round 2's Info notes R03 to R06 ([round-2.md](round-2.md)).
None needs a sign-off under the bar.
