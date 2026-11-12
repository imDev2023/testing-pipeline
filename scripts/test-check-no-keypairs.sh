#!/usr/bin/env bash
# Tests scripts/check-no-keypairs.sh in throwaway git repositories.
#
#   scripts/test-check-no-keypairs.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/scripts/check-no-keypairs.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

# A fresh repository with one commit holding `files` (name=content pairs), and `staged`
# files added but not committed.
repo() {
  local dir="$work/$1"
  rm -rf "$dir" && mkdir -p "$dir"
  git -C "$dir" init --quiet
  git -C "$dir" config user.email test@example.com
  git -C "$dir" config user.name test
  git -C "$dir" commit --quiet --allow-empty -m init
  echo "$dir"
}
check() { (cd "$1" && "$CHECK") > "$work/out.log" 2>&1; }

# solana-keygen's format: a JSON array of 64 numbers from 0 to 255.
keypair="[$(python3 -c 'import os; print(",".join(str(b) for b in os.urandom(64)))')]"

dir="$(repo clean)"
echo '{"name": "metadata"}' > "$dir/metadata.json"
printf '[1, 2, 3]' > "$dir/short.json"
git -C "$dir" add . && git -C "$dir" commit --quiet -m files
if check "$dir"; then pass "a repository without keypairs passes"; else fail "a clean repository was refused: $(cat "$work/out.log")"; fi

dir="$(repo committed)"
mkdir -p "$dir/deep/er"
printf '%s' "$keypair" > "$dir/deep/er/program.json"
git -C "$dir" add . && git -C "$dir" commit --quiet -m key
if check "$dir"; then
  fail "a committed keypair was not refused"
elif ! grep -q "deep/er/program.json" "$work/out.log"; then
  fail "the refusal does not name the file: $(cat "$work/out.log")"
else
  pass "a committed keypair is refused by name"
fi

dir="$(repo staged)"
printf '%s' "$keypair" > "$dir/wallet.json"
git -C "$dir" add wallet.json
if check "$dir"; then fail "a staged keypair was not refused"; else pass "a staged keypair is refused"; fi

dir="$(repo emptied)"
printf '%s' "$keypair" > "$dir/wallet.json"
git -C "$dir" add wallet.json
: > "$dir/wallet.json"
if check "$dir"; then fail "a staged keypair whose file was emptied afterwards was not refused"; else pass "the staged content is checked, not only the file on disk"; fi

dir="$(repo pretty)"
python3 -c 'import json, os; print(json.dumps(list(os.urandom(64)), indent=2))' > "$dir/key.txt"
git -C "$dir" add key.txt && git -C "$dir" commit --quiet -m key
if check "$dir"; then fail "a keypair in a file not named .json was not refused"; else pass "a keypair is refused whatever the file is called"; fi

dir="$(repo untracked)"
printf '%s' "$keypair" > "$dir/ignored.json"
if check "$dir"; then pass "an untracked keypair is not the repository's concern"; else fail "an untracked file was refused"; fi

if [ "$failures" -gt 0 ]; then
  echo "$failures failed" >&2
  exit 1
fi
echo "all passed"
