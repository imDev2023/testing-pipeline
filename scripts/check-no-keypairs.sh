#!/usr/bin/env bash
# Fails if any tracked or staged file holds a Solana keypair in solana-keygen's format: a
# JSON array of 64 numbers from 0 to 255, whatever the file is called. It reads both the
# content staged in the index, which is what a commit records, and the file on disk. Run by
# CI on every pull request (docs/spec/README.md, "CI"). Keys live in
# ~/.config/testing-pipeline/devnet/.
#
#   scripts/check-no-keypairs.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

{ git ls-files -z; git diff --cached --name-only -z --diff-filter=ACMR; } | python3 -c '
import json, os, subprocess, sys

MAX = 4096  # a keypair file is under 300 bytes, even pretty-printed

def is_keypair(raw):
    if raw is None or len(raw) > MAX:
        return False
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return False
    return (isinstance(data, list) and len(data) == 64
            and all(type(b) is int and 0 <= b <= 255 for b in data))

def staged_blobs(names):
    """The content each name has in the index, read through one git cat-file process."""
    request = "".join(f":{name}\n" for name in names).encode()
    out = subprocess.run(["git", "cat-file", "--batch"], input=request, capture_output=True, check=True).stdout
    blobs, pos = {}, 0
    for name in names:
        eol = out.index(b"\n", pos)
        header = out[pos:eol].split()
        pos = eol + 1
        if len(header) == 3 and header[1] == b"blob":
            size = int(header[2])
            blobs[name] = out[pos:pos + size]
            pos += size + 1  # the newline after each object
    return blobs

def on_disk(name):
    if not os.path.isfile(name) or os.path.getsize(name) > MAX:
        return None
    return open(name, "rb").read()

names = sorted({name for name in sys.stdin.buffer.read().decode().split("\0") if name})
staged = staged_blobs(names)
found = [name for name in names if is_keypair(staged.get(name)) or is_keypair(on_disk(name))]
for name in found:
    print(f"Refusing: {name} holds a Solana keypair. Keep keys in ~/.config/testing-pipeline/devnet/.", file=sys.stderr)
sys.exit(1 if found else 0)
'
