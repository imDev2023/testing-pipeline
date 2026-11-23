#!/usr/bin/env python3
"""Checks that ci.yml's CANARY_PATHS covers every build input of the containment hook that
Canary's tests load (hardening finding R2T-13 of #74).

The canary job builds the hook from programs/ (crates/canary/tests/fixtures/build.sh runs
scripts/build-programs.sh containment-hook), so its bytes depend on the hook's crate, every
crate of the on-chain workspace it links through a path dependency, the workspace's
Cargo.toml, Cargo.lock and rust-toolchain.toml, and the scripts the build runs. A pull request
that changes only one of them must still wake the canary job. This script derives that list
from the manifests and the scripts themselves, and fails naming any file CANARY_PATHS misses.

    python3 scripts/check-canary-paths.py
"""

import pathlib
import re
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROGRAMS = ROOT / "programs"
BUILD_SCRIPT = "crates/canary/tests/fixtures/build.sh"


def canary_paths() -> re.Pattern:
    text = (ROOT / ".github/workflows/ci.yml").read_text()
    found = re.search(r"^\s*CANARY_PATHS: >-\n\s*(\S+)\n", text, re.MULTILINE)
    if not found:
        raise SystemExit("ci.yml: no CANARY_PATHS folded scalar found")
    return re.compile(found.group(1))


def path_crates(crate: str, workspace: dict, seen: set) -> None:
    """Adds `crate` (a folder under programs/) and every path crate it depends on to `seen`."""
    if crate in seen:
        return
    seen.add(crate)
    manifest = tomllib.loads((PROGRAMS / crate / "Cargo.toml").read_text())
    for table in ("dependencies", "build-dependencies"):
        for name, spec in manifest.get(table, {}).items():
            if not isinstance(spec, dict):
                continue
            # A workspace dependency's path is relative to programs/, a crate's own to the crate.
            base, spec = (PROGRAMS, workspace.get(name, {})) if spec.get("workspace") else (PROGRAMS / crate, spec)
            if isinstance(spec, dict) and "path" in spec:
                path_crates(str((base / spec["path"]).resolve().relative_to(PROGRAMS)), workspace, seen)


def scripts_run_by(script: str, seen: set) -> None:
    """Adds `script` and every script of the repository it runs (named as $ROOT/... or $HERE/...)."""
    if script in seen:
        return
    seen.add(script)
    text = (ROOT / script).read_text()
    for name in re.findall(r"\$(?:ROOT|\{ROOT\})/((?:scripts|programs|crates)/[\w./-]+\.(?:sh|py))", text):
        scripts_run_by(name, seen)


def required_files() -> list:
    workspace = tomllib.loads((PROGRAMS / "Cargo.toml").read_text())["workspace"]["dependencies"]
    crates: set = set()
    path_crates("containment-hook", workspace, crates)
    files = [f"programs/{crate}/Cargo.toml" for crate in sorted(crates)]
    files += [f"programs/{crate}/src/lib.rs" for crate in sorted(crates)]
    files += ["programs/Cargo.toml", "programs/Cargo.lock", "programs/rust-toolchain.toml"]
    scripts: set = set()
    scripts_run_by(BUILD_SCRIPT, scripts)
    files += sorted(scripts)
    return files


def main() -> int:
    pattern = canary_paths()
    files = required_files()
    missed = [name for name in files if not pattern.search(name)]
    if missed:
        print("ci.yml's CANARY_PATHS misses these build inputs of the containment hook Canary loads:")
        for name in missed:
            print(f"  {name}")
        return 1
    print(f"CANARY_PATHS covers all {len(files)} build inputs of the containment hook Canary loads")
    return 0


if __name__ == "__main__":
    sys.exit(main())
