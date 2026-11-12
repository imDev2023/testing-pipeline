"""Dumps the Kamino Lend accounts the lending AMM's tests and local demo run read, and checks
a fresh dump against the committed one (docs/spec/lending-pool.md, "Building it";
docs/spec/README.md, "Test layers", layer 6).

    python3 programs/lending-amm/scripts/kamino_accounts.py dump --cluster mainnet
    python3 programs/lending-amm/scripts/kamino_accounts.py dump --cluster devnet [--out DIR]
    python3 programs/lending-amm/scripts/kamino_accounts.py check --cluster mainnet [--fresh DIR]

For each reserve a build of the lending AMM lends to, it reads the reserve, its lending
market, the lending market's authority (when it exists), the liquidity and collateral mints,
and the reserve's liquidity supply, fee vault and collateral supply token accounts, all in one
`getMultipleAccounts` call, so every account is as it was at one slot. Public RPC only, read
only.

`dump` writes one file per account, in the format of `solana account --output json` (which
`solana-test-validator --account` loads), and `manifest.json` with the slot they were read at,
that slot's time and each account's label, address, owner, size and SHA-256. Without `--out`
it writes the committed copy, `programs/lending-amm/tests/fixtures/kamino/<cluster>/`, which
the LiteSVM tests load: an RPC cannot serve an account's past state, so the dump is committed
and replaced only on purpose, with the tests run against the new one.

`check` dumps afresh into a temporary folder and compares its layout with the committed copy:
the same accounts at the same addresses, each with the same owner and size, the same Anchor
discriminator on Kamino's accounts, the same addresses in every field the lending AMM's
reserve check compares, and the same mint and owner for each token account. Balances, rates
and timestamps move every slot and are not compared. It exits non-zero on any difference.
`--fresh DIR` compares against a dump already in DIR instead of fetching one, which is how
`test-fixture-scripts.sh` tests it without the network.

The reserves are those of each cluster's lent mints: mainnet's are read from the mainnet
`LENT_MINTS` in `programs/lending-amm/src/config.rs`, their one place, and devnet's from
`deployments/kamino-devnet.json`, which that file's devnet rows must equal
(`tests/policy_values.rs`); `tests/kamino.rs` checks the committed dumps are of the reserves
each build lends to. Offsets are klend 1.28.0's (docs/spec/lending-pool.md,
"Valuing the lent side").

Environment: RPC_URL overrides the cluster's public RPC.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import pathlib
import re
import sys
import tempfile
import time
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
COMMITTED = ROOT / "programs" / "lending-amm" / "tests" / "fixtures" / "kamino"

KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
SYSTEM = "11111111111111111111111111111111"
RPC = {
    "mainnet": "https://api.mainnet-beta.solana.com",
    "devnet": "https://api.devnet.solana.com",
}
CONFIG = ROOT / "programs" / "lending-amm" / "src" / "config.rs"
# The names the dumps give LENT_MINTS' entries, in their order.
LENT_NAMES = ("sol", "usdc")
# Reserve fields that hold addresses, at klend 1.28.0's offsets (discriminator included).
RESERVE_KEYS = {
    "lending_market": 32,
    "liquidity_mint": 128,
    "liquidity_supply": 160,
    "fee_vault": 192,
    "collateral_mint": 2560,
    "collateral_supply": 2600,
}
RESERVE_SIZE = 8624
LENDING_MARKET_SIZE = 4664

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(raw: bytes) -> str:
    number = int.from_bytes(raw, "big")
    out = ""
    while number:
        number, digit = divmod(number, 58)
        out = ALPHABET[digit] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + out


def b58decode(text: str) -> bytes:
    number = 0
    for char in text:
        number = number * 58 + ALPHABET.index(char)
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    return b"\0" * (len(text) - len(text.lstrip("1"))) + raw


def is_on_curve(key: bytes) -> bool:
    """Whether 32 bytes are a point on ed25519, which a program address never is."""
    p = 2**255 - 19
    d = (-121665 * pow(121666, p - 2, p)) % p
    y = int.from_bytes(key, "little") & ((1 << 255) - 1)
    if y >= p:
        return False
    u = (y * y - 1) % p
    v = (d * y * y + 1) % p
    x2 = u * pow(v, p - 2, p) % p
    if x2 == 0:
        return True
    x = pow(x2, (p + 3) // 8, p)
    if (x * x - x2) % p != 0:
        x = x * pow(2, (p - 1) // 4, p) % p
    return (x * x - x2) % p == 0


def find_program_address(seeds: list[bytes], program: str) -> str:
    program_bytes = b58decode(program)
    for bump in range(255, -1, -1):
        digest = hashlib.sha256(
            b"".join(seeds) + bytes([bump]) + program_bytes + b"ProgramDerivedAddress"
        ).digest()
        if not is_on_curve(digest):
            return b58encode(digest)
    raise ValueError("no program address")


def rpc(url: str, method: str, params: list) -> dict:
    """One JSON-RPC call through curl, which uses the system's certificates (some Python
    installs on macOS ship none), retried while the public RPC throttles or drops it."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    last_error = ""
    for attempt in range(5):
        done = subprocess.run(
            ["curl", "-sS", "--max-time", "60", "-H", "Content-Type: application/json", "-d", "@-", url],
            input=body,
            capture_output=True,
            text=True,
        )
        if done.returncode == 0:
            try:
                reply = json.loads(done.stdout)
                if "error" not in reply:
                    return reply["result"]
                last_error = f"{reply['error']}"
            except json.JSONDecodeError:
                last_error = done.stdout[:200]
        else:
            last_error = done.stderr.strip()
        time.sleep(2 + 3 * attempt)
    raise SystemExit(f"{method} failed after 5 tries: {last_error}")


