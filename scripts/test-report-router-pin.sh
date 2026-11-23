#!/usr/bin/env bash
# Tests scripts/report-router-pin.sh without the network: a stand-in `gh` first on PATH
# records what it is asked and answers `issue list` with whatever FAKE_OPEN_ISSUES holds.
#
#   scripts/test-report-router-pin.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT="$ROOT/scripts/report-router-pin.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Stand-in for `gh issue list|create|comment`: logs each call's arguments, one per line,
# then a separator, and prints FAKE_OPEN_ISSUES for `issue list` (after its --jq filter,
# which the test applies itself with jq so the filter is exercised too).
log="$(dirname "$0")/../calls"
printf '%s\n' "$@" >> "$log"
echo "--" >> "$log"
case "$1 $2" in
  "issue list")
    filter=""
    prev=""
    for arg in "$@"; do [ "$prev" = --jq ] && filter="$arg"; prev="$arg"; done
    printf '%s' "${FAKE_OPEN_ISSUES:-[]}" | jq -r "$filter"
    ;;
  "issue create") echo "https://github.com/owner/repo/issues/999" ;;
  "issue comment") echo "https://github.com/owner/repo/issues/77#issuecomment-1" ;;
  *) echo "unexpected: gh $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$work/bin/gh"
printf 'Refusing the router dumped from devnet: its SHA-256 is\n  abc\n' > "$work/fetch.log"

failures=0
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }
TITLE="Devnet's Pipeline router no longer matches the pin"

run_report() {
  : > "$work/calls"
  PATH="$work/bin:$PATH" GITHUB_REPOSITORY=owner/repo FAKE_OPEN_ISSUES="$1" \
    "$REPORT" "$work/fetch.log" "https://github.com/owner/repo/actions/runs/1" > "$work/out.log" 2>&1
}

# 1. No issue open: one is created, titled as the check names it, carrying the fetch log and
# the run's link.
if ! run_report '[]'; then
  fail "the report failed with no issue open: $(cat "$work/out.log")"
elif ! grep -qx "create" "$work/calls" || grep -qx "comment" "$work/calls"; then
  fail "with no issue open it did not create exactly one: $(cat "$work/calls")"
elif ! grep -qxF "$TITLE" "$work/calls"; then
  fail "the new issue is not titled \"$TITLE\""
elif ! grep -q "its SHA-256 is" "$work/calls" || ! grep -q "actions/runs/1" "$work/calls"; then
  fail "the new issue does not carry the fetch log and the run's link"
else
  pass "with no issue open, one is created with the fetch log and the run's link"
fi

# 2. The issue already open: it is commented on, and no second issue is created.
if ! run_report "[{\"number\":77,\"title\":\"$TITLE\"}]"; then
  fail "the report failed with the issue open: $(cat "$work/out.log")"
elif grep -qx "create" "$work/calls"; then
  fail "a second issue was created while one was open"
elif ! grep -qx "comment" "$work/calls" || ! grep -qx "77" "$work/calls"; then
  fail "the open issue #77 was not commented on: $(cat "$work/calls")"
else
  pass "with the issue open, it is commented on and no second issue is created"
fi

# 3. Search finds only an issue whose title merely contains the words: a new one is created.
if ! run_report "[{\"number\":5,\"title\":\"Re: $TITLE, or not\"}]"; then
  fail "the report failed: $(cat "$work/out.log")"
elif ! grep -qx "create" "$work/calls" || grep -qx "comment" "$work/calls"; then
  fail "an issue with a different title was taken for the open one: $(cat "$work/calls")"
else
  pass "only an issue with exactly the title counts as the open one"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures failed" >&2
  exit 1
fi
echo "all passed"
