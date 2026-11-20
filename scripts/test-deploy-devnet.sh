#!/usr/bin/env bash
# Tests scripts/deploy-devnet.sh without the network or Docker: a small git repo stands in for
# this one (a one-program workspace, its pins, and an `origin` whose main it can be on or not),
# and stand-ins for `solana`, `solana-keygen` and `solana-verify` first on PATH answer as the
# cluster and the Docker build would, logging every call.
#
#   scripts/test-deploy-devnet.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$ROOT/scripts/deploy-devnet.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

PROGRAM_ID=Toy1111111111111111111111111111111111111111
AUTHORITY=Auth111111111111111111111111111111111111111
WALLET=Wa11et1111111111111111111111111111111111111
HASH=1111111111111111111111111111111111111111111111111111111111111111
IMAGE=solanafoundation/solana-verifiable-build@sha256:2222222222222222222222222222222222222222222222222222222222222222
DEVNET_GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
MAINNET_GENESIS=5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d

# Stand-ins. Each logs its arguments to $work/calls; FAKE_* variables choose the answers.
mkdir -p "$work/bin" "$work/keys"
cat > "$work/bin/solana" <<'EOF'
#!/usr/bin/env bash
echo "solana $*" >> "$WORK/calls"
case "$1 $2" in
  "genesis-hash "*) echo "${FAKE_GENESIS}" ;;
  "program show")
    if [ -f "$WORK/deployed" ]; then
      printf '{"programId":"%s","authority":"%s","lastDeploySlot":4242,"dataLen":7}\n' "$3" "${FAKE_AUTHORITY_AFTER}"
    else
      echo "Error: Unable to find the account $3" >&2; exit 1
    fi ;;
  "program deploy") touch "$WORK/deployed"; echo "Program Id: $PROGRAM_ID"; echo "Signature: FakeSig" ;;
  *) echo "unexpected: solana $*" >&2; exit 2 ;;
esac
EOF
cat > "$work/bin/solana-keygen" <<'EOF'
#!/usr/bin/env bash
# `solana-keygen pubkey <file>`: the address written in the stand-in key file.
echo "solana-keygen $*" >> "$WORK/calls"
cat "$2"
EOF
cat > "$work/bin/solana-verify" <<'EOF'
#!/usr/bin/env bash
echo "solana-verify $*" >> "$WORK/calls"
case "$1" in
  --version) echo "solana-verify ${FAKE_VERIFY_VERSION}" ;;
  build)
    # Writes the program where the Docker build would: <mount>/target/deploy/<lib>.so
    mount="$2"; lib=""; prev=""
    for arg in "$@"; do [ "$prev" = --library-name ] && lib="$arg"; prev="$arg"; done
    mkdir -p "$mount/target/deploy" && printf 'bytes' > "$mount/target/deploy/$lib.so"
    # What the build saw, so the test can check it built the commit and not the worktree.
    cp "$mount/toy/src/lib.rs" "$WORK/built-lib.rs" ;;
  get-executable-hash) echo "$FAKE_HASH" ;;
  get-program-hash) echo "${FAKE_PROGRAM_HASH}" ;;
  *) echo "unexpected: solana-verify $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$work/bin/"*
echo "$PROGRAM_ID" > "$work/keys/toy.json"
echo "$AUTHORITY" > "$work/keys/upgrade-authority.json"
echo "$WALLET" > "$work/keys/wallet.json"

# The stand-in repo: a one-program workspace with this repo's helper, and an origin.
repo="$work/repo"
mkdir -p "$repo/programs/toy/src" "$repo/scripts" "$repo/fixtures" "$repo/deployments"
cp "$ROOT/scripts/workspace-programs.py" "$repo/scripts/"
cat > "$repo/programs/Cargo.toml" <<'EOF'
[workspace]
members = ["toy"]
[workspace.metadata.cli]
solana = "4.3.0"
EOF
cat > "$repo/programs/toy/Cargo.toml" <<'EOF'
[package]
name = "toy"
[lib]
crate-type = ["cdylib", "lib"]
EOF
echo "declare_id!(\"$PROGRAM_ID\");" > "$repo/programs/toy/src/lib.rs"
cat > "$repo/fixtures/pins.env" <<EOF
VERIFY_SOLANA_VERSION=4.3.0
VERIFY_IMAGE=$IMAGE
EOF
git -C "$repo" init -q -b main
git -C "$repo" -c user.name=t -c user.email=t@t add -A
git -C "$repo" -c user.name=t -c user.email=t@t commit -q -m one
git init -q --bare "$work/origin.git"
git -C "$repo" remote add origin "$work/origin.git"
git -C "$repo" push -q origin main

