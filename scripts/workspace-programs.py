"""Prints the on-chain workspace's programs (programs/Cargo.toml's members that build a
`cdylib`), one per line, leaving out library crates such as mint-rules, which programs
depend on but which are never deployed. Used by build-programs.sh and local-validator.sh.

    python3 scripts/workspace-programs.py
"""

import pathlib
import tomllib

programs = pathlib.Path(__file__).resolve().parent.parent / "programs"
members = tomllib.loads((programs / "Cargo.toml").read_text())["workspace"]["members"]
for member in members:
    manifest = tomllib.loads((programs / member / "Cargo.toml").read_text())
    if "cdylib" in manifest.get("lib", {}).get("crate-type", []):
        print(member)
