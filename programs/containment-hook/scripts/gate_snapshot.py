#!/usr/bin/env python3
"""Copies every containment hook binding on a cluster into a folder, for the hook's release gate.

The release gate (programs/containment-hook/tests/release_gate.rs, run by scripts/pre-deploy.sh
before any new build replaces the deployed one) loads every config the deployed build wrote
into LiteSVM with the new bytes, and for every token still contained buys, sells, has a
wallet-to-wallet transfer refused and unlocks it by its goal and at its deadline (hardening
findings H011 and R2T-01 to R2T-06, #74).
This script gives it the bindings.
It reads every account the hook owns, unfiltered, and refuses unless each is a config (237
bytes, carrying the Config discriminator) or a validation account (51 bytes) at the
["extra-account-metas", mint] PDA of a config's mint, and every config has its validation
account (R2T-01): an RPC that answers with a partial list, or a program id that is not the
hook's, then shows as a census the gate can check rather than as an empty folder.
For each config it copies its mint, its validation account, the router Market the config
names, the market state, both mints and both vaults the Market records, and both of the
market's fee accounts (the associated token account of the router's fee authority
["fees", market] for each mint, under that mint's token program, as the router's
init_fee_account creates it).
Each is the solana CLI's account JSON, one file per account, named by address, as the tax
AMM's gate saves them.
For each token still contained it also copies every Token-2022 account of its mint (a
getProgramAccounts filtered by the mint at offset 0) to holders.json, from which the gate
reports the balances held in accounts whose owner can change (H002); a failure to read them is
recorded there, not fatal, since they are only reported.
It reads whether the hook is deployed with getAccountInfo, so a transport or RPC error stops
the script rather than reading as "not deployed" (R2T-05), and when it is, saves it as
deployed.so and the tax AMM the home markets run on (the strategy their Market records) as
tax_amm_deployed.so.
Last, it reads the cluster's clock, and writes manifest.json: the program id, the cluster's URL
and genesis hash (by which the gate knows devnet, R2T-04), the slot and Unix time, whether the
hook is deployed, the configs and validation accounts of the census, every account file it
wrote, the fee accounts the cluster does not hold, and the program files.
The gate loads only what the manifest lists, and the folder must be empty or new (R2T-06).

    gate_snapshot.py --url <cluster URL> --program <hook program id> --out <dir>

It only reads the cluster; getProgramAccounts needs an RPC that serves it (the public devnet
RPC does, Alchemy's free tier does not). It needs the toolchain's `solana` on PATH for the
addresses and the program dumps (source scripts/toolchain-env.sh).
"""

import argparse
import base64
import hashlib
import json
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

# The v1 config (programs/containment-hook/src/state.rs, pinned by tests/release_gate.rs):
# its size with the discriminator, and the offsets of the fields read here.
CONFIG_LEN = 237
CONFIG_DISCRIMINATOR = hashlib.sha256(b"account:Config").digest()[:8]
CONFIG_MINT_AT = 9
CONFIG_MARKET_AT = 41
CONFIG_MARKET_STATE_AT = 73
CONFIG_UNLOCKED_AT_TAG = 228
# The validation account: the extra account metas the hook writes for every mint.
VALIDATION_LEN = 51

# The router's Market account (programs/containment-hook/src/router.rs): the strategy, the
# market state, the mint count, four mints, then four vaults.
MARKET_STRATEGY_AT = 8
MARKET_STATE_AT = 40
MARKET_MINT_COUNT_AT = 72
MARKET_MINTS_AT = 73
MARKET_VAULTS_AT = MARKET_MINTS_AT + 32 * 4

ROUTER = "PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34"
TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111"

# The most transactions read for one mint's holders through its history.
HISTORY_MAX_SIGNATURES = 5000
# Tries of one RPC call the cluster rate-limits, and the wait before the next, growing by it.
RPC_ATTEMPTS = 5
RPC_BACKOFF_SECS = 5

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(raw: bytes) -> str:
    number = int.from_bytes(raw, "big")
    encoded = ""
    while number:
        number, digit = divmod(number, 58)
        encoded = ALPHABET[digit] + encoded
    leading = len(raw) - len(raw.lstrip(b"\0"))
    return "1" * leading + encoded