run() {
  : > "$work/calls"
  rm -f "$work/deployed"
  env WORK="$work" PROGRAM_ID="$PROGRAM_ID" PATH="$work/bin:$PATH" \
    TESTING_PIPELINE_ROOT="$repo" KEYS_DIR="$work/keys" DEPLOY_CHECK_TRIES=2 \
    FAKE_GENESIS="${FAKE_GENESIS:-$DEVNET_GENESIS}" FAKE_HASH="$HASH" \
    FAKE_PROGRAM_HASH="${FAKE_PROGRAM_HASH:-$HASH}" FAKE_AUTHORITY_AFTER="${FAKE_AUTHORITY_AFTER:-$AUTHORITY}" \
    FAKE_VERIFY_VERSION="${FAKE_VERIFY_VERSION:-0.5.2}" \
    bash "$DEPLOY" "$@" > "$work/out" 2>&1
}
# expect_refused <what> <pattern in the output> <deploy-devnet.sh arguments...>: exits non-zero,
# says why, and sends no deploy. ALREADY_DEPLOYED=1 is for the checks made after the deploy.
expect_refused() {
  local what="$1" pattern="$2"
  shift 2
  if run "$@"; then
    fail "$what: exited 0"
  elif ! grep -q -- "$pattern" "$work/out"; then
    fail "$what: no \"$pattern\" in: $(cat "$work/out")"
  elif [ -z "${ALREADY_DEPLOYED:-}" ] && grep -q "program deploy" "$work/calls"; then
    fail "$what: deployed anyway"
  else
    pass "$what"
  fi
}

# Refusals before anything is built or sent.
expect_refused "an unknown program" "not a deployable program" nope
expect_refused "no program" "Usage" ""
expect_refused "a mainnet URL" "devnet or a local validator" toy --url https://api.mainnet-beta.solana.com
FAKE_GENESIS=$MAINNET_GENESIS expect_refused "an RPC whose genesis is mainnet's" "not devnet" toy --url https://rpc.example.com
FAKE_VERIFY_VERSION=0.4.9 expect_refused "solana-verify older than 0.5.2" "0.5.2 or later" toy

# The commit: clean, and on origin's main.
echo "// edited" >> "$repo/programs/toy/src/lib.rs"
expect_refused "a worktree with changes" "uncommitted" toy
git -C "$repo" checkout -q -- programs
git -C "$repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m "not on main"
expect_refused "a commit not on origin's main" "not on origin/main" toy
git -C "$repo" reset -q --hard origin/main

# The image the pins name must be for the Solana version the workspace pins.
sed -i.bak 's/^VERIFY_SOLANA_VERSION=.*/VERIFY_SOLANA_VERSION=4.4.0/' "$repo/fixtures/pins.env"
rm "$repo/fixtures/pins.env.bak"
git -C "$repo" -c user.name=t -c user.email=t@t commit -q -am "other image" && git -C "$repo" push -q origin main
expect_refused "an image pinned for another Solana version" "4.4.0" toy
sed -i.bak 's/^VERIFY_SOLANA_VERSION=.*/VERIFY_SOLANA_VERSION=4.3.0/' "$repo/fixtures/pins.env"
rm "$repo/fixtures/pins.env.bak"
git -C "$repo" -c user.name=t -c user.email=t@t commit -q -am "the image again" && git -C "$repo" push -q origin main
commit="$(git -C "$repo" rev-parse HEAD)"

# --build-only: builds the commit in Docker with the pinned image and prints its hash.
if run toy --build-only && grep -q "$HASH" "$work/out" && ! grep -q "program deploy" "$work/calls" \
  && grep -q -- "--library-name toy --arch v3 --base-image $IMAGE" "$work/calls"; then
  pass "--build-only builds with the pinned image and --arch v3, and sends nothing"
else
  fail "--build-only: $(cat "$work/out") / $(cat "$work/calls")"
fi

# --out keeps the built program, so the tests can run on the very bytes that are deployed.
if run toy --build-only --out "$work/built" && [ "$(cat "$work/built/toy.so")" = bytes ]; then
  pass "--out keeps the built program"
else
  fail "--out: $(cat "$work/out")"
fi

