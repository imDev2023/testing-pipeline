#!/usr/bin/env bash
# Installs the two review skills of the engineering and security bar ("Internal adversarial
# review") into .claude/, from MetalLegBob's MIT-licensed Solana Vibes Kit at a pinned commit:
#
#   Stronghold of Security  .claude/skills/stronghold-of-security, commands /SOS:*
#   Book of Knowledge       .claude/skills/book-of-knowledge, commands /BOK:*
#
#   scripts/install-review-skills.sh
#
# It copies what each skill's own install.sh copies (SKILL.md, agents, resources, templates,
# Stronghold's knowledge base without its archive, and the commands) without running any of
# the kit's code, and leaves out the .claude/svk-meta.json those installers write, so the
# skills skip their update check, as a pinned copy should. Each skill gets the kit's licence
# and a note of where it came from. To move the pin, change SVK_COMMIT, run this again and
# commit the result in a PR of its own. Safe to run again: it replaces both skills.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVK_REPO=https://github.com/MetalLegBob/solana-vibes-kit.git
SVK_COMMIT=969c43d1f7599684677559179de6803352c951e7   # newest on 2026-11-10 (committed 2026-02-25)

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git clone --quiet "$SVK_REPO" "$work/svk"
git -C "$work/svk" -c advice.detachedHead=false checkout --quiet --detach "$SVK_COMMIT"

# install_skill <skill directory> <command namespace> <parts to copy...>
install_skill() {
  local skill="$1" commands="$2"
  shift 2
  local from="$work/svk/$skill" to="$ROOT/.claude/skills/$skill"
  rm -rf "$to" "$ROOT/.claude/commands/$commands"
  mkdir -p "$to" "$ROOT/.claude/commands/$commands"
  for part in "$@"; do
    cp -R "$from/$part" "$to/"
  done
  cp "$from/commands/"*.md "$ROOT/.claude/commands/$commands/"
  cp "$work/svk/LICENSE" "$to/LICENSE"
  cat > "$to/PROVENANCE.md" <<EOF
# Provenance

Copied by \`scripts/install-review-skills.sh\` from [MetalLegBob/solana-vibes-kit](https://github.com/MetalLegBob/solana-vibes-kit) at commit \`$SVK_COMMIT\`, under the MIT licence in \`LICENSE\` beside this file.
Its commands are in \`.claude/commands/$commands/\`.
Change the pin only through that script, in a pull request of its own.
EOF
  echo "$skill at ${SVK_COMMIT:0:7}"
}

install_skill stronghold-of-security SOS SKILL.md agents resources templates knowledge-base
rm -rf "$ROOT/.claude/skills/stronghold-of-security/knowledge-base/core/archive"
install_skill book-of-knowledge BOK SKILL.md agents resources templates
