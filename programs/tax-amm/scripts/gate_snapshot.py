#!/usr/bin/env python3
"""Copies every tax market on a cluster into a folder, for the tax AMM's release gate.

The release gate (programs/tax-amm/tests/release_gate.rs, run by scripts/pre-deploy.sh before
any new build replaces the deployed one) reads and quotes every tax market with the new bytes
(docs/spec/tax-amm.md, "Upgrades and freezing"; hardening finding H038, #67). This script
gives it the markets: each market state the program owns (its discriminator and exact size),
and both of its vaults and mints, as the solana CLI's account JSON, one file per account,
named by address, and the cluster's slot once they are read, as slot.json, since the rates a
market charges depend on it (docs/spec/tax-amm.md, "Rates"). With --deployed it also saves the program deployed on the cluster, as
deployed.so, for the gate to compare the new build against.

    gate_snapshot.py --url <cluster URL> --program <program id> --out <dir> [--deployed]

It only reads the cluster. --deployed needs the toolchain's `solana` on PATH
(source scripts/toolchain-env.sh).
"""

import argparse
import base64
import hashlib
import json
import pathlib
import subprocess
import sys
import urllib.request

# docs/spec/tax-amm.md, "Counters for the containment hook": the market state's size, and the
# offsets of its mints and vaults (pinned by tests/layout.rs).
STATE_LEN = 596
MINTS_AT = 14
VAULTS_AT = 78
DISCRIMINATOR = hashlib.sha256(b"account:TaxMarket").digest()[:8]

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(raw: bytes) -> str:
    number = int.from_bytes(raw, "big")
    encoded = ""
    while number:
        number, digit = divmod(number, 58)
        encoded = ALPHABET[digit] + encoded
    leading = len(raw) - len(raw.lstrip(b"\0"))
    return "1" * leading + encoded


def rpc(url: str, method: str, params: list):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json", "User-Agent": "release-gate"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        reply = json.load(response)
    if "error" in reply:
        raise SystemExit(f"{method}: {reply['error']}")
    return reply["result"]


def cluster_url(url: str) -> str:
    return {"devnet": "https://api.devnet.solana.com"}.get(url, url)


def write(out: pathlib.Path, address: str, account: dict) -> None:
    record = {
        "pubkey": address,
        "account": {
            "lamports": account["lamports"],
            "data": account["data"],
            "owner": account["owner"],
            "executable": account["executable"],
            "rentEpoch": 0,
            "space": len(base64.b64decode(account["data"][0])),
        },
    }
    (out / f"{address}.json").write_text(json.dumps(record, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", required=True)
    parser.add_argument("--program", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--deployed", action="store_true")
    args = parser.parse_args()
    url = cluster_url(args.url)
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    markets = rpc(
        url,
        "getProgramAccounts",
        [
            args.program,
            {
                "encoding": "base64",
                "commitment": "confirmed",
                "filters": [
                    {"dataSize": STATE_LEN},
                    {"memcmp": {"offset": 0, "bytes": b58encode(DISCRIMINATOR)}},
                ],
            },
        ],
    )
    others = []
    for market in markets:
        write(out, market["pubkey"], market["account"])
        data = base64.b64decode(market["account"]["data"][0])
        for at in (MINTS_AT, MINTS_AT + 32, VAULTS_AT, VAULTS_AT + 32):
            others.append(b58encode(data[at : at + 32]))
    others = sorted(set(others))
    for start in range(0, len(others), 100):
        batch = others[start : start + 100]
        found = rpc(
            url,
            "getMultipleAccounts",
            [batch, {"encoding": "base64", "commitment": "confirmed"}],
        )["value"]
        for address, account in zip(batch, found):
            if account is None:
                raise SystemExit(f"{address}, a mint or vault of a tax market, does not exist")
            write(out, address, account)
    slot = rpc(url, "getSlot", [{"commitment": "confirmed"}])
    (out / "slot.json").write_text(json.dumps({"slot": slot}) + "\n")
    print(f"{len(markets)} tax markets and {len(others)} mints and vaults copied to {out}, at slot {slot}")

    if args.deployed:
        subprocess.run(
            ["solana", "program", "dump", "--url", url, args.program, str(out / "deployed.so")],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        print(f"the deployed program saved as {out / 'deployed.so'}")


if __name__ == "__main__":
    sys.exit(main())
