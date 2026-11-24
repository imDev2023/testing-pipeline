#!/usr/bin/env bash
# The local validator of Aviary's hooked-mints demo (#122; tests/terminal-e2e/demo/hooked-mints.ts):
# devnet's Pipeline router with its config account as devnet has it, Pipeline's Apache-2.0
# test-strategy-cp at its own address (devnet's constant-product strategy), upgradeable by the demo's
# throwaway key so the demo can register it, and Pipeline's two Token-2022 test hooks, test-hook (an
# allowlist hook with one extra account) and test-hook-refill (four fixed extra accounts, two of them
# writable), at the addresses of the keypairs Pipeline's build writes beside them.
#
#   tests/terminal-e2e/demo/hooked-validator.sh <ledger dir> [solana-test-validator flags ...]
#
# Every program comes from fixtures/: the router from fixtures/router (scripts/fetch-router.sh, refused
# unless it matches the pin), the rest from Pipeline's clone built by
# `scripts/fetch-pipeline.sh sdk programs`. The demo's key is <ledger dir>/../authority.json (made
# when missing); only its public key is read here. Flags go to solana-test-validator, such as ports
# of its own beside another session's validator. Runs in the foreground from an empty ledger (agents:
# with run_in_background, stopped with TaskStop). Needs the toolchain (source scripts/toolchain-env.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LEDGER="${1:?usage: hooked-validator.sh <ledger dir> [solana-test-validator flags ...]}"
shift
DEPLOY="$ROOT/fixtures/pipeline/programs/target/deploy"
# SIMD-0268's deeper call limit: test validators turn it on, devnet and mainnet don't have it.
SIMD_0268=6TkHkRmP7JZy1fdM6fg5uXn76wChQBWGokHBJzrLB3mj

# shellcheck source=../../../fixtures/pins.env
source "$ROOT/fixtures/pins.env"
ROUTER_SO="$ROOT/fixtures/router/pipeline.so"
[ -f "$ROUTER_SO" ] || { echo "No router fixture: run scripts/fetch-router.sh first." >&2; exit 1; }
[ "$(shasum -a 256 "$ROUTER_SO" | awk '{print $1}')" = "$ROUTER_SHA256" ] || { echo "Refusing $ROUTER_SO: it does not match the pinned hash. Run scripts/fetch-router.sh." >&2; exit 1; }
for so in test_strategy_cp test_hook test_hook_refill; do
  [ -f "$DEPLOY/$so.so" ] || { echo "No $DEPLOY/$so.so: run scripts/fetch-pipeline.sh sdk programs." >&2; exit 1; }
done

mkdir -p "$LEDGER"
AUTHORITY_KEY="$(cd "$LEDGER/.." && pwd)/authority.json"
[ -f "$AUTHORITY_KEY" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$AUTHORITY_KEY"
AUTHORITY="$(solana-keygen pubkey "$AUTHORITY_KEY")"
CP="$(sed -n 's/^declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)");$/\1/p' "$ROOT/fixtures/pipeline/programs/test-strategy-cp/src/lib.rs")"
HOOK="$(solana-keygen pubkey "$DEPLOY/test_hook-keypair.json")"
REFILL="$(solana-keygen pubkey "$DEPLOY/test_hook_refill-keypair.json")"
echo "router $ROUTER_PROGRAM (pinned), test-strategy-cp $CP upgradeable by $AUTHORITY, test-hook $HOOK, test-hook-refill $REFILL"

exec solana-test-validator --reset --ledger "$LEDGER" \
  --deactivate-feature "$SIMD_0268" \
  --upgradeable-program "$ROUTER_PROGRAM" "$ROUTER_SO" none \
  --account "$ROUTER_CONFIG" "$ROOT/fixtures/router/config.json" \
  --upgradeable-program "$CP" "$DEPLOY/test_strategy_cp.so" "$AUTHORITY" \
  --bpf-program "$HOOK" "$DEPLOY/test_hook.so" \
  --bpf-program "$REFILL" "$DEPLOY/test_hook_refill.so" \
  "$@"