# A deploy: paid by the wallet, under the upgrade authority, then checked and recorded.
if run toy; then
  deploy_call="$(grep "program deploy" "$work/calls")"
  if [[ "$deploy_call" == *"-k $work/keys/wallet.json"* && "$deploy_call" == *"--program-id $work/keys/toy.json"* \
    && "$deploy_call" == *"--upgrade-authority $work/keys/upgrade-authority.json"* ]]; then
    pass "deploys paid by wallet.json with upgrade-authority.json as the upgrade authority"
  else
    fail "deploy call: $deploy_call"
  fi
  # Public devnet drops write transactions under load: the deploy re-signs and resends them
  # many times, and pays a small priority fee so they land.
  if [[ "$deploy_call" == *"--max-sign-attempts 50"* && "$deploy_call" == *"--with-compute-unit-price 10000"* ]]; then
    pass "a devnet deploy resends dropped writes and pays a priority fee"
  else
    fail "deploy call without retries or a priority fee: $deploy_call"
  fi
  record="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["programs"]["toy"], sort_keys=True))' "$repo/deployments/devnet.json")"
  for want in "\"programId\": \"$PROGRAM_ID\"" "\"executableHash\": \"$HASH\"" "\"commit\": \"$commit\"" \
    "\"dockerImage\": \"$IMAGE\"" "\"upgradeAuthority\": \"$AUTHORITY\"" "\"deployedBy\": \"$WALLET\"" "\"slot\": 4242"; do
    [[ "$record" == *"$want"* ]] || fail "record lacks $want: $record"
  done
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["cluster"] == "devnet"' "$repo/deployments/devnet.json" \
    || fail "record's cluster"
  pass "records the program id, hash, commit, image, authority, payer and slot in deployments/devnet.json"
else
  fail "deploy: $(cat "$work/out")"
fi
# The build is of the commit, not of whatever the worktree holds (here they agree).
cmp -s "$work/built-lib.rs" "$repo/programs/toy/src/lib.rs" || fail "the build saw other sources"

# The next deploy (an upgrade, or another program) runs with that record not yet merged: the
# record alone does not count as a change, and the earlier deploy moves into `history`.
git -C "$repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m "two" && git -C "$repo" push -q origin main
second="$(git -C "$repo" rev-parse HEAD)"
if run toy; then
  python3 - "$repo/deployments/devnet.json" "$commit" "$second" <<'PY' && pass "a second deploy records its commit and keeps the first in history" || fail "history: $(cat "$repo/deployments/devnet.json")"
import json, sys
entry = json.load(open(sys.argv[1]))["programs"]["toy"]
assert entry["commit"] == sys.argv[3], entry
assert [h["commit"] for h in entry["history"]] == [sys.argv[2]], entry
assert "history" not in entry["history"][0], entry
PY
else
  fail "a second deploy with the first record uncommitted: $(cat "$work/out")"
fi

# After the deploy: the cluster's hash and the upgrade authority must be what was built and meant.
git -C "$repo" checkout -q -- deployments 2>/dev/null || rm -f "$repo/deployments/devnet.json"
ALREADY_DEPLOYED=1 FAKE_PROGRAM_HASH=3333 expect_refused "an on-chain hash other than the build's" "does not match" toy
ALREADY_DEPLOYED=1 FAKE_AUTHORITY_AFTER=$WALLET expect_refused "an upgrade authority other than upgrade-authority.json" "not upgrade-authority.json's" toy
[ ! -f "$repo/deployments/devnet.json" ] || fail "a failed check still wrote the record"

# A local validator: no main or genesis checks needed, and the record goes where --record says.
echo "// local" >> "$repo/programs/toy/src/lib.rs"
git -C "$repo" -c user.name=t -c user.email=t@t commit -q -am "local only"
if run toy --url http://127.0.0.1:8999 --record "$work/local.json" && [ -f "$work/local.json" ] \
  && [ ! -f "$repo/deployments/devnet.json" ]; then
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["cluster"] == "http://127.0.0.1:8999"' "$work/local.json" \
    || fail "a local record names its cluster"
  pass "a local validator deploys a commit not on main and records it where --record says"
else
  fail "local: $(cat "$work/out")"
fi
expect_refused "a local deploy without --record" "--record" toy --url http://127.0.0.1:8999

if [ "$failures" -gt 0 ]; then
  echo "$failures failed" >&2
  exit 1
fi
echo "all passed"
