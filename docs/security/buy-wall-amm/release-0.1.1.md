# Release 0.1.1: verify pass

A Stronghold of Security verify pass on release 0.1.1, the buy wall AMM's first upgrade on devnet, made on 2026-11-20 by [Buy wall AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/56).
It is an internal review, not an audit.
The pass was read-only and ran no cargo.
Its inputs were the release's diff and this folder's committed reports ([`round-1.md`](round-1.md), [`round-2.md`](round-2.md), [`sign-offs.md`](sign-offs.md)), since the original working folder is not kept.

## The change

- `programs/buy-wall-amm/src/config.rs` gains one field in the `security_txt!` macro, `source_release: "0.1.1"`, and a comment.
  The macro writes a static string into the `.security.txt` ELF section, and no instruction reads it.
- The crate's version goes from 0.1.0 to 0.1.1.
  `programs/Cargo.lock` changes only the crate's own version line, and no dependency, checksum or source moves.
- The IDL's `metadata.version` follows the crate's.
  Anchor's discriminators come from names, not the version, and the generated client holds no version.
- Two assertions keep both equal to the crate's version: `tests/security_txt.rs` for `source_release`, and `tests/idl.rs` for the IDL's version, the second added after this pass noted nothing pinned it.
- No instruction, account, check, error, event, constant or market state field changed, and `MARKET_STATE_SIZE`, `LAYOUT_VERSION` and `DEPLOYED_LAYOUT_VERSIONS` are untouched.

## Against the findings

- The seed, swap, trim, wall, payout and handover fixes (H001, H003 to H005, H007, H022, H031, H041, H048, H050, H056, H061, H063, H065) live in paths this release does not touch.
- The reward share, decay credit, floor and tip residuals (H002, H008, H040, H059, R2-01 to R2-04) keep every measured bound, since no maths, constant or slot rule changed.
- The hardened and Info fixes (H009, H023, H044, H064, H067, H076, H099, R2-05, R2-06) keep their code untouched.
- The tests, proofs and error codes (H062, H066, H068, H069) gain only the two assertions above.
- The operational and design Lows (H021, H024 to H026, H070, H110, H111) are unaffected: `DESIGNER_RECIPIENT`, the upgrade policy, `seed`'s arguments and market creation are unchanged.
- H034, the gate's blind spot for value-moving constants, is the residual such a release could use, so the diff was read line by line: it moves no treasury, share constant, `KEEPER_TIP_CAP` or instruction.
- The gate and deploy findings (H013, H020, H033, H058, H097, H098, R2G-01 to R2G-09) are unaffected, since nothing under `gate/` or the deploy scripts changed; this release runs through the gate and the deploy window they describe, as designed.
- `auditors` stays "None" in the `security.txt`, and its test still says so (`BAR-19`).

Verdict: no finding reopened, and no new finding.
