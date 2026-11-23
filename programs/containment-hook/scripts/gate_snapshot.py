#!/usr/bin/env python3
"""Copies every containment hook binding on a cluster into a folder, for the hook's release gate.

The release gate (programs/containment-hook/tests/release_gate.rs, run by scripts/pre-deploy.sh
before any new build replaces the deployed one) loads every config the deployed build wrote
into LiteSVM with the new bytes, and for every token still contained buys, sells, has a
wallet-to-wallet transfer refused and unlocks it at its deadline (hardening finding H011, #74).
This script gives it the bindings: every hook config (owned by the hook, 237 bytes, carrying
the Config discriminator), and for each its mint, its validation account
["extra-account-metas", mint], the router Market the config names, the market state, both
mints and both vaults the Market records, and both of the market's fee accounts (the
associated token account of the router's fee authority ["fees", market] for each mint, under
that mint's token program, as the router's init_fee_account creates it).
Each is the solana CLI's account JSON, one file per account, named by address, as the tax
AMM's gate saves them; a fee account the cluster does not hold is listed in missing.json.
Last, it reads the cluster's clock, saved as clock.json (its slot, its Unix time and the
cluster's URL), since what a binding allows depends on the time.
With --deployed it also saves the hook deployed on the cluster as deployed.so, and the tax AMM
the home markets run on (the strategy their Market records) as tax_amm_deployed.so.

    gate_snapshot.py --url <cluster URL> --program <hook program id> --out <dir> [--deployed]

It only reads the cluster; getProgramAccounts needs an RPC that serves it (the public devnet
RPC does, Alchemy's free tier does not). It needs the toolchain's `solana` on PATH for the
addresses and --deployed (source scripts/toolchain-env.sh).
"""

import argparse
import base64
import hashlib
import json
import pathlib
import subprocess
import sys
import urllib.request

# The v1 config (programs/containment-hook/src/state.rs, pinned by tests/release_gate.rs):
# its size with the discriminator, and the offsets of the fields read here.
CONFIG_LEN = 237
CONFIG_DISCRIMINATOR = hashlib.sha256(b"account:Config").digest()[:8]
CONFIG_MINT_AT = 9
CONFIG_MARKET_AT = 41
CONFIG_MARKET_STATE_AT = 73
CONFIG_UNLOCKED_AT_TAG = 228

# The router's Market account (programs/containment-hook/src/router.rs): the strategy, the
# market state, the mint count, four mints, then four vaults.
MARKET_STRATEGY_AT = 8
MARKET_STATE_AT = 40
MARKET_MINT_COUNT_AT = 72
MARKET_MINTS_AT = 73
MARKET_VAULTS_AT = MARKET_MINTS_AT + 32 * 4

ROUTER = "PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34"
ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111"

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


