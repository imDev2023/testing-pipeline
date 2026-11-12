#!/usr/bin/env bash
# Tests scripts/fetch-router.sh without the network: a stand-in `solana` first on PATH
# writes chosen bytes where the devnet dump would go, and a temporary fixtures folder holds
# its own pins.
#
#   scripts/test-fetch-router.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FETCH="$ROOT/scripts/fetch-router.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat > "$work/bin/solana" <<'EOF'
#!/usr/bin/env bash
# Stand-in for `solana program dump ... <out>` and `solana account ... --output-file <out>`.
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = --output-file ]; then out="$arg"; fi
  prev="$arg"
done
echo "$1" >> "$(dirname "$0")/../calls"
# FAKE_FAILURES=<file>: fail (as a flaky RPC does) while the file holds a number above 0.
if [ -n "${FAKE_FAILURES:-}" ] && [ "$(cat "$FAKE_FAILURES")" -gt 0 ]; then
  echo $(($(cat "$FAKE_FAILURES") - 1)) > "$FAKE_FAILURES"
  echo "Error: AccountNotFound: error decoding response body" >&2
  exit 1
fi
case "$1" in
  program) printf '%s' "$FAKE_ROUTER_BYTES" > "${@: -1}" ;;
  account) printf '{"pubkey":"config","account":{}}' > "$out" ;;
  *) echo "unexpected: solana $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$work/bin/solana"

sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }

# A fixtures folder whose pin is the hash of "the pinned router".
fixtures="$work/fixtures"
mkdir -p "$fixtures"
printf 'the pinned router' > "$work/pinned.so"
cat > "$fixtures/pins.env" <<EOF
ROUTER_PROGRAM=PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34
ROUTER_CONFIG=BmdeX3kWjQavcjggCd1YDws67szz7iqcJRa1KebtRQZ8
ROUTER_SHA256=$(sha256 "$work/pinned.so")
EOF

run_fetch() {
  PATH="$work/bin:$PATH" FIXTURES_DIR="$fixtures" FAKE_ROUTER_BYTES="$1" \
    FETCH_RETRY_DELAY=0 "$FETCH" > "$work/out.log" 2>&1
}

# 1. A dump that differs from the pin is refused, and nothing is written.
if run_fetch 'an upgraded router'; then
  fail "a dump with another hash was accepted"
elif [ -e "$fixtures/router/pipeline.so" ]; then
  fail "a refused dump was written to the fixtures"
elif ! grep -q "Refusing" "$work/out.log"; then
  fail "the refusal does not say why: $(cat "$work/out.log")"
else
  pass "a dump whose hash differs from the pin is refused and not written"
fi

# 2. A dump that matches the pin is written, with the router's config account beside it.
if ! run_fetch 'the pinned router'; then
  fail "a dump matching the pin was refused: $(cat "$work/out.log")"
elif ! cmp -s "$fixtures/router/pipeline.so" "$work/pinned.so"; then
  fail "the written router is not the dump"
elif [ ! -s "$fixtures/router/config.json" ]; then
  fail "the router's config account was not written"
else
  pass "a dump matching the pin is written with the config account"
fi

# 3. Once the router is upgraded on devnet, the pinned fixture already in place is kept.
if run_fetch 'an upgraded router'; then
  fail "a dump with another hash was accepted over a pinned fixture"
elif ! cmp -s "$fixtures/router/pipeline.so" "$work/pinned.so"; then
  fail "a refused dump replaced the pinned fixture"
else
  pass "a refused dump leaves the pinned fixture in place"
fi

# 4. A fixture in place that no longer matches the pin is not trusted.
printf 'tampered' > "$fixtures/router/pipeline.so"
if run_fetch 'an upgraded router'; then
  fail "a run left a fixture that does not match the pin"
elif [ -e "$fixtures/router/pipeline.so" ]; then
  fail "a fixture that does not match the pin was left in place"
else
  pass "a fixture that does not match the pin is removed"
fi

# 5. A flaky RPC is retried: two failed downloads, then the pinned bytes.
rm -rf "$fixtures/router"
echo 2 > "$work/failures"
if ! FAKE_FAILURES="$work/failures" run_fetch 'the pinned router'; then
  fail "two transient failures were not retried: $(cat "$work/out.log")"
elif ! cmp -s "$fixtures/router/pipeline.so" "$work/pinned.so"; then
  fail "the router was not written after the retries"
else
  pass "transient download failures are retried"
fi

# 6. A hash mismatch is not retried: the stand-in is called once.
echo 0 > "$work/failures"
dumps_before="$(grep -c "^program" "$work/calls")"
if run_fetch 'an upgraded router'; then
  fail "a dump with another hash was accepted"
elif [ "$(grep -c "^program" "$work/calls")" -ne "$((dumps_before + 1))" ]; then
  fail "a hash mismatch was retried"
else
  pass "a hash mismatch fails without retrying"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures failed" >&2
  exit 1
fi
echo "all passed"
