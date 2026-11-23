// The freeze gate's decisions (docs/spec/containment-hook.md, "Upgrade policy"; HOOK-51,
// hardening findings H016 to H018 of #74), kept free of any RPC so they are tested on their
// own (freeze.test.ts): whether a contained mint's transfer hook fields agree with its config,
// what the BPF upgradeable loader's accounts say about a program's upgrade authority, and the
// loader's `SetAuthority` instruction that freezes a program.

import { AccountRole, getAddressDecoder, type Address, type Instruction } from '@solana/kit';

/** The address Token-2022 stores for an unset transfer hook program or authority. */
export const UNSET = '11111111111111111111111111111111';
export const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;

/** A mint's transfer hook extension, or undefined when the mint carries none. */
export type MintHook = { programId: string; authority: string } | undefined;

export type MintVerdict = { ok: true; state: 'contained' | 'unlocked' } | { ok: false; reason: string };

/**
 * Judges one contained mint against its hook config. While the config's `unlocked_at` is none,
 * the mint's transfer hook program must be the hook and its authority the mint's unlock PDA
 * ["unlock", mint] under the hook, so only the hook's own `unlock` can ever change them; once
 * `unlocked_at` is set, both must be unset, as `unlock` leaves them. Anything else means the
 * fields were changed some other way, such as by an upgraded hook signing as the unlock PDA,
 * which a later freeze would not undo.
 */
export function judgeMint({ hook, unlockPda, mintHook, unlockedAt }: { hook: string; unlockPda: string; mintHook: MintHook; unlockedAt: bigint | null }): MintVerdict {
    if (mintHook === undefined) return { ok: false, reason: 'the mint carries no transfer hook extension' };
    const { programId, authority } = mintHook;
    if (unlockedAt === null) {
        const problems: string[] = [];
        if (programId !== hook) problems.push(`its transfer hook program is ${programId === UNSET ? 'unset' : programId}, not the hook ${hook}`);
        if (authority !== unlockPda) problems.push(`its transfer hook authority is ${authority === UNSET ? 'unset' : authority}, not its unlock PDA ${unlockPda}`);
        return problems.length > 0 ? { ok: false, reason: `contained (unlocked_at none), but ${problems.join(' and ')}` } : { ok: true, state: 'contained' };
    }
    const problems: string[] = [];
    if (programId !== UNSET) problems.push(`its transfer hook program is still ${programId}`);
    if (authority !== UNSET) problems.push(`its transfer hook authority is still ${authority}`);
    return problems.length > 0 ? { ok: false, reason: `unlocked at ${unlockedAt}, but ${problems.join(' and ')}` } : { ok: true, state: 'unlocked' };
}

/** The loader's `UpgradeableLoaderState` tags, a little-endian u32 at the start of each account. */
const PROGRAM_TAG = 2;
const PROGRAM_DATA_TAG = 3;
/** `SetAuthority`, the loader instruction's tag. */
const SET_AUTHORITY = 4;

/** The program data account a program account of the upgradeable loader points at. */
export function programDataAddressOf(programAccount: Uint8Array): Address {
    if (programAccount.length < 36 || new DataView(programAccount.buffer, programAccount.byteOffset).getUint32(0, true) !== PROGRAM_TAG) {
        throw new Error('not an upgradeable loader Program account');
    }
    return getAddressDecoder().decode(programAccount.subarray(4, 36));
}

/** The upgrade authority a program data account records, or null when the program is frozen. */
export function upgradeAuthorityOf(programData: Uint8Array): Address | null {
    // Tag (4), the slot it was last deployed in (8), then an Option<Pubkey>: a tag byte and 32 bytes.
    if (programData.length < 13 || new DataView(programData.buffer, programData.byteOffset).getUint32(0, true) !== PROGRAM_DATA_TAG) {
        throw new Error('not an upgradeable loader ProgramData account');
    }
    const tag = programData[12];
    if (tag === 0) return null;
    if (tag !== 1 || programData.length < 45) throw new Error(`ProgramData's upgrade authority option has tag ${tag}`);
    return getAddressDecoder().decode(programData.subarray(13, 45));
}

/**
 * The loader's `SetAuthority` with no new authority: it removes the program's upgrade
 * authority for good, signed by the current one (what `solana program set-upgrade-authority
 * --final` sends).
 */
export function freezeInstruction(programData: Address, currentAuthority: Address): Instruction {
    const data = new Uint8Array(4);
    new DataView(data.buffer).setUint32(0, SET_AUTHORITY, true);
    return {
        programAddress: BPF_UPGRADEABLE_LOADER,
        accounts: [
            { address: programData, role: AccountRole.WRITABLE },
            { address: currentAuthority, role: AccountRole.READONLY_SIGNER },
        ],
        data,
    };
}

