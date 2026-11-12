// The stand-in launchpad (programs/test-programs/stand-in-launchpad), as the demo calls it
// on a local validator: a test program, never deployed to devnet, that graduates a creator's
// two escrowed mints into a strategy through its `pipeline_seed_liquidity`, with the
// creator's seeder PDA signing. scripts/local-validator.sh loads it at its declare_id!
// address. The program's own doc comment says what each instruction checks.

import {
    AccountRole,
    address,
    getAddressEncoder,
    getProgramDerivedAddress,
    type AccountMeta,
    type Address,
    type Instruction,
} from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import * as pipeline from '@pipeline-placeholder/sdk';

/** The launchpad's `declare_id!`. */
export const LAUNCHPAD_PROGRAM_ADDRESS = address('StandinLaunchpad111111111111111111111111111');

const utf8 = new TextEncoder();

/** A creator's launch's seeder, `["seeder", creator]`: it owns the escrows and signs the seed. */
export async function findSeederPda(creator: Address): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
        programAddress: LAUNCHPAD_PROGRAM_ADDRESS,
        seeds: [utf8.encode('seeder'), getAddressEncoder().encode(creator)],
    });
    return pda;
}

/** The payer a seeder's graduation lends the strategy for rent, `["payer", seeder]`. */
export async function findPayerPda(seeder: Address): Promise<Address> {
    const [pda] = await getProgramDerivedAddress({
        programAddress: LAUNCHPAD_PROGRAM_ADDRESS,
        seeds: [utf8.encode('payer'), getAddressEncoder().encode(seeder)],
    });
    return pda;
}

function u32(value: number): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return bytes;
}

function u64(value: bigint): Uint8Array {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return bytes;
}

/**
 * `graduate { amounts, data, max_payer_lamports }`. `accounts` are the strategy's
 * `pipeline_seed_liquidity` accounts after the seeder, the payer and the system program:
 * the market state, the LP recipient, mint, escrow and token program per mint, then the
 * strategy's own accounts and any transfer-hook accounts.
 */
export async function graduateInstruction(input: {
    creator: Address;
    strategyProgram: Address;
    amounts: readonly bigint[];
    data: Uint8Array;
    maxPayerLamports: bigint;
    accounts: readonly AccountMeta[];
}): Promise<Instruction> {
    const seeder = await findSeederPda(input.creator);
    const parts = [
        await pipeline.anchorDiscriminator('graduate'),
        u32(input.amounts.length),
        ...input.amounts.map(u64),
        u32(input.data.length),
        input.data,
        u64(input.maxPayerLamports),
    ];
    const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        data.set(part, offset);
        offset += part.length;
    }
    return {
        programAddress: LAUNCHPAD_PROGRAM_ADDRESS,
        accounts: [
            { address: input.creator, role: AccountRole.WRITABLE_SIGNER },
            { address: seeder, role: AccountRole.READONLY },
            { address: await findPayerPda(seeder), role: AccountRole.WRITABLE },
            { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
            { address: input.strategyProgram, role: AccountRole.READONLY },
            ...input.accounts,
        ],
        data,
    };
}

/** `graduate`'s return data: the strategy's `SeedResult` beside what left each escrow. */
export type Graduation = { taken: bigint[]; lpAmount: bigint; leftEscrows: bigint[] };

/** Decodes `graduate`'s return data from a transaction's "Program return:" log line. */
export function graduationFromLogs(logs: readonly string[]): Graduation | null {
    const prefix = `Program return: ${LAUNCHPAD_PROGRAM_ADDRESS} `;
    const line = logs.find((entry) => entry.startsWith(prefix));
    if (!line) return null;
    const bytes = new Uint8Array(Buffer.from(line.slice(prefix.length), 'base64'));
    const view = new DataView(bytes.buffer);
    let offset = 0;
    const readU64s = () => {
        const length = view.getUint32(offset, true);
        offset += 4;
        return Array.from({ length }, () => {
            const value = view.getBigUint64(offset, true);
            offset += 8;
            return value;
        });
    };
    const taken = readU64s();
    const lpAmount = view.getBigUint64(offset, true);
    offset += 8;
    const leftEscrows = readU64s();
    return offset === bytes.length ? { taken, lpAmount, leftEscrows } : null;
}
