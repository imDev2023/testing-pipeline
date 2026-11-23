#!/usr/bin/env bash
# Runs a local validator with devnet's Pipeline router and this repo's programs, for the
# local demo runs (docs/toolchain.md, "Local demo run"):
#
#   - the router's bytes from fixtures/router/pipeline.so, refused unless they match the hash
#     pinned in fixtures/pins.env (scripts/fetch-router.sh fetches them), and its config
#     account as devnet has it, so the listing fee and recipients are devnet's;
#   - every program of programs/Cargo.toml's workspace, from programs/target/deploy (or
#     $CARGO_TARGET_DIR/deploy, where scripts/build-programs.sh writes them then), at its
#     declare_id! address and upgradeable by the project upgrade authority, as on devnet;
#   - the workspace's test programs (the stand-in launchpad), from $TEST_PROGRAMS_DIR
#     (default fixtures/test-programs), at their declare_id! addresses and frozen; they never
#     go to devnet;
#   - every account copied from devnet into fixtures/accounts/*.json (`solana account --output
#     json`), at its address, such as the Kamino accounts the lending AMM's demo needs
#     (programs/lending-amm/scripts/fetch-accounts.sh), and, when fixtures/accounts/warp-slot
#     exists, the validator warped to that slot, past the slot those accounts were read at;
#   - Kamino Lend (klend) as devnet runs it, from fixtures/klend/devnet.so, when
#     programs/lending-amm/scripts/fetch-klend.sh has fetched it, refused unless it matches the
#     hash pinned in fixtures/pins.env.
#
#   scripts/local-validator.sh [ledger directory] [solana-test-validator flags ...]
#
# The ledger defaults to fixtures/test-ledger. Flags (the arguments from the first that
# starts with "-") go to solana-test-validator, such as other ports when another project's
# validator holds the defaults:
#
#   scripts/local-validator.sh --rpc-port 8999 --faucet-port 9910 \
#     --gossip-port 8100 --dynamic-port-range 8101-8130
#
# Environment: UPGRADE_AUTHORITY, the upgrade authority's keypair (default
# ~/.config/testing-pipeline/devnet/upgrade-authority.json); only its public key is read.
# SKIP_PROGRAMS, workspace programs to leave out (space-separated, such as "tax-amm"), so a
# rehearsal of scripts/deploy-devnet.sh can deploy one as it would be deployed on devnet.
# ROUTER_UPGRADE_AUTHORITY, a keypair whose public key may upgrade the router on this validator
# (default: none, frozen as on devnet for anyone but its author), for a local run that upgrades it,
# such as Aviary's strategy-versions demo (tests/terminal-e2e/demo/strategy-versions.ts).
# Runs in the foreground until stopped; RPC on http://127.0.0.1:8899. Starts from an empty
# ledger every time. Needs the toolchain (source scripts/toolchain-env.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES_DIR="${FIXTURES_DIR:-$ROOT/fixtures}"
TEST_PROGRAMS_DIR="${TEST_PROGRAMS_DIR:-$FIXTURES_DIR/test-programs}"
LEDGER="$FIXTURES_DIR/test-ledger"
if [ "$#" -gt 0 ] && [ "${1#-}" = "$1" ]; then
  LEDGER="$1"
  shift
fi
EXTRA_FLAGS=("$@")
UPGRADE_AUTHORITY="${UPGRADE_AUTHORITY:-$HOME/.config/testing-pipeline/devnet/upgrade-authority.json}"
# SIMD-0268's deeper call limit: test validators turn it on, devnet and mainnet don't have it.
SIMD_0268=6TkHkRmP7JZy1fdM6fg5uXn76wChQBWGokHBJzrLB3mj

# shellcheck source=../fixtures/pins.env
source "$FIXTURES_DIR/pins.env"
ROUTER_SO="$FIXTURES_DIR/router/pipeline.so"
ROUTER_CONFIG_JSON="$FIXTURES_DIR/router/config.json"
if [ ! -f "$ROUTER_SO" ] || [ ! -f "$ROUTER_CONFIG_JSON" ]; then
  echo "No router fixture: run scripts/fetch-router.sh first." >&2
  exit 1
