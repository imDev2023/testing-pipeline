#!/usr/bin/env bash
# Copies the devnet accounts the lending AMM's local demo run needs into fixtures/accounts/,
# where scripts/local-validator.sh loads every JSON file it finds, at its address:
#
#   - the collateral (cToken) mint of each reserve of our Kamino lending market on devnet,
#     from deployments/kamino-devnet.json, since creating a market creates its cToken account
#     for the lent mint's collateral mint.
#
#   bash programs/lending-amm/scripts/fetch-accounts.sh    # needs the Solana CLI and devnet RPC
#
# The klend program and the rest of our lending market's accounts join these fixtures with
# Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve (#79). Nothing
# here is committed: fixtures/ is gitignored.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${FIXTURES_DIR:-$ROOT/fixtures}/accounts"
RPC="${RPC_URL:-https://api.devnet.solana.com}"
mkdir -p "$OUT"
python3 - "$ROOT/deployments/kamino-devnet.json" <<'PY' | while read -r label address; do
import json, sys
deployment = json.load(open(sys.argv[1]))
for name, reserve in deployment["reserves"].items():
    print(f"collateral-mint-{name} {reserve['collateralMint']}")
PY
  for attempt in 1 2 3 4 5; do
    if solana account -u "$RPC" "$address" --output json-compact -o "$OUT/$label.json" >/dev/null; then
      break
    fi
    [ "$attempt" -eq 5 ] && { echo "could not fetch $address" >&2; exit 1; }
    sleep 3
  done
  echo "$label $address -> $OUT/$label.json"
done
