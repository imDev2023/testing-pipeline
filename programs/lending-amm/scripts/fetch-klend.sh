#!/usr/bin/env bash
# Copies Kamino Lend's deployed program (klend) from mainnet and devnet into fixtures/klend/,
# where the lending AMM's LiteSVM tests and the local validator load it, and refuses each
# unless its SHA-256 equals the hash pinned in fixtures/pins.env, as scripts/fetch-router.sh
# does for the router (docs/spec/lending-pool.md, "Building it").
#
#   bash programs/lending-amm/scripts/fetch-klend.sh [mainnet] [devnet]   # both by default
#
# Writes fixtures/klend/mainnet.so and fixtures/klend/devnet.so. klend is BSL 1.1, so its
# bytes are only ever fetched, never committed (fixtures/ is gitignored). Public RPC only;
# MAINNET_RPC_URL and DEVNET_RPC_URL override the clusters' public endpoints. Needs `solana`
# on PATH (source scripts/toolchain-env.sh).
#
# When Kamino upgrades klend on a cluster this fails for that cluster and keeps the pinned
# copy already in place. Re-pin deliberately, in a PR of its own:
#   1. fetch the new bytes with KLEND_ACCEPT_ANY_HASH=1, which writes them and prints their hash;
#   2. check the release's Reserve and LendingMarket layouts against the offsets in
#      programs/lending-amm/src/kamino.rs and docs/spec/lending-pool.md, and dump the
#      accounts again (programs/lending-amm/scripts/kamino_accounts.py check, then dump);
#   3. run the lending AMM's tests on both cluster builds against the new bytes;
#   4. change KLEND_<CLUSTER>_SHA256 in fixtures/pins.env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIXTURES_DIR="${FIXTURES_DIR:-$ROOT/fixtures}"

# shellcheck source=../../../fixtures/pins.env
source "$FIXTURES_DIR/pins.env"
: "${KLEND_PROGRAM:?missing from pins.env}" "${KLEND_MAINNET_SHA256:?missing from pins.env}" "${KLEND_DEVNET_SHA256:?missing from pins.env}"

clusters=("$@")
[ ${#clusters[@]} -gt 0 ] || clusters=(mainnet devnet)

OUT="$FIXTURES_DIR/klend"
sha256() { shasum -a 256 "$1" | awk '{print $1}'; }

# Public RPC sometimes fails a request outright (429 Too Many Requests several times in a
# row among the causes), so each download gets six tries, each wait twice the one before
# (5 seconds, then 10, 20, 40 and 80: under three minutes in all), as in
# scripts/fetch-router.sh; a hash mismatch is never retried.
retry() {
  local attempt delay="${FETCH_RETRY_DELAY:-5}"
  for attempt in 1 2 3 4 5 6; do
    if "$@"; then return 0; fi
    if [ "$attempt" -lt 6 ]; then
      echo "Download failed (try $attempt of 6); retrying in ${delay}s." >&2
      sleep "$delay"
      delay=$((delay * 2))
    fi
  done
  return 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
status=0
for cluster in "${clusters[@]}"; do
  case "$cluster" in
    mainnet) pinned="$KLEND_MAINNET_SHA256"; url="${MAINNET_RPC_URL:-mainnet-beta}" ;;
    devnet) pinned="$KLEND_DEVNET_SHA256"; url="${DEVNET_RPC_URL:-devnet}" ;;
    *) echo "Unknown cluster $cluster: expected mainnet or devnet." >&2; exit 2 ;;
  esac
  target="$OUT/$cluster.so"

  # A copy already in place is used only while it matches the pin.
  if [ -f "$target" ] && [ "$(sha256 "$target")" != "$pinned" ]; then
    echo "Removing $target: it does not match the pinned hash." >&2
    rm -f "$target"
  fi

  if ! retry solana program dump --url "$url" "$KLEND_PROGRAM" "$work/$cluster.so" >/dev/null; then
    echo "Could not download klend from $cluster after 3 tries; its copy is not refreshed." >&2
    status=1
    continue
  fi
  actual="$(sha256 "$work/$cluster.so")"
  if [ "$actual" != "$pinned" ] && [ -z "${KLEND_ACCEPT_ANY_HASH:-}" ]; then
    cat >&2 <<EOF
Refusing klend dumped from $cluster: its SHA-256 is
  $actual
but fixtures/pins.env pins KLEND_$(echo "$cluster" | tr '[:lower:]' '[:upper:]')_SHA256 as
  $pinned
Kamino has probably upgraded klend on $cluster. To re-pin deliberately, follow the steps at
the top of programs/lending-amm/scripts/fetch-klend.sh.
EOF
    status=1
    continue
  fi
  mkdir -p "$OUT"
  mv "$work/$cluster.so" "$target"
  if [ "$actual" = "$pinned" ]; then
    echo "klend $KLEND_PROGRAM from $cluster -> $target (SHA-256 $actual, as pinned)"
  else
    echo "klend $KLEND_PROGRAM from $cluster -> $target (SHA-256 $actual, NOT the pinned $pinned: KLEND_ACCEPT_ANY_HASH is set)"
  fi
done
exit "$status"
