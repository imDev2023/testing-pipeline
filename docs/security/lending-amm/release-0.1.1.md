# Release 0.1.1: verify pass

A Stronghold of Security verify pass on release 0.1.1, the lending AMM's first upgrade on devnet, made on 2026-11-23 by [Lending AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/87).
It is an internal review, not an audit.
The pass was read-only and ran no cargo.
Its inputs were the release's diff and this folder's committed reports ([`adversarial-review.md`](adversarial-review.md), [`verification.md`](verification.md), [`maths-properties.md`](maths-properties.md)), since the original working folder is not kept.
The diff was taken against `25a209c`, the commit the program was first deployed from (executable `34f2e33c`), and is the same for the program's paths as the diff against `origin/main`, which has since moved on without touching them.

## The change

- `programs/lending-amm/src/config.rs` gains one field in the `security_txt!` macro, `source_release: "0.1.1"`, and a comment.
  The macro writes a static string into the `.security.txt` ELF section, and no instruction reads it.
- The crate's version goes from 0.1.0 to 0.1.1.
  `programs/Cargo.lock` changes only the crate's own version line, and no dependency, checksum or source moves.
- The IDL's `metadata.version` follows the crate's.
  Anchor's discriminators come from names, not the version.
- The regenerated IDL also brings in one doc string, the one on `TRADE_MAX_RESERVE_AGE_SLOTS`, whose derivation the hardening corrected for finding R2-12 (0.14% as klend counts slots, a margin of 1.7 to 3.5 times).
  That comment was already in `src/config.rs` at `25a209c`, so the deployed build was compiled from it, and doc comments compile to nothing; the constant's value in the IDL stays 9000.
- The IDL diff has no other hunk: no discriminator, instruction, account, field, type, event, error or constant moved.
- Three assertions keep the published files honest: `tests/security_txt.rs` keeps `source_release` equal to the crate's version, `tests/idl.rs` keeps the IDL's version equal to it, and a new `tests/idl.rs` test checks the IDL publishes the market state's layout as frozen at the first deploy, field for field, ending at 663 bytes with `exit_seen_slot` at 407.
- No instruction, account, check, error, event, constant, policy value, account layout or maths changed, and `programs/lending-amm/release.json` still declares no pricing change.

## Against the findings

- The Medium fixes (H001, H003, H004, H006, H024, R2-01) live in paths this release does not touch: `add_liquidity`'s same-slot gate, the one `rebalance` per transaction, the exit wait, `remove_lent_side` with `min_lent` and `min_ctokens`, and the guidance in `metadata.json`, whose errors `ReserveStale` and `BelowMinCtokens` keep their codes.
- The freshness gates and the stale-rate family (H002, H048, S002, S004, H040, H081, R2-12, R2-18) keep every bound, since `ADD_MAX_RESERVE_AGE_SLOTS = 0` and `TRADE_MAX_RESERVE_AGE_SLOTS = 9,000` are unchanged and the gates still read the reserve's `last_update.slot`.
  R2-12's corrected derivation is the one doc string the IDL gains, now matching the source.
- The Kamino reads and valuation fixes and residuals (H005, H007, H008, H021, H039, H054, H065, H068, H091, R2-14, R2-19) keep their code untouched: no klend offset, reserve version check, `lent_entry` check, rate headroom, build-time assert or allowlisted discriminator moved.
- The withdraw mode and `rebalance` findings (the H004 residual, H016 to H020, H025, H035, H077, S003, R2-02, R2-04, R2-06, R2-15, R2-16's residual, R2-17, R2F-02) are unaffected: `WITHDRAW_MODE_EXIT_DELAY_SLOTS`, the entry and exit multiples, the forget path, `pipeline_resolve_accounts` and `exit_seen_slot`'s place in the market state are unchanged.
- The lent-side exit's findings (H006's residual, R2-03, R2-08, R2-11, R2F-01) keep `remove_lent_side` as it was.
- The listing, fee and state findings (H015, H023, H034, H037, H053, H060, H078, H093, R2-13) are unaffected: market creation, the LP fee bounds, the mint rules, the events, `STATE_VERSION` and `metadata.json` are unchanged, and the new layout test pins the final layout H053's acceptance rests on (`LENDING-44`).
- The tests, proofs and scripts findings (H087, R2-05's residual, R2-07, R2-09's residual, R2-10, R2F-03, R2F-04) gain only the three assertions above, and the demo script's changes in the same branch leave R2-07's `maximumsAtRatio` as it was.
  R2F-04's over-long comment line on `TRADE_MAX_RESERVE_AGE_SLOTS` (`src/config.rs:55`) now also appears in the IDL's doc string as written; wording only.
- The 30 maths properties of [`maths-properties.md`](maths-properties.md) hold as established, since no pricing, valuation, share, buffer or withdraw mode formula changed.
- H075 is unaffected: this release is the devnet upgrade under the one project upgrade authority that `BAR-23` accepts, and the freeze, registration and metadata URI it concerns are untouched.
- H102 is unaffected: the release reads no oracle account and changes no refresh path, and the devnet oracle check it names belongs to #87's deploy, not to this upgrade.
- The release gate (`LENDING-100`) was built after the hardening review and is outside its findings; this release runs through it as designed, and because a replay cannot tell a value-moving constant from a deliberate one, the diff was read line by line: it moves no constant, policy value or instruction.
- `auditors` stays "None" in the `security.txt`, and its test still says so (`BAR-19`).

Verdict: no finding reopened, and no new finding.
