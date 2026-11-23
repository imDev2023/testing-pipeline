#!/usr/bin/env bash
# Builds the two versions of Pipeline's test-strategy-cp that the strategy-versions demo deploys
# and upgrades on a local validator (#117; tests/terminal-e2e/demo/strategy-versions.ts):
#
#   v1.so  Pipeline's Apache-2.0 test-strategy-cp as it is, at the address of a fresh local keypair,
#          since its own address (devnet's constant product strategy) is not ours to deploy to;
#   v2.so  the same with one more instruction, `ping`, so the upgrade changes the code, its hash
#          and its instruction list.
#
#   tests/terminal-e2e/demo/build-test-strategy.sh <out dir>
#
# It copies Pipeline's clone in fixtures/pipeline (scripts/fetch-pipeline.sh fetches it) into
# <out dir>/pipeline, never changing the clone, and writes <out dir>/strategy-keypair.json,
# v1.so and v2.so. Needs the toolchain (source scripts/toolchain-env.sh). Nothing of it goes to devnet.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${1:?usage: build-test-strategy.sh <out dir>}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
CLONE="$ROOT/fixtures/pipeline"
[ -d "$CLONE/programs/test-strategy-cp" ] || { echo "No Pipeline clone in $CLONE: run scripts/fetch-pipeline.sh first." >&2; exit 1; }

rsync -a --delete --exclude target --exclude .git --exclude node_modules "$CLONE/" "$OUT/pipeline/"
[ -f "$OUT/strategy-keypair.json" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$OUT/strategy-keypair.json"
ID="$(solana-keygen pubkey "$OUT/strategy-keypair.json")"
LIB="$OUT/pipeline/programs/test-strategy-cp/src/lib.rs"
sed -i.orig "s/^declare_id!(\"[1-9A-HJ-NP-Za-km-z]*\");$/declare_id!(\"$ID\");/" "$LIB"
grep -q "declare_id!(\"$ID\")" "$LIB" || { echo "Could not set the program's address in $LIB" >&2; exit 1; }

build() {
  CARGO_TARGET_DIR="$OUT/target" cargo build-sbf --manifest-path "$OUT/pipeline/programs/test-strategy-cp/Cargo.toml" >"$OUT/build-$1.log" 2>&1 \
    || { tail -30 "$OUT/build-$1.log" >&2; exit 1; }
  cp "$OUT/target/deploy/test_strategy_cp.so" "$OUT/$1.so"
}
build v1

# v2: one more instruction, inside the program module and with its accounts at the end of the file.
python3 - "$LIB" <<'PY'
import sys
path = sys.argv[1]
source = open(path).read()
anchor = "pub mod test_strategy_cp {\n    use super::*;\n"
assert anchor in source, "the program module moved"
source = source.replace(anchor, anchor + "\n    /// Added by Aviary's strategy-versions demo, so the upgrade compiles in one more instruction.\n    pub fn ping(_ctx: Context<Ping>) -> Result<()> {\n        Ok(())\n    }\n", 1)
source += "\n#[derive(Accounts)]\npub struct Ping {}\n"
open(path, "w").write(source)
PY
build v2
echo "test-strategy-cp at $ID: $OUT/v1.so, $OUT/v2.so"
