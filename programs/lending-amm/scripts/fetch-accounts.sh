#!/usr/bin/env bash
# Clones the accounts of our Kamino lending market on devnet into fixtures/accounts/, where
# scripts/local-validator.sh loads every JSON file it finds, at its address, for the lending
# AMM's local demo run (docs/toolchain.md, "Local demo run"):
#
#   - for each reserve in deployments/kamino-devnet.json: the reserve, its liquidity and
#     collateral mints, and its liquidity supply, fee vault and collateral supply token
#     accounts; and the lending market (and its authority, when it holds an account), all read
#     at one slot by scripts/kamino_accounts.py;
#   - fixtures/accounts/warp-slot, the slot after that one, which scripts/local-validator.sh
#     warps the validator to, so that Kamino's own slots are never in the validator's future;
#   - for the Kamino-side commands of scripts/kamino-devnet the demo calls (the test borrower's
#     borrow and repay, and emergency mode on and off), the reserves' two Pyth price accounts,
#     their publish time moved ahead so every price is fresh, and klend's global config
#     (scripts/kamino_accounts.py local).
#
#   bash programs/lending-amm/scripts/fetch-accounts.sh    # needs python3, curl and devnet RPC
#
# Devnet's klend itself comes from programs/lending-amm/scripts/fetch-klend.sh, checked against
# its pinned hash. Nothing here is committed: fixtures/ is gitignored. RPC_URL overrides
# devnet's public RPC.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${FIXTURES_DIR:-$ROOT/fixtures}/accounts"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
python3 "$ROOT/programs/lending-amm/scripts/kamino_accounts.py" dump --cluster devnet --out "$work"
python3 "$ROOT/programs/lending-amm/scripts/kamino_accounts.py" local --cluster devnet --out "$work/local"

mkdir -p "$OUT"
rm -f "$OUT"/kamino-*.json "$OUT"/collateral-mint-*.json "$OUT/warp-slot"
for file in "$work"/*.json "$work"/local/*.json; do
  name="$(basename "$file")"
  [ "$name" = manifest.json ] && continue
  cp "$file" "$OUT/kamino-$name"
done
slot="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["slot"] + 1)' "$work/manifest.json")"
echo "$slot" > "$OUT/warp-slot"
echo "Kamino accounts of our devnet lending market -> $OUT/kamino-*.json; the validator warps to slot $slot"