def mainnet_reserves() -> dict[str, str]:
    """The reserves of the mainnet `LENT_MINTS` in config.rs, in order."""
    text = CONFIG.read_text()
    start = text.index('#[cfg(feature = "mainnet")]\npub const LENT_MINTS')
    block = text[start : text.index("];", start)]
    reserves = re.findall(r'reserve: pubkey!\("([1-9A-HJ-NP-Za-km-z]+)"\)', block)
    if len(reserves) != len(LENT_NAMES):
        raise SystemExit(f"found {len(reserves)} reserves in the mainnet LENT_MINTS of {CONFIG}")
    return dict(zip(LENT_NAMES, reserves))


def reserves_of(cluster: str) -> dict[str, str]:
    if cluster == "mainnet":
        return mainnet_reserves()
    deployment = json.loads((ROOT / "deployments" / "kamino-devnet.json").read_text())
    names = {"wsol": "sol", "testUsdc": "usdc"}
    return {names[name]: reserve["address"] for name, reserve in deployment["reserves"].items()}


def get_accounts(url: str, addresses: list[str]) -> tuple[int, list[dict | None]]:
    result = rpc(url, "getMultipleAccounts", [addresses, {"encoding": "base64", "commitment": "finalized"}])
    return result["context"]["slot"], result["value"]


def key_at(data: bytes, offset: int) -> str:
    return b58encode(data[offset : offset + 32])