def pda(program: str, *seeds: str) -> str:
    """The canonical PDA of `program` from seeds in the solana CLI's form (string:, pubkey:)."""
    out = subprocess.run(
        ["solana", "find-program-derived-address", program, *seeds, "--output", "json"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return json.loads(out)["address"]


def key(data: bytes, at: int) -> str:
    return b58encode(data[at : at + 32])


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


def fetch(url: str, addresses: list) -> dict:
    """Each address's account, or None where the cluster holds none."""
    found = {}
    for start in range(0, len(addresses), 100):
        batch = addresses[start : start + 100]
        values = rpc(
            url, "getMultipleAccounts", [batch, {"encoding": "base64", "commitment": "confirmed"}]
        )["value"]
        found.update(zip(batch, values))
    return found


def data_of(account: dict) -> bytes:
    return base64.b64decode(account["data"][0])


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

    configs = rpc(
        url,
        "getProgramAccounts",
        [
            args.program,
            {
                "encoding": "base64",
                "commitment": "confirmed",
                "filters": [
                    {"dataSize": CONFIG_LEN},
                    {"memcmp": {"offset": 0, "bytes": b58encode(CONFIG_DISCRIMINATOR)}},
                ],
            },
        ],
    )
    configs.sort(key=lambda config: config["pubkey"])

    # Each config's mint, validation account, Market and market state.
    first = []
    markets = []
    for config in configs:
        write(out, config["pubkey"], config["account"])
        data = data_of(config["account"])
        mint = key(data, CONFIG_MINT_AT)
        market = key(data, CONFIG_MARKET_AT)
        markets.append(market)
        first += [
            mint,
            pda(args.program, "string:extra-account-metas", f"pubkey:{mint}"),
            market,
            key(data, CONFIG_MARKET_STATE_AT),
        ]
    first = sorted(set(first))
    accounts = fetch(url, first)
    for address in first:
        if accounts[address] is None:
            raise SystemExit(f"{address}, a contained mint or its binding's account, does not exist")
        write(out, address, accounts[address])

    # Each Market's mints and vaults, then its fee accounts, under each mint's token program.
    strategies = set()
    second = []
    market_mints = {}
    for market in sorted(set(markets)):
        data = data_of(accounts[market])
        strategies.add(key(data, MARKET_STRATEGY_AT))
        count = data[MARKET_MINT_COUNT_AT]
        mints = [key(data, MARKET_MINTS_AT + 32 * i) for i in range(count)]
        vaults = [key(data, MARKET_VAULTS_AT + 32 * i) for i in range(count)]
        market_mints[market] = mints
        second += mints + vaults
    second = sorted(set(second) - set(first))
    found = fetch(url, second)
    for address in second:
        if found[address] is None:
            raise SystemExit(f"{address}, a mint or vault of a home market, does not exist")
        write(out, address, found[address])
    accounts.update(found)

    fee_accounts = []
    for market, mints in sorted(market_mints.items()):
        authority = pda(ROUTER, "string:fees", f"pubkey:{market}")
        for mint in mints:
            token_program = accounts[mint]["owner"]
            fee_accounts.append(
                pda(
                    ASSOCIATED_TOKEN_PROGRAM,
                    f"pubkey:{authority}",
                    f"pubkey:{token_program}",
                    f"pubkey:{mint}",
                )
            )
    fee_accounts = sorted(set(fee_accounts))
    missing = []
    for address, account in fetch(url, fee_accounts).items():
        if account is None:
            missing.append(address)
        else:
            write(out, address, account)
    (out / "missing.json").write_text(json.dumps({"fee_accounts": sorted(missing)}, indent=2) + "\n")

    # The clock last, so every account above is at least as old as it.
    clock = data_of(rpc(url, "getAccountInfo", [CLOCK_SYSVAR, {"encoding": "base64", "commitment": "confirmed"}])["value"])
    slot = int.from_bytes(clock[0:8], "little")
    unix_timestamp = int.from_bytes(clock[32:40], "little", signed=True)
    (out / "clock.json").write_text(
        json.dumps({"slot": slot, "unix_timestamp": unix_timestamp, "url": url}, indent=2) + "\n"
    )
    contained = sum(1 for config in configs if data_of(config["account"])[CONFIG_UNLOCKED_AT_TAG] == 0)
    print(
        f"{len(configs)} hook configs ({contained} still contained), {len(first) + len(second)} of their"
        f" accounts and {len(fee_accounts) - len(missing)} of {len(fee_accounts)} fee accounts copied"
        f" to {out}, at slot {slot}, Unix time {unix_timestamp}"
    )

    if args.deployed:
        subprocess.run(
            ["solana", "program", "dump", "--url", url, args.program, str(out / "deployed.so")],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        print(f"the deployed hook saved as {out / 'deployed.so'}")
        if len(strategies) > 1:
            raise SystemExit(f"the home markets run on more than one strategy: {sorted(strategies)}")
        for strategy in strategies:
            subprocess.run(
                ["solana", "program", "dump", "--url", url, strategy, str(out / "tax_amm_deployed.so")],
                check=True,
                stdout=subprocess.DEVNULL,
            )
            print(f"the deployed tax AMM {strategy} saved as {out / 'tax_amm_deployed.so'}")


if __name__ == "__main__":
    sys.exit(main())
