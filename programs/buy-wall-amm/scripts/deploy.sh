#!/usr/bin/env bash
# Deploys or upgrades the buy wall AMM, and only a build the release gate has passed against
# the cluster it deploys to (docs/spec/pool4-for-solana.md, "A release gate").
#
#   programs/buy-wall-amm/scripts/deploy.sh --url <devnet|http://127.0.0.1:PORT> --so <buy_wall_amm.so> \
#     [--program-id ~/.config/testing-pipeline/devnet/buy-wall-amm.json] \
#     [--upgrade-authority ~/.config/testing-pipeline/devnet/upgrade-authority.json] \
#     [--payer ~/.config/testing-pipeline/devnet/wallet.json] [--records <dir>]
#
# Before it sends anything it asks `buy-wall-gate verify-record` whether a passing gate run
# covers this exact build (its executable hash) on this cluster, against the build deployed
# there now and covering every market there now, and stops if not; run the gate first:
#
#   cd programs && cargo run -p buy-wall-gate -- run --cluster <...> --candidate <buy_wall_amm.so>
#
# It refuses every cluster but devnet (by genesis hash) and a local validator, deploys a
# private copy of the file it checked, and stops unless the program on chain afterwards
# has the same hash. Needs the toolchain on PATH (source scripts/toolchain-env.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
KEYS="$HOME/.config/testing-pipeline/devnet"
DEVNET_GENESIS="EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"

url="" so="" records=""
program_id="$KEYS/buy-wall-amm.json"
upgrade_authority="$KEYS/upgrade-authority.json"
payer="$KEYS/wallet.json"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) url="$2" ;;
    --so) so="$2" ;;
    --program-id) program_id="$2" ;;
    --upgrade-authority) upgrade_authority="$2" ;;
    --payer) payer="$2" ;;
    --records) records="$2" ;;
    *) echo "deploy.sh: unexpected argument $1" >&2; exit 2 ;;
  esac
  shift 2
done
[ -n "$url" ] && [ -n "$so" ] || { echo "deploy.sh: --url and --so are required" >&2; exit 2; }
[ "$url" = devnet ] && url="https://api.devnet.solana.com"
so="$(cd "$(dirname "$so")" && pwd)/$(basename "$so")"
# What is printed: the URL without its path, query or user part, where an RPC key sits.
shown="$(printf '%s' "$url" | sed -E 's#^([a-z]+://)([^/@?#]*@)?([^/?#]*).*#\1\3#')"

# Devnet or a local validator only (CLAUDE.md: devnet only until Pipeline's router is on mainnet).
genesis="$(curl --silent --show-error --max-time 30 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' "$url" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"])')"
MAINNET_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
TESTNET_GENESIS="4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"
case "$url" in
  http://127.0.0.1:* | http://localhost:*)
    # A local port can be a tunnel or a proxy to a real cluster: only devnet's or a local
    # validator's own genesis will do.
    if [ "$genesis" = "$MAINNET_GENESIS" ] || [ "$genesis" = "$TESTNET_GENESIS" ]; then
      echo "deploy.sh: refused: $shown answers as mainnet or testnet (genesis $genesis)" >&2
      exit 1
    fi
    if [ "$genesis" = "$DEVNET_GENESIS" ]; then cluster="devnet"; else cluster="a local validator"; fi
    ;;
  *)
    if [ "$genesis" != "$DEVNET_GENESIS" ]; then
      echo "deploy.sh: refused: $shown is not devnet (genesis $genesis)" >&2
      exit 1
    fi
    cluster="devnet"
    ;;
esac

# The bytes checked are the bytes deployed: a private copy, so nothing can swap the file.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$so" "$work/buy_wall_amm.so"
candidate="$work/buy_wall_amm.so"

gate() { (cd "$ROOT/programs" && cargo run --quiet -p buy-wall-gate -- "$@"); }
hash="$(gate hash "$candidate")"
program="$(solana-keygen pubkey "$program_id" 2>/dev/null || echo "$program_id")"
echo "Deploying build $hash of $program to $cluster ($shown)."

verify=(verify-record --cluster "$url" --candidate "$candidate" --program "$program")
[ -n "$records" ] && verify+=(--records "$records")
if ! gate "${verify[@]}"; then
  echo "deploy.sh: refused: the release gate has not passed this build against $cluster." >&2
  exit 1
fi

# A buffer key of our own, so the CLI prints no recovery phrase; a failed deploy names the
# buffer, which the upgrade authority can close to recover its lamports.
solana-keygen new --no-bip39-passphrase --silent --outfile "$work/buffer.json" >/dev/null
buffer="$(solana-keygen pubkey "$work/buffer.json")"
if ! solana program deploy --url "$url" --keypair "$payer" --program-id "$program_id" \
  --upgrade-authority "$upgrade_authority" --buffer "$work/buffer.json" "$candidate"; then
  echo "deploy.sh: the deploy failed; close its buffer with: solana program close $buffer --url <the cluster> --keypair $upgrade_authority" >&2
  exit 1
fi

solana program dump --url "$url" "$program" "$work/deployed.so" >/dev/null
deployed="$(gate hash "$work/deployed.so")"
if [ "$deployed" != "$hash" ]; then
  echo "deploy.sh: the program on chain has hash $deployed, not the build's $hash" >&2
  exit 1
fi
echo "Deployed: $program on $cluster runs build $hash."
