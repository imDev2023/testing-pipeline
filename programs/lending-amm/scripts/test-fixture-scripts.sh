#!/usr/bin/env bash
# Tests the lending AMM's Kamino fixture scripts without the network:
#
#   - fetch-klend.sh, with a stand-in `solana` first on PATH that writes chosen bytes where
#     each cluster's dump would go, and a temporary fixtures folder holding its own pins: a
#     dump whose hash differs from the pin is refused, not written, and keeps the pinned copy;
#     one that matches is written; a copy in place that no longer matches is removed; a flaky
#     download is retried, a hash mismatch is not; KLEND_ACCEPT_ANY_HASH writes and names it;
#   - kamino_accounts.py check, against the committed dump itself (it matches) and against
#     copies with one part of the layout changed (each is reported, and the check fails).
#
#   bash programs/lending-amm/scripts/test-fixture-scripts.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FETCH="$HERE/fetch-klend.sh"
ACCOUNTS="$HERE/kamino_accounts.py"
COMMITTED="$HERE/../tests/fixtures/kamino"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat > "$work/bin/solana" <<'STUB'
#!/usr/bin/env bash
# Stand-in for `solana program dump --url <cluster> <program> <out>`.
echo "$*" >> "$(dirname "$0")/../calls"
# FAKE_DOWN=<cluster>: that cluster's RPC never answers.
if [ -n "${FAKE_DOWN:-}" ] && [ "$4" = "$FAKE_DOWN" ]; then
  echo "Error: connection refused" >&2
  exit 1
fi
if [ -n "${FAKE_FAILURES:-}" ] && [ "$(cat "$FAKE_FAILURES")" -gt 0 ]; then
  echo $(($(cat "$FAKE_FAILURES") - 1)) > "$FAKE_FAILURES"
  echo "Error: error decoding response body" >&2
  exit 1
fi
case "$4" in
  mainnet-beta) printf '%s' "$FAKE_MAINNET_BYTES" > "${@: -1}" ;;
  devnet) printf '%s' "$FAKE_DEVNET_BYTES" > "${@: -1}" ;;
  *) echo "unexpected: solana $*" >&2; exit 2 ;;
esac
STUB
chmod +x "$work/bin/solana"
touch "$work/calls"

sha256() { printf '%s' "$1" | shasum -a 256 | awk '{print $1}'; }
failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

fixtures="$work/fixtures"
mkdir -p "$fixtures"
cat > "$fixtures/pins.env" <<PINS
KLEND_PROGRAM=the-stand-in-klend-program
KLEND_MAINNET_SHA256=$(sha256 'pinned mainnet klend')
KLEND_DEVNET_SHA256=$(sha256 'pinned devnet klend')
PINS

run_fetch() {
  PATH="$work/bin:$PATH" FIXTURES_DIR="$fixtures" FAKE_MAINNET_BYTES="$1" FAKE_DEVNET_BYTES="$2" \
    FETCH_RETRY_DELAY=0 bash "$FETCH" "${@:3}" > "$work/out.log" 2>&1
}
holds() { [ -f "$fixtures/klend/$1.so" ] && [ "$(cat "$fixtures/klend/$1.so")" = "$2" ]; }

# 1. Both match their pins: both are written.
if run_fetch 'pinned mainnet klend' 'pinned devnet klend' && holds mainnet 'pinned mainnet klend' && holds devnet 'pinned devnet klend'; then
  pass "dumps matching their pins are written, for both clusters"
else
  fail "dumps matching their pins were not written: $(cat "$work/out.log")"
fi

# 2. Kamino upgrades mainnet's klend: refused, says how to re-pin, keeps the pinned copy, and
# still writes devnet's.
rm -f "$fixtures/klend/devnet.so"
if run_fetch 'upgraded mainnet klend' 'pinned devnet klend'; then
  fail "a mainnet dump with another hash was accepted"
elif ! holds mainnet 'pinned mainnet klend'; then
  fail "a refused dump replaced the pinned mainnet copy"
elif ! holds devnet 'pinned devnet klend'; then
  fail "devnet's matching dump was not written beside mainnet's refusal"
elif ! grep -q "Refusing klend dumped from mainnet" "$work/out.log" || ! grep -q "re-pin deliberately" "$work/out.log"; then
  fail "the refusal does not say why or how to re-pin: $(cat "$work/out.log")"
else
  pass "a dump whose hash differs is refused, keeps the pinned copy, and says how to re-pin"
fi

# 3. A copy in place that no longer matches the pin is removed.
printf 'tampered' > "$fixtures/klend/devnet.so"
if run_fetch 'pinned mainnet klend' 'upgraded devnet klend' devnet; then
  fail "a run accepted a devnet dump with another hash"
elif [ -e "$fixtures/klend/devnet.so" ]; then
  fail "a copy that does not match the pin was left in place"
else
  pass "a copy that does not match the pin is removed"
fi

# 4. A flaky RPC is retried; a hash mismatch is not.
echo 2 > "$work/failures"
if FAKE_FAILURES="$work/failures" run_fetch 'pinned mainnet klend' 'pinned devnet klend' devnet && holds devnet 'pinned devnet klend'; then
  pass "transient download failures are retried"
else
  fail "two transient failures were not retried: $(cat "$work/out.log")"
fi
before="$(grep -c devnet "$work/calls")"
run_fetch 'pinned mainnet klend' 'upgraded devnet klend' devnet || true
if [ "$(grep -c devnet "$work/calls")" -ne "$((before + 1))" ]; then
  fail "a hash mismatch was retried"
