"""Prints the on-chain workspace's programs (programs/Cargo.toml's members that build a
`cdylib`), one per line, as paths relative to programs/, leaving out library crates such as
mint-rules, which programs depend on but which are never deployed.

Test programs, marked `[package.metadata.testing-pipeline] test-program = true` (the stand-in
launchpad), are left out too, so nothing that deploys or builds deployable programs sees
them; `--test-programs` prints only those instead. Used by build-programs.sh and
local-validator.sh.

    python3 scripts/workspace-programs.py [--test-programs]
"""

import pathlib
import sys
import tomllib

want_test_programs = sys.argv[1:] == ["--test-programs"]
if sys.argv[1:] not in ([], ["--test-programs"]):
    sys.exit("usage: workspace-programs.py [--test-programs]")

programs = pathlib.Path(__file__).resolve().parent.parent / "programs"
members = tomllib.loads((programs / "Cargo.toml").read_text())["workspace"]["members"]
for member in members:
    manifest = tomllib.loads((programs / member / "Cargo.toml").read_text())
    if "cdylib" not in manifest.get("lib", {}).get("crate-type", []):
        continue
    metadata = manifest.get("package", {}).get("metadata", {}).get("testing-pipeline", {})
    if metadata.get("test-program", False) == want_test_programs:
        print(member)
