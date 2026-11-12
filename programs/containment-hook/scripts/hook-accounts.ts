// The hook accounts every transfer of a hooked mint needs, resolved from the mint's
// validation account as Token-2022 resolves them (docs/spec/containment-hook.md, "Hook
// accounts callers must pass"): the hook program, the validation account, then each extra
// account the validation account lists for `Execute`. Neither Pipeline client resolves them,
// so the launch script, and later Aviary, build them here and pass them to the SDK: as the
// router's input hook accounts on a sell, after the strategy's accounts on a buy, as
// `sweep_fees`'s remaining accounts and after the tax AMM's own accounts on its `seed`.
//
// It reads the transfer hook interface's extra-account-meta list: one type-length-value entry
// whose type is `Execute`'s discriminator, holding a count and 35-byte entries (a kind, 32
// bytes of address configuration, signer, writable). It understands fixed addresses and PDAs
// of the hook program whose seeds are literals or keys of `Execute`'s accounts, which is what
// the containment hook writes, and refuses anything else rather than guess.

import { AccountRole, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type AccountMeta, type Address } from '@solana/kit';

/** `sha256("spl-transfer-hook-interface:execute")[..8]`. */
const EXECUTE_DISCRIMINATOR = [105, 37, 101, 197, 75, 251, 102, 26];
const ENTRY_LEN = 35;
const KIND_FIXED = 0;
const KIND_PDA_OF_HOOK = 1;
const SEED_END = 0;
const SEED_LITERAL = 1;
const SEED_ACCOUNT_KEY = 3;

/** One transfer, as `Execute` sees it: its first four accounts. */
export type HookTransfer = { source: Address; mint: Address; destination: Address; authority: Address };

/** The validation account's address for `mint`: `["extra-account-metas", mint]`. */
export async function validationAddress(hookProgram: Address, mint: Address): Promise<Address> {
    const [address] = await getProgramDerivedAddress({
        programAddress: hookProgram,
        seeds: [new TextEncoder().encode('extra-account-metas'), getAddressEncoder().encode(mint)],
    });
    return address;
}

/**
 * The hook accounts for `transfer`: the hook program and the validation account, read-only,
 * then the extra accounts in list order with the roles the list gives them. `validationData`
 * is the validation account's data.
 */
export async function resolveHookAccounts(
    hookProgram: Address,
    transfer: HookTransfer,
    validationData: Uint8Array,
): Promise<AccountMeta[]> {
    const validation = await validationAddress(hookProgram, transfer.mint);
    const keys: Address[] = [transfer.source, transfer.mint, transfer.destination, transfer.authority, validation];
    const view = new DataView(validationData.buffer, validationData.byteOffset, validationData.byteLength);
    if (validationData.length < 16 || EXECUTE_DISCRIMINATOR.some((byte, i) => validationData[i] !== byte)) {
        throw new Error(`the validation account ${validation} holds no Execute entry`);
    }
    const length = view.getUint32(8, true);
    const count = view.getUint32(12, true);
    if (length !== 4 + count * ENTRY_LEN || validationData.length < 12 + length) {
        throw new Error(`the validation account ${validation} is malformed`);
    }
    const extras: AccountMeta[] = [];
    for (let i = 0; i < count; i++) {
        const entry = validationData.subarray(16 + i * ENTRY_LEN, 16 + (i + 1) * ENTRY_LEN);
        const config = entry.subarray(1, 33);
        let address: Address;
        if (entry[0] === KIND_FIXED) {
            address = getAddressDecoder().decode(config);
        } else if (entry[0] === KIND_PDA_OF_HOOK) {
            [address] = await getProgramDerivedAddress({ programAddress: hookProgram, seeds: seeds(config, keys) });
        } else {
            throw new Error(`the validation account ${validation} lists an extra account of kind ${entry[0]}, which this resolver does not read`);
        }
        const signer = entry[33] !== 0;
        const writable = entry[34] !== 0;
        if (signer) throw new Error(`the validation account ${validation} asks for a signer`);
        extras.push({ address, role: writable ? AccountRole.WRITABLE : AccountRole.READONLY });
        keys.push(address);
    }
    return [
        { address: hookProgram, role: AccountRole.READONLY },
        { address: validation, role: AccountRole.READONLY },
        ...extras,
    ];
}

/** The seeds an address configuration packs: literals and keys of accounts before it. */
function seeds(config: Uint8Array, keys: readonly Address[]): Uint8Array[] {
    const out: Uint8Array[] = [];
    let at = 0;
    while (at < config.length && config[at] !== SEED_END) {
        if (config[at] === SEED_LITERAL) {
            const len = config[at + 1]!;
            out.push(config.slice(at + 2, at + 2 + len));
            at += 2 + len;
        } else if (config[at] === SEED_ACCOUNT_KEY) {
            const key = keys[config[at + 1]!];
            if (!key) throw new Error(`a seed names account ${config[at + 1]}, which Execute does not have yet`);
            out.push(new Uint8Array(getAddressEncoder().encode(key)));
            at += 2;
        } else {
            throw new Error(`a seed of kind ${config[at]}, which this resolver does not read`);
        }
    }
    return out;
}
