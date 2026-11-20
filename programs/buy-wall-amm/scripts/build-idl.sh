#!/usr/bin/env bash
# Builds the buy wall AMM's Anchor IDL into programs/buy-wall-amm/idl/buy_wall_amm.json, which the
# metadata links to and the TypeScript client (client/, `pnpm client`) is generated from.
# Run it after any change to the program's instructions, accounts, arguments, events or
# errors, then `pnpm client`; tests/idl.rs fails while the IDL disagrees with the program.
#
#   bash build-idl.sh        # from programs/buy-wall-amm/scripts, or `pnpm idl`
#
# Needs anchor-cli 1.2, as $ANCHOR, on PATH or avm's copy, and the toolchain (source
# scripts/toolchain-env.sh). The crates pin Anchor 1.2.2 (programs/Cargo.toml), so anchor-cli
# 1.2.2 (`avm install 1.2.2`) is preferred; since the IDL is compiled by the crates' own
# anchor-lang, an anchor-cli 1.2.1 writes the same IDL and is taken when 1.2.2 is missing.
set -euo pipefail
PROGRAM="$(cd "$(dirname "$0")/.." && pwd)"

anchor="${ANCHOR:-}"
if [ -z "$anchor" ]; then
  for candidate in anchor-1.2.2 "$HOME/.avm/bin/anchor-1.2.2" anchor-1.2.1 "$HOME/.avm/bin/anchor-1.2.1" anchor; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" --version | grep -q '^anchor-cli 1\.2\.'; then
      anchor="$candidate"
      break
    fi
  done
fi
if [ -z "$anchor" ]; then
  echo "anchor-cli 1.2 not found: install it with \`avm install 1.2.2\` or set ANCHOR" >&2
  exit 1
fi

cd "$PROGRAM"
mkdir -p idl
"$anchor" idl build --program-name buy_wall_amm --out idl/buy_wall_amm.json
echo "wrote $PROGRAM/idl/buy_wall_amm.json"
