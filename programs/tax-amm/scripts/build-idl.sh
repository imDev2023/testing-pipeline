#!/usr/bin/env bash
# Builds the tax AMM's Anchor IDL into programs/tax-amm/idl/tax_amm.json, which the
# metadata links to and the TypeScript client (client/, `pnpm client`) is generated from.
# Run it after any change to the program's instructions, accounts, arguments, events or
# errors, then `pnpm client`; tests/idl.rs fails while the IDL disagrees with the program.
#
#   bash build-idl.sh        # from programs/tax-amm/scripts, or `pnpm idl`
#
# Needs anchor-cli 1.2 (`avm install 1.2.1`), as $ANCHOR, `anchor-1.2.1` on PATH or avm's
# copy, and the toolchain (source scripts/toolchain-env.sh).
set -euo pipefail
PROGRAM="$(cd "$(dirname "$0")/.." && pwd)"

anchor="${ANCHOR:-}"
if [ -z "$anchor" ]; then
  for candidate in anchor-1.2.1 "$HOME/.avm/bin/anchor-1.2.1" anchor; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" --version | grep -q '^anchor-cli 1\.2\.'; then
      anchor="$candidate"
      break
    fi
  done
fi
if [ -z "$anchor" ]; then
  echo "anchor-cli 1.2 not found: install it with \`avm install 1.2.1\` or set ANCHOR" >&2
  exit 1
fi

cd "$PROGRAM"
mkdir -p idl
"$anchor" idl build --program-name tax_amm --out idl/tax_amm.json
echo "wrote $PROGRAM/idl/tax_amm.json"