def rpc(url: str, method: str, params: list, attempts: int = 0):
    attempts = attempts or RPC_ATTEMPTS
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json", "User-Agent": "release-gate"}
    )
    # Public devnet answers 429 to bursts of one method; wait and try again, a few times.
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                reply = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt + 1 == attempts:
                raise
            time.sleep(RPC_BACKOFF_SECS * (attempt + 1))
            continue
        if "error" in reply:
            if reply["error"].get("code") == 429 and attempt + 1 < attempts:
                time.sleep(RPC_BACKOFF_SECS * (attempt + 1))
                continue
            raise SystemExit(f"{method}: {reply['error']}")
        return reply["result"]
    raise SystemExit(f"{method}: rate limited {attempts} times")


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


def written(out: pathlib.Path, files: list, address: str, account: dict) -> None:
    write(out, address, account)
    files.append(f"{address}.json")


def census(url: str, program: str) -> tuple:
    """Every account the hook owns, classed as configs and validation accounts; refuses
    anything else, a validation account with no config and a config with no validation
    account."""
    owned = rpc(url, "getProgramAccounts", [program, {"encoding": "base64", "commitment": "confirmed"}])
    configs, validations, refusals = [], {}, []
    for entry in sorted(owned, key=lambda entry: entry["pubkey"]):
        data = data_of(entry["account"])
        if len(data) == CONFIG_LEN and data[:8] == CONFIG_DISCRIMINATOR:
            configs.append(entry)
        elif len(data) == VALIDATION_LEN:
            validations[entry["pubkey"]] = entry
        else:
            refusals.append(f"{entry['pubkey']}, owned by the hook, is neither a config nor a validation account ({len(data)} bytes)")
    paired = {}
    for config in configs:
        mint = key(data_of(config["account"]), CONFIG_MINT_AT)
        validation = pda(program, "string:extra-account-metas", f"pubkey:{mint}")
        if validation in validations:
            paired[config["pubkey"]] = validations.pop(validation)
        else:
            refusals.append(f"the config {config['pubkey']} of mint {mint} has no validation account at {validation}")
    refusals += [f"{address}, owned by the hook, is a validation account with no config" for address in sorted(validations)]
    if refusals:
        raise SystemExit("the hook's accounts do not add up:\n" + "\n".join(f"  - {r}" for r in refusals))
    return configs, paired


def history_accounts(url: str, mint: str) -> list:
    """Every token account of `mint` any transaction that names the mint touched: each
    successful transaction's token balances, read signature by signature (H002; how
    .audit/models/h002_devnet_holders.py enumerated them)."""
    signatures, before = [], None
    while True:
        options = {"limit": 1000, "commitment": "confirmed"}
        if before:
            options["before"] = before
        page = rpc(url, "getSignaturesForAddress", [mint, options])
        signatures += [entry["signature"] for entry in page if entry["err"] is None]
        if len(signatures) > HISTORY_MAX_SIGNATURES:
            raise SystemExit(f"more than {HISTORY_MAX_SIGNATURES} transactions name {mint}")
        if len(page) < 1000:
            break
        before = page[-1]["signature"]
    accounts = set()
    for signature in signatures:
        tx = rpc(url, "getTransaction", [signature, {"encoding": "json", "commitment": "confirmed", "maxSupportedTransactionVersion": 0}])
        if tx is None:
            raise SystemExit(f"transaction {signature} of {mint} could not be read")
        keys = list(tx["transaction"]["message"]["accountKeys"])
        meta = tx["meta"] or {}
        loaded = meta.get("loadedAddresses") or {}
        keys += loaded.get("writable", []) + loaded.get("readonly", [])
        for balance in (meta.get("preTokenBalances") or []) + (meta.get("postTokenBalances") or []):
            if balance["mint"] == mint:
                accounts.add(keys[balance["accountIndex"]])
    return sorted(accounts)