fi
if [ "$(shasum -a 256 "$ROUTER_SO" | awk '{print $1}')" != "$ROUTER_SHA256" ]; then
  echo "Refusing $ROUTER_SO: it does not match the pinned hash. Run scripts/fetch-router.sh." >&2
  exit 1
fi
AUTHORITY="$(solana-keygen pubkey "$UPGRADE_AUTHORITY")"
ROUTER_AUTHORITY=none
if [ -n "${ROUTER_UPGRADE_AUTHORITY:-}" ]; then
  ROUTER_AUTHORITY="$(solana-keygen pubkey "$ROUTER_UPGRADE_AUTHORITY")"
fi

args=(
  --reset --ledger "$LEDGER"
  --deactivate-feature "$SIMD_0268"
  --upgradeable-program "$ROUTER_PROGRAM" "$ROUTER_SO" "$ROUTER_AUTHORITY"
  --account "$ROUTER_CONFIG" "$ROUTER_CONFIG_JSON"
)
while IFS= read -r member; do
  if [[ " ${SKIP_PROGRAMS:-} " == *" $member "* ]]; then
    echo "$member left out (SKIP_PROGRAMS)"
    continue
  fi
  lib="${member//-/_}"
  so="${CARGO_TARGET_DIR:-$ROOT/programs/target}/deploy/$lib.so"
  id="$(sed -n 's/^declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)");$/\1/p' "$ROOT/programs/$member/src/lib.rs")"
  if [ ! -f "$so" ]; then
    echo "No $so: build it with cargo build-sbf --manifest-path programs/$member/Cargo.toml" >&2
    exit 1
  fi
  if [ -z "$id" ]; then
    echo "No declare_id! address in programs/$member/src/lib.rs" >&2
    exit 1
  fi
  echo "$member at $id, upgradeable by $AUTHORITY"
  args+=(--upgradeable-program "$id" "$so" "$AUTHORITY")
done < <(python3 "$ROOT/scripts/workspace-programs.py")

# Test programs (the stand-in launchpad), from $TEST_PROGRAMS_DIR where
# scripts/build-programs.sh builds them, frozen: they exist only on local validators.
while IFS= read -r member; do
  lib="$(basename "$member")"
  lib="${lib//-/_}"
  so="$TEST_PROGRAMS_DIR/$lib.so"
  id="$(sed -n 's/^declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)");$/\1/p' "$ROOT/programs/$member/src/lib.rs")"
  if [ ! -f "$so" ]; then
    echo "No $so: build it with scripts/build-programs.sh $member" >&2
    exit 1
  fi
  if [ -z "$id" ]; then
    echo "No declare_id! address in programs/$member/src/lib.rs" >&2
    exit 1
  fi
  echo "test program $member at $id"
  args+=(--upgradeable-program "$id" "$so" none)
done < <(python3 "$ROOT/scripts/workspace-programs.py" --test-programs)
KLEND_SO="$FIXTURES_DIR/klend/devnet.so"
if [ -f "$KLEND_SO" ]; then
  if [ "$(shasum -a 256 "$KLEND_SO" | awk '{print $1}')" != "${KLEND_DEVNET_SHA256:-}" ]; then
    echo "Refusing $KLEND_SO: it does not match the pinned hash. Run programs/lending-amm/scripts/fetch-klend.sh." >&2
    exit 1
  fi
  echo "klend $KLEND_PROGRAM from $KLEND_SO (pinned)"
  args+=(--upgradeable-program "$KLEND_PROGRAM" "$KLEND_SO" none)
fi
if [ -f "$FIXTURES_DIR/accounts/warp-slot" ]; then
  warp="$(cat "$FIXTURES_DIR/accounts/warp-slot")"
  echo "warping to slot $warp, past the slot the copied accounts were read at"
  args+=(--warp-slot "$warp")
fi

shopt -s nullglob
for account in "$FIXTURES_DIR"/accounts/*.json; do
  address="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["pubkey"])' "$account")"
  echo "account $address from $account"
  args+=(--account "$address" "$account")
done

echo "Router $ROUTER_PROGRAM from $ROUTER_SO (pinned), config $ROUTER_CONFIG as on devnet"
echo "Ledger $LEDGER; RPC http://127.0.0.1:8899 unless --rpc-port says otherwise"
exec solana-test-validator "${args[@]}" ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"}