def dump(cluster: str, out: pathlib.Path) -> dict:
    url = os.environ.get("RPC_URL", RPC[cluster])
    reserves = reserves_of(cluster)
    # First the reserves, for the addresses they name.
    _, reserve_accounts = get_accounts(url, list(reserves.values()))
    labels: dict[str, str] = {}
    lending_markets = set()
    for (name, address), account in zip(reserves.items(), reserve_accounts):
        if account is None:
            raise SystemExit(f"reserve {name} {address} does not exist on {cluster}")
        data = base64.b64decode(account["data"][0])
        labels[f"reserve-{name}"] = address
        lending_markets.add(key_at(data, RESERVE_KEYS["lending_market"]))
        for field in ("liquidity_mint", "collateral_mint", "liquidity_supply", "fee_vault", "collateral_supply"):
            labels[f"{field.replace('_', '-')}-{name}"] = key_at(data, RESERVE_KEYS[field])
    if len(lending_markets) != 1:
        raise SystemExit(f"the reserves name {len(lending_markets)} lending markets; expected one")
    lending_market = lending_markets.pop()
    labels["lending-market"] = lending_market
    labels["lending-market-authority"] = find_program_address([b"lma", b58decode(lending_market)], KLEND)

    # Then every account at once, so all of them are as they were at one slot.
    slot, accounts = get_accounts(url, list(labels.values()))
    try:
        unix_timestamp = rpc(url, "getBlockTime", [slot])
    except SystemExit:
        unix_timestamp = None
    if not isinstance(unix_timestamp, int):
        unix_timestamp = int(time.time())

    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.json"):
        stale.unlink()
    manifest = {
        "cluster": cluster,
        "slot": slot,
        "unixTimestamp": unix_timestamp,
        "readAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "accounts": [],
    }
    for (label, address), account in zip(labels.items(), accounts):
        if account is None:
            # The lending market's authority is a PDA that may hold nothing; klend only needs
            # its address.
            if label == "lending-market-authority":
                continue
            raise SystemExit(f"{label} {address} does not exist on {cluster}")
        data = base64.b64decode(account["data"][0])
        record = {
            "pubkey": address,
            "account": {
                "lamports": account["lamports"],
                "data": [account["data"][0], "base64"],
                "owner": account["owner"],
                "executable": account["executable"],
                "rentEpoch": 0,
                "space": len(data),
            },
        }
        (out / f"{label}.json").write_text(json.dumps(record, indent=2) + "\n")
        manifest["accounts"].append(
            {
                "label": label,
                "address": address,
                "owner": account["owner"],
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{cluster}: {len(manifest['accounts'])} accounts at slot {slot} -> {out}")
    return manifest


def load(folder: pathlib.Path) -> tuple[dict, dict[str, bytes], dict[str, dict]]:
    manifest = json.loads((folder / "manifest.json").read_text())
    data, records = {}, {}
    for entry in manifest["accounts"]:
        record = json.loads((folder / f"{entry['label']}.json").read_text())
        records[entry["label"]] = record
        data[entry["label"]] = base64.b64decode(record["account"]["data"][0])
    return manifest, data, records


def layout(label: str, owner: str, data: bytes) -> dict:
    """What must not change between dumps: everything but balances, rates and times."""
    facts = {"owner": owner, "size": len(data)}
    if owner == KLEND:
        facts["discriminator"] = data[:8].hex()
    if label.startswith("reserve-"):
        facts.update({field: key_at(data, offset) for field, offset in RESERVE_KEYS.items()})
    elif label == "lending-market":
        facts["lending_market_owner_field"] = key_at(data, 16)
    elif owner == TOKEN and len(data) == 165:
        facts.update({"mint": key_at(data, 0), "token_owner": key_at(data, 32)})
    elif owner == TOKEN and len(data) == 82:
        facts["decimals"] = data[44]
    return facts


def check(cluster: str, fresh: pathlib.Path | None) -> int:
    committed_dir = COMMITTED / cluster
    committed, committed_data, _ = load(committed_dir)
    if fresh is not None:
        fresh_manifest, fresh_data, _ = load(fresh)
    else:
        with tempfile.TemporaryDirectory() as work:
            dump(cluster, pathlib.Path(work))
            fresh_manifest, fresh_data, _ = load(pathlib.Path(work))
    differences = []
    committed_by_label = {e["label"]: e for e in committed["accounts"]}
    fresh_by_label = {e["label"]: e for e in fresh_manifest["accounts"]}
    for label in sorted(set(committed_by_label) | set(fresh_by_label)):
        old, new = committed_by_label.get(label), fresh_by_label.get(label)
        if old is None or new is None:
            differences.append(f"{label}: only in the {'fresh' if old is None else 'committed'} dump")
            continue
        if old["address"] != new["address"]:
            differences.append(f"{label}: address {old['address']} became {new['address']}")
        old_layout = layout(label, old["owner"], committed_data[label])
        new_layout = layout(label, new["owner"], fresh_data[label])
        for key in sorted(set(old_layout) | set(new_layout)):
            if old_layout.get(key) != new_layout.get(key):
                differences.append(f"{label}: {key} {old_layout.get(key)} became {new_layout.get(key)}")
    print(
        f"{cluster}: committed dump of slot {committed['slot']} against a fresh one of slot "
        f"{fresh_manifest['slot']}: {len(committed_by_label)} accounts compared"
    )
    if differences:
        print("The layout differs:", file=sys.stderr)
        for difference in differences:
            print(f"  {difference}", file=sys.stderr)
        print(
            "If Kamino changed its accounts on purpose, dump again (`dump --cluster "
            f"{cluster}`), run the tests against the new dump, and commit it with the spec's "
            "offsets checked against the new klend release.",
            file=sys.stderr,
        )
        return 1
    print("The layout matches.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("command", choices=["dump", "check"])
    parser.add_argument("--cluster", choices=["mainnet", "devnet"], required=True)
    parser.add_argument("--out", type=pathlib.Path, help="where `dump` writes (default: the committed copy)")
    parser.add_argument("--fresh", type=pathlib.Path, help="`check` against this dump instead of fetching one")
    args = parser.parse_args()
    if args.command == "dump":
        dump(args.cluster, args.out or COMMITTED / args.cluster)
        return 0
    return check(args.cluster, args.fresh)


if __name__ == "__main__":
    sys.exit(main())
