#!/usr/bin/env bash
# Copies the Pipeline router deployed on devnet into fixtures/router/, where the LiteSVM
# tests and the local validator load it, and refuses it unless its SHA-256 equals the hash
# pinned in fixtures/pins.env. Grown from the strategy template's scripts/fetch-router.sh.
#
#   scripts/fetch-router.sh [cluster]     # cluster defaults to devnet
#
# Writes fixtures/router/pipeline.so (the router's program bytes) and
# fixtures/router/config.json (its config account, for the local validator). Neither is
# ever committed. Needs `solana` on PATH (source scripts/toolchain-env.sh).
#
# When MetalLegBob upgrades the devnet router this fails, and keeps the pinned copy
# already in place. Re-pin deliberately: run the tests against the new bytes, then change
# ROUTER_SHA256 in fixtures/pins.env in a PR of its own (docs/spec/README.md, "Test layers").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES_DIR="${FIXTURES_DIR:-$ROOT/fixtures}"
CLUSTER="${1:-devnet}"

# shellcheck source=../fixtures/pins.env
source "$FIXTURES_DIR/pins.env"
: "${ROUTER_PROGRAM:?missing from pins.env}" "${ROUTER_CONFIG:?missing from pins.env}" "${ROUTER_SHA256:?missing from pins.env}"

OUT="$FIXTURES_DIR/router"
sha256() { shasum -a 256 "$1" | awk '{print $1}'; }

# Public devnet RPC sometimes fails a request outright (a timeout, or "error decoding
# response body"), so each download gets three tries; a hash mismatch is never retried.
retry() {
  local attempt
  for attempt in 1 2 3; do
    if "$@"; then return 0; fi
    if [ "$attempt" -lt 3 ]; then
      echo "Download failed (try $attempt of 3); retrying." >&2
      sleep "${FETCH_RETRY_DELAY:-5}"
    fi
  done
  return 1
}

# A copy already in place is used only while it matches the pin.
if [ -f "$OUT/pipeline.so" ] && [ "$(sha256 "$OUT/pipeline.so")" != "$ROUTER_SHA256" ]; then
  echo "Removing $OUT/pipeline.so: it does not match the pinned hash." >&2
  rm -f "$OUT/pipeline.so" "$OUT/config.json"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
retry solana program dump --url "$CLUSTER" "$ROUTER_PROGRAM" "$work/pipeline.so" >/dev/null
actual="$(sha256 "$work/pipeline.so")"
if [ "$actual" != "$ROUTER_SHA256" ]; then
  cat >&2 <<EOF
Refusing the router dumped from $CLUSTER: its SHA-256 is
  $actual
but fixtures/pins.env pins
  $ROUTER_SHA256
The devnet router has probably been upgraded. Run the tests against the new bytes, then
re-pin ROUTER_SHA256 in a PR of its own.
EOF
  exit 1
fi
retry solana account --url "$CLUSTER" "$ROUTER_CONFIG" --output json --output-file "$work/config.json" >/dev/null

mkdir -p "$OUT"
mv "$work/config.json" "$OUT/config.json"
mv "$work/pipeline.so" "$OUT/pipeline.so"
echo "Router $ROUTER_PROGRAM from $CLUSTER -> $OUT/pipeline.so (SHA-256 $actual, as pinned)"
echo "Config $ROUTER_CONFIG -> $OUT/config.json"