else
  pass "a hash mismatch fails without retrying"
fi

# 4a. A rate-limited RPC is outlasted (public devnet answered 429 to several downloads in a
# row during CI on 2026-11-20), and one that keeps failing stops after six tries, each wait
# twice the one before.
echo 5 > "$work/failures"
if FAKE_FAILURES="$work/failures" run_fetch 'pinned mainnet klend' 'pinned devnet klend' devnet && holds devnet 'pinned devnet klend'; then
  pass "five transient download failures in a row are outlasted"
else
  fail "five transient failures were not outlasted: $(cat "$work/out.log")"
fi
echo 100 > "$work/failures"
cat > "$work/bin/sleep" <<'STUB'
#!/usr/bin/env bash
echo "$1" >> "$(dirname "$0")/../sleeps"
STUB
chmod +x "$work/bin/sleep"
: > "$work/sleeps"
before="$(grep -c devnet "$work/calls")"
if PATH="$work/bin:$PATH" FIXTURES_DIR="$fixtures" FAKE_MAINNET_BYTES='pinned mainnet klend' \
  FAKE_DEVNET_BYTES='pinned devnet klend' FAKE_FAILURES="$work/failures" FETCH_RETRY_DELAY=3 \
  bash "$FETCH" devnet > "$work/out.log" 2>&1; then
  fail "a download that never succeeds was accepted"
elif [ "$(grep -c devnet "$work/calls")" -ne "$((before + 6))" ]; then
  fail "a failing download was tried $(($(grep -c devnet "$work/calls") - before)) times, not 6"
elif [ "$(tr '\n' ' ' < "$work/sleeps")" != "3 6 12 24 48 " ]; then
  fail "the waits between tries were $(tr '\n' ' ' < "$work/sleeps"), not 3 6 12 24 48"
else
  pass "a failing download stops after six tries, its waits doubling"
fi
rm "$work/bin/sleep"
echo 0 > "$work/failures"

# 4b. A cluster whose RPC never answers fails, after its retries, without stopping the
# other cluster's fetch.
rm -f "$fixtures/klend/devnet.so"
if FAKE_DOWN=mainnet-beta run_fetch 'pinned mainnet klend' 'pinned devnet klend'; then
  fail "a run with mainnet's RPC down succeeded"
elif ! holds devnet 'pinned devnet klend'; then
  fail "mainnet's RPC being down stopped devnet's fetch: $(cat "$work/out.log")"
elif ! grep -q "Could not download klend from mainnet" "$work/out.log"; then
  fail "the failed download does not say so: $(cat "$work/out.log")"
else
  pass "a cluster whose RPC is down fails without stopping the other's fetch"
fi

# 5. Re-pinning deliberately: KLEND_ACCEPT_ANY_HASH writes the new bytes and prints their hash.
if KLEND_ACCEPT_ANY_HASH=1 run_fetch 'pinned mainnet klend' 'upgraded devnet klend' devnet \
  && holds devnet 'upgraded devnet klend' && grep -q "$(sha256 'upgraded devnet klend')" "$work/out.log"; then
  pass "KLEND_ACCEPT_ANY_HASH writes new bytes and prints the hash to pin"
else
  fail "KLEND_ACCEPT_ANY_HASH did not write and name the new bytes: $(cat "$work/out.log")"
fi

# 6. kamino_accounts.py check: the committed dump matches itself, for both clusters.
for cluster in mainnet devnet; do
  if python3 "$ACCOUNTS" check --cluster "$cluster" --fresh "$COMMITTED/$cluster" > "$work/check.log" 2>&1; then
    pass "the committed $cluster dump matches its own layout"
  else
    fail "the committed $cluster dump does not match itself: $(cat "$work/check.log")"
  fi
done

# 7. ...and each changed part of the layout is reported.
tamper() {
  # tamper <label> <python expression on `data`, a bytearray> <expected text>
  local copy="$work/tampered"
  rm -rf "$copy"; cp -R "$COMMITTED/mainnet" "$copy"
  python3 - "$copy/$1.json" "$2" <<'PY'
import base64, json, sys
path, change = sys.argv[1], sys.argv[2]
record = json.load(open(path))
data = bytearray(base64.b64decode(record["account"]["data"][0]))
exec(change)
record["account"]["data"][0] = base64.b64encode(bytes(data)).decode()
json.dump(record, open(path, "w"))
PY
  if python3 "$ACCOUNTS" check --cluster mainnet --fresh "$copy" > "$work/check.log" 2>&1; then
    fail "a dump with $1 changed ($2) passed the check"
  elif ! grep -q "$3" "$work/check.log"; then
    fail "the check did not name $3: $(cat "$work/check.log")"
  else
    pass "a changed $3 on $1 fails the check"
  fi
}
tamper reserve-usdc 'data.append(0)' "size"
tamper reserve-usdc 'data[0] ^= 1' "discriminator"
tamper reserve-sol 'data[32] ^= 1' "lending_market"
tamper reserve-sol 'data[2560] ^= 1' "collateral_mint"
tamper liquidity-supply-usdc 'data[40] ^= 1' "token_owner"
# The lending market's owner is the 32 bytes after its version and bump, at offset 24.
tamper lending-market 'data[55] ^= 1' "lending_market_owner"

if [ "$failures" -gt 0 ]; then
  echo "$failures failed" >&2
  exit 1
fi
echo "all passed"
