#!/usr/bin/env python3
"""Builds the lending AMM's deliberately broken builds: the fuzzer's (tests/broken-builds.json),
which tests/broken_builds.rs runs the invariant fuzzer on to show each invariant able to fail,
and the release gate's (gate/test-builds.json), which gate/tests/markets.rs shows the gate
refuses (docs/spec/lending-pool.md, "A release gate").

Each build is one edit to a copy of the program's source, made at one fixed path and built with
its own cargo target dir, so no copy can share the real program's cargo fingerprint and pass for
it, and nothing is ever written into target/deploy. Each edit must match its source exactly once,
and no two builds, nor a build and the real program, may come out identical.

    python3 programs/lending-amm/scripts/broken-builds.py [name ...]   # default: every build

Writes programs/target/lending-broken-builds/<name>.so ($LENDING_BROKEN_BUILDS moves it).
Needs the toolchain (source scripts/toolchain-env.sh).
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

CRATE = Path(__file__).resolve().parent.parent
PROGRAMS = CRATE.parent
OUT = Path(os.environ.get("LENDING_BROKEN_BUILDS", PROGRAMS / "target" / "lending-broken-builds"))
COPY = OUT / "workspace"
TARGET = OUT / "target"


LISTS = [CRATE / "tests" / "broken-builds.json", CRATE / "gate" / "test-builds.json"]


def builds():
    every = [b for path in LISTS for b in json.loads(path.read_text())["builds"]]
    names = [b["name"] for b in every]
    duplicated = sorted({name for name in names if names.count(name) > 1})
    if duplicated:
        sys.exit(f"broken builds named twice: {', '.join(duplicated)}")
    return every


def copy_workspace():
    """A workspace of just mint-rules and the lending AMM's program, as the real one builds it:
    the same pins, lock file, toolchain and release profile."""
    if COPY.exists():
        shutil.rmtree(COPY)
    COPY.mkdir(parents=True)
    manifest = (PROGRAMS / "Cargo.toml").read_text()
    manifest, count = re.subn(
        r"^members = \[.*\]$", 'members = ["mint-rules", "lending-amm"]', manifest, flags=re.M
    )
    assert count == 1, "programs/Cargo.toml has one members line"
    (COPY / "Cargo.toml").write_text(manifest)
    for name in ["Cargo.lock", "rust-toolchain.toml"]:
        shutil.copy2(PROGRAMS / name, COPY / name)
    shutil.copytree(PROGRAMS / "mint-rules" / "src", COPY / "mint-rules" / "src")
    shutil.copy2(PROGRAMS / "mint-rules" / "Cargo.toml", COPY / "mint-rules" / "Cargo.toml")
    # The program builds without its tests, so its test-only dependencies are left out.
    (COPY / "lending-amm").mkdir()
    (COPY / "lending-amm" / "Cargo.toml").write_text(
        without_table((CRATE / "Cargo.toml").read_text(), "dev-dependencies")
    )


def without_table(manifest, table):
    """`manifest` with the TOML table `[table]` and its keys removed, up to the next table."""
    kept, skipping, found = [], False, False
    for line in manifest.splitlines(keepends=True):
        header = re.match(r"^\s*\[([^\[\]]+)\]\s*(#.*)?$", line)
        if header:
            skipping = header.group(1).strip() == table
            found = found or skipping
        if not skipping:
            kept.append(line)
    assert found, f"the manifest has a [{table}] table"
    return "".join(kept)


def build(entry):
    src = COPY / "lending-amm" / "src"
    if src.exists():
        shutil.rmtree(src)
    shutil.copytree(CRATE / "src", src)
    path = COPY / "lending-amm" / entry["file"]
    text = path.read_text()
    found = text.count(entry["find"])
    if found != 1:
        sys.exit(f"{entry['name']}: the edit matches {entry['file']} {found} times, not once")
    path.write_text(text.replace(entry["find"], entry["replace"]))
    deploy = OUT / "deploy" / entry["name"]
    deploy.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, CARGO_TARGET_DIR=str(TARGET))
    subprocess.run(
        [
            "cargo",
            "build-sbf",
            "--manifest-path",
            str(COPY / "lending-amm" / "Cargo.toml"),
            "--sbf-out-dir",
            str(deploy),
        ],
        check=True,
        env=env,
    )
    so = OUT / f"{entry['name']}.so"
    shutil.copy2(deploy / "lending_amm.so", so)
    return so


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(names):
    every = builds()
    unknown = set(names) - {b["name"] for b in every}
    if unknown:
        sys.exit(f"no broken build named {', '.join(sorted(unknown))}")
    chosen = [b for b in every if not names or b["name"] in names]
    copy_workspace()
    for entry in chosen:
        print(f"== {entry['name']}: {entry['why']}", flush=True)
        build(entry)
    # Every build is its own: none equals another or the real program.
    seen = {}
    real = PROGRAMS / "target" / "deploy" / "lending_amm.so"
    if real.exists():
        seen[digest(real)] = "the real program"
    for entry in every:
        so = OUT / f"{entry['name']}.so"
        if not so.exists():
            continue
        d = digest(so)
        if d in seen:
            sys.exit(f"{entry['name']} came out identical to {seen[d]}")
        seen[d] = entry["name"]
        print(f"{entry['name']}.so {d[:16]}")


if __name__ == "__main__":
    main(sys.argv[1:])