def holders(url: str, mint: str) -> dict:
    """Every Token-2022 account of `mint`, raw, or why they could not be read.

    A getProgramAccounts on Token-2022 filtered by the mint first; public devnet refuses it
    ("Invalid param: WrongSize"), and then the accounts are found through the mint's
    transaction history instead. The gate checks the balances found add up to the supply."""
    def raw(entries):
        return [
            {"pubkey": address, "data": account["data"][0]}
            for address, account in entries
            if account is not None and account["owner"] == TOKEN_2022
        ]

    try:
        accounts = rpc(
            url,
            "getProgramAccounts",
            [TOKEN_2022, {"encoding": "base64", "commitment": "confirmed", "filters": [{"memcmp": {"offset": 0, "bytes": mint}}]}],
            attempts=2,
        )
        return {"source": "getProgramAccounts", "accounts": raw(sorted((a["pubkey"], a["account"]) for a in accounts))}
    except (SystemExit, OSError) as refused:
        try:
            found = fetch(url, history_accounts(url, mint))
            return {
                "source": f"the mint's transaction history (getProgramAccounts was refused: {refused})",
                "accounts": raw(sorted(found.items())),
            }
        except (SystemExit, OSError) as error:
            return {"source": "none", "error": f"getProgramAccounts: {refused}; the transaction history: {error}", "accounts": []}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", required=True)
    parser.add_argument("--program", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    url = cluster_url(args.url)
    out = pathlib.Path(args.out)
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"{out} is not empty; the snapshot goes into an empty or new folder, so nothing stale is read")
    out.mkdir(parents=True, exist_ok=True)
    files = []

    genesis_hash = rpc(url, "getGenesisHash", [])
    # Whether the hook is deployed: an RPC or transport error stops the script here.
    deployed = rpc(url, "getAccountInfo", [args.program, {"encoding": "base64", "commitment": "confirmed", "dataSlice": {"offset": 0, "length": 0}}])["value"] is not None
    configs, validations = census(url, args.program)
    if configs and not deployed:
        raise SystemExit(f"{len(configs)} hook configs exist but the hook {args.program} is not deployed")

    # Each config, its validation account, its mint, Market and market state.
    first = []
    markets = []
    for config in configs:
        written(out, files, config["pubkey"], config["account"])
        validation = validations[config["pubkey"]]
        written(out, files, validation["pubkey"], validation["account"])
        data = data_of(config["account"])
        market = key(data, CONFIG_MARKET_AT)
        markets.append(market)
        first += [key(data, CONFIG_MINT_AT), market, key(data, CONFIG_MARKET_STATE_AT)]
    first = sorted(set(first))
    accounts = fetch(url, first)
    for address in first:
        if accounts[address] is None:
            raise SystemExit(f"{address}, a contained mint or its binding's account, does not exist")
        written(out, files, address, accounts[address])

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
        written(out, files, address, found[address])
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
    for address, account in sorted(fetch(url, fee_accounts).items()):
        if account is None:
            missing.append(address)
        else:
            written(out, files, address, account)

    # Every Token-2022 account of each contained mint, for the gate's report (H002).
    contained = [c for c in configs if data_of(c["account"])[CONFIG_UNLOCKED_AT_TAG] == 0]
    held = {key(data_of(c["account"]), CONFIG_MINT_AT): holders(url, key(data_of(c["account"]), CONFIG_MINT_AT)) for c in contained}
    (out / "holders.json").write_text(json.dumps(held, indent=2, sort_keys=True) + "\n")

    # The clock last, so every account above is at least as old as it.
    clock = data_of(rpc(url, "getAccountInfo", [CLOCK_SYSVAR, {"encoding": "base64", "commitment": "confirmed"}])["value"])
    slot = int.from_bytes(clock[0:8], "little")
    unix_timestamp = int.from_bytes(clock[32:40], "little", signed=True)

    programs = {}
    if deployed:
        subprocess.run(
            ["solana", "program", "dump", "--url", url, args.program, str(out / "deployed.so")],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        programs["deployed"] = "deployed.so"
        print(f"the deployed hook saved as {out / 'deployed.so'}")
        if len(strategies) > 1:
            raise SystemExit(f"the home markets run on more than one strategy: {sorted(strategies)}")
        for strategy in strategies:
            subprocess.run(
                ["solana", "program", "dump", "--url", url, strategy, str(out / "tax_amm_deployed.so")],
                check=True,
                stdout=subprocess.DEVNULL,
            )
            programs["tax_amm"] = "tax_amm_deployed.so"
            programs["tax_amm_id"] = strategy
            print(f"the deployed tax AMM {strategy} saved as {out / 'tax_amm_deployed.so'}")

    manifest = {
        "program": args.program,
        "url": url,
        "genesis_hash": genesis_hash,
        "slot": slot,
        "unix_timestamp": unix_timestamp,
        "deployed": deployed,
        "configs": [c["pubkey"] for c in configs],
        "validation_accounts": sorted(v["pubkey"] for v in validations.values()),
        "accounts": sorted(files),
        "fee_accounts_missing": missing,
        "holders": "holders.json",
        "programs": programs,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(
        f"{len(configs)} hook configs ({len(contained)} still contained), {len(files)} accounts"
        f" with {len(fee_accounts) - len(missing)} of {len(fee_accounts)} fee accounts copied"
        f" to {out}, at slot {slot}, Unix time {unix_timestamp}; the hook is"
        f" {'deployed' if deployed else 'not deployed'} on {url} (genesis {genesis_hash})"
    )


if __name__ == "__main__":
    sys.exit(main())
