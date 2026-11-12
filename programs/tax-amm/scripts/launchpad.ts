// The stand-in launchpad (programs/test-programs/stand-in-launchpad), as the demo calls it
// on a local validator: a test program, never deployed to devnet, that graduates a creator's
// two escrowed mints into a strategy through its `pipeline_seed_liquidity`, with the
// creator's seeder PDA signing. scripts/local-validator.sh loads it at its declare_id!
// address. The program's own doc comment says what each instruction checks.

import {
    AccountRole,
    addEncoderSizePrefix,
    address,
    getAddressEncoder,
    getArrayDecoder,
    getArrayEncoder,
    getBytesEncoder,
    getProgramDerivedAddress,
    getStructDecoder,
    getStructEncoder,
    getU32Encoder,
    getU64Decoder,
    getU64Encoder,
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

/** `graduate`'s arguments after its discriminator, Borsh-encoded. */
const graduateArgs = getStructEncoder([
    ['amounts', getArrayEncoder(getU64Encoder())],
    ['data', addEncoderSizePrefix(getBytesEncoder(), getU32Encoder())],
    ['maxPayerLamports', getU64Encoder()],
]);

/** `graduate`'s return data, Borsh-decoded. */
const graduationDecoder = getStructDecoder([
    ['taken', getArrayDecoder(getU64Decoder())],
    ['lpAmount', getU64Decoder()],
    ['leftEscrows', getArrayDecoder(getU64Decoder())],
]);

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
    const discriminator = await pipeline.anchorDiscriminator('graduate');
    const args = graduateArgs.encode({
        amounts: [...input.amounts],
        data: input.data,
        maxPayerLamports: input.maxPayerLamports,
    });
    const data = new Uint8Array(discriminator.length + args.length);
    data.set(discriminator);
    data.set(args, discriminator.length);
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

/**
 * Decodes `graduate`'s return data from a transaction's "Program return:" log line, or
 * returns null when there is none or it is not exactly a `Graduation`.
 */
export function graduationFromLogs(logs: readonly string[]): Graduation | null {
    const prefix = `Program return: ${LAUNCHPAD_PROGRAM_ADDRESS} `;
    const line = logs.find((entry) => entry.startsWith(prefix));
    if (!line) return null;
    const bytes = new Uint8Array(Buffer.from(line.slice(prefix.length), 'base64'));
    try {
        const [graduation, read] = graduationDecoder.read(bytes, 0);
        return read === bytes.length ? graduation : null;
    } catch {
        return null;
    }
}
