// The buy wall AMM's four keeper jobs: each due rule at its boundaries, and the transaction
// each builds (docs/spec/keeper-runner.md, "The jobs"; docs/spec/pool4-for-solana.md,
// "Keeper jobs").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AccountRole, address, generateKeyPairSigner, getBase64Decoder, type Address, type GetAccountInfoApi, type Rpc } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
    getMarketStateDecoder,
    getMarketStateEncoder,
    getMarketStateSize,
    BUY_WALL_AMM_PROGRAM_ADDRESS,
    DESIGNER_RECIPIENT,
    findVaultAuthorityPda,
    MARKET_STATE_DISCRIMINATOR,
    SUITE_TREASURY,
    WALL_THRESHOLD,
    type MarketState,
} from 'buy-wall-amm-scripts/client/index.ts';

import { buyWallAmm, buyWallAmmWith } from './buy-wall-amm.ts';

const Q = 1n << 64n;
const TOKEN = address('4gqiCkoxxD72nbXGc7XtxQx4UjBHD3KiJyXpMvEZ6u8c');
const WRAPPED_SOL = address('So11111111111111111111111111111111111111112');
const MARKET_STATE = address('GJaWKKtnFXs8CiVDz3WqFwK6hdAZ2VLwh4vpBbEAb9EU');
const TOKEN_VAULT = address('ACrn3UD4DLgyCKbNMiqx6Vcs2d49RSbHdbLJ82uw61s8');
const SOL_VAULT = address('C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w');
const FEE_RECIPIENT = address('FJ1PJovxT4Njfn3fkufxcKeCF8XtsPRAFLKadZZYXgDB');
const REWARDS_RECIPIENT = address('J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t');
/** The rent of a plain token account (165 bytes), and of a Token-2022 associated token account (170). */
const TOKEN_ACCOUNT_RENT = 2_039_280n;
const TOKEN_2022_ACCOUNT_RENT = 2_074_080n;

/** A little-endian unsigned integer of `bytes` bytes. */
function le(value: bigint, bytes: number): Uint8Array {
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) out[i] = Number((value >> BigInt(8 * i)) & 0xffn);
    return out;
}

type Fields = {
    status?: number;
    idleSol?: bigint;
    sqrtPrice?: bigint;
    wallLiquidity?: bigint;
    wallTop?: bigint;
    wallSolPlaced?: bigint;
    retiredTokens?: bigint;
    rewardsOwed?: bigint;
    feesRecipient?: bigint;
    feesDesigner?: bigint;
    feesSuite?: bigint;
};

/** An open buy wall market's account bytes, at price 1, with only the given ledgers set. */
function marketBytes(fields: Fields = {}): Uint8Array {
    const empty = new Uint8Array(getMarketStateSize());
    empty.set(MARKET_STATE_DISCRIMINATOR);
    const base: MarketState = getMarketStateDecoder().decode(empty);
    const state: MarketState = {
        ...base,
        layoutVersion: 1,
        status: fields.status ?? 2,
        tokenMint: TOKEN,
        wsolMint: WRAPPED_SOL,
        tokenVault: TOKEN_VAULT,
        solVault: SOL_VAULT,
        feeRecipient: FEE_RECIPIENT,
        rewardsRecipient: REWARDS_RECIPIENT,
        feeBps: le(100n, 2),
        sqrtPrice: le(fields.sqrtPrice ?? Q, 16),
        wallLiquidity: le(fields.wallLiquidity ?? 0n, 16),
        wallTop: le(fields.wallTop ?? 0n, 16),
        wallSolPlaced: le(fields.wallSolPlaced ?? 0n, 8),
        idleSol: le(fields.idleSol ?? 0n, 8),
        retiredTokens: le(fields.retiredTokens ?? 0n, 8),
        rewardsOwed: le(fields.rewardsOwed ?? 0n, 8),
        feesRecipient: le(fields.feesRecipient ?? 0n, 8),
        feesDesigner: le(fields.feesDesigner ?? 0n, 8),
        feesSuite: le(fields.feesSuite ?? 0n, 8),
    };
    return new Uint8Array(getMarketStateEncoder().encode(state));
}

const job = (name: string) => buyWallAmm.jobs.find((j) => j.name === name) ?? assert.fail(`no ${name} job`);
const due = (name: string, fields: Fields) => job(name).due(buyWallAmm.decode(marketBytes(fields)));
const dueKeys = (name: string, fields: Fields) => due(name, fields).map((unit) => unit.key);

/**
 * A wall placed at price 1 with `placed` lamports, at a price where it has spent `spent` of
 * them: W = placed (so it holds W x min(s, top) / Q lamports), and s lowered until it holds
 * `placed - spent`.
 */
function wallThatSpent(placed: bigint, spent: bigint): Fields {
    return { wallLiquidity: placed, wallTop: Q, wallSolPlaced: placed, sqrtPrice: ((placed - spent) * Q) / placed };
}

describe('place_wall', () => {
    test('is due once idle SOL reaches WALL_THRESHOLD, and not one lamport before', () => {
        assert.deepEqual(dueKeys('place_wall', { idleSol: WALL_THRESHOLD - 1n }), []);
        assert.deepEqual(dueKeys('place_wall', { idleSol: WALL_THRESHOLD }), ['place_wall']);
    });

    test("is due once the wall's converted SOL reaches WALL_THRESHOLD, and not one lamport before", () => {
        // A power of two, so the price lands exactly where the wall holds `placed - spent`.
        const placed = 1n << 26n;
        assert.deepEqual(dueKeys('place_wall', wallThatSpent(placed, WALL_THRESHOLD - 1n)), []);
        assert.deepEqual(dueKeys('place_wall', wallThatSpent(placed, WALL_THRESHOLD)), ['place_wall']);
    });

    test('is checked after each transaction and in every sweep', () => {
        assert.equal(job('place_wall').pass, 'sweep');
    });
});

describe('settle', () => {
    test('is due once a single token unit is retired, and not with none', () => {
        assert.deepEqual(dueKeys('settle', { retiredTokens: 0n }), []);
        assert.deepEqual(dueKeys('settle', { retiredTokens: 1n }), ['settle']);
    });

    test('runs in the hourly pass', () => {
        assert.equal(job('settle').pass, 'hourly');
    });
});

describe('pay_rewards', () => {
    test('is due once a single token unit of rewards is owed, and not with none', () => {
        assert.deepEqual(dueKeys('pay_rewards', { rewardsOwed: 0n }), []);
        assert.deepEqual(dueKeys('pay_rewards', { rewardsOwed: 1n }), ['pay_rewards']);
    });

    test('runs in the daily pass', () => {
        assert.equal(job('pay_rewards').pass, 'daily');
    });
});

describe('sweep_fees', () => {
    const DESIGNER = address('9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt');
    const designerSet = buyWallAmmWith({ designerRecipient: DESIGNER });
    const sweepsWith = (product: typeof buyWallAmm, fields: Fields) =>
        product.jobs.find((j) => j.name === 'sweep_fees')!.due(product.decode(marketBytes(fields)));

    test('is due for each fee slot once a single lamport is owed in it, and not with none, one transaction per slot', () => {
        assert.deepEqual(due('sweep_fees', {}), []);
        assert.deepEqual(dueKeys('sweep_fees', { feesRecipient: 1n }), ['sweep_fees:0']);
        assert.deepEqual(dueKeys('sweep_fees', { feesSuite: 1n }), ['sweep_fees:2']);
        assert.deepEqual(
            due('sweep_fees', { feesRecipient: 5n, feesSuite: 7n }).map(({ slot, owed }) => [slot, owed]),
            [
                [0, 5n],
                [2, 7n],
            ],
        );
    });

    test('skips slot 1 while DESIGNER_RECIPIENT is unset, as the deployed program has it', () => {
        assert.equal(DESIGNER_RECIPIENT, address('11111111111111111111111111111111'));
        assert.deepEqual(dueKeys('sweep_fees', { feesDesigner: 1_000_000n }), []);
        assert.deepEqual(dueKeys('sweep_fees', { feesRecipient: 1n, feesDesigner: 1_000_000n, feesSuite: 1n }), ['sweep_fees:0', 'sweep_fees:2']);
    });

    test('pays slot 1 once DESIGNER_RECIPIENT is set, from a single lamport', () => {
        assert.deepEqual(sweepsWith(designerSet, { feesDesigner: 0n }), []);
        assert.deepEqual(sweepsWith(designerSet, { feesDesigner: 1n }).map((unit) => unit.key), ['sweep_fees:1']);
        assert.deepEqual(
            sweepsWith(designerSet, { feesRecipient: 1n, feesDesigner: 1n, feesSuite: 1n }).map((unit) => unit.slot),
            [0, 1, 2],
        );
    });

    test('runs in the daily pass', () => {
        assert.equal(job('sweep_fees').pass, 'daily');
    });
});

describe('a market waiting for its seed', () => {
    test('has no job due, whatever its ledgers say', () => {
        const everything: Fields = { status: 1, idleSol: WALL_THRESHOLD, retiredTokens: 1n, rewardsOwed: 1n, feesRecipient: 1n, feesSuite: 1n };
        for (const { name } of buyWallAmm.jobs) assert.deepEqual(due(name, everything), [], name);
    });
});

/** An RPC that serves only the accounts given, each owned by `owner`, as `getAccountInfo` answers. */
function rpcWith(accounts: Map<Address, Address>): Rpc<GetAccountInfoApi> {
    return {
        getAccountInfo: (account: Address) => ({
            send: async () => {
                const owner = accounts.get(account);
                return {
                    context: { slot: 1n },
                    value: owner && { owner, data: [getBase64Decoder().decode(new Uint8Array(82)), 'base64'], executable: false, lamports: 1_000_000n, space: 82n },
                };
            },
        }),
    } as unknown as Rpc<GetAccountInfoApi>;
}

/** The token as a mint of `tokenProgram`, and whichever other accounts exist. */
const chainWith = (tokenProgram: Address, existing: Address[] = []) =>
    rpcWith(new Map([[TOKEN, tokenProgram], ...existing.map((account): [Address, Address] => [account, TOKEN_PROGRAM_ADDRESS])]));

async function built(name: string, fields: Fields, rpc = chainWith(TOKEN_PROGRAM_ADDRESS), product = buyWallAmm) {
    const payer = await generateKeyPairSigner();
    const state = product.decode(marketBytes(fields));
    const target = product.jobs.find((j) => j.name === name)!;
    const units = target.due(state);
    const input = { rpc, marketState: MARKET_STATE, state, unit: units[0]!, payer };
    return { payer, units, input, job: target, instructions: await target.build(input) };
}

const ataOf = async (owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM_ADDRESS) =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];
const accountsOf = (instruction: { accounts?: readonly { address: Address; role: AccountRole }[] }) => (instruction.accounts ?? []).map((meta) => meta.address);

describe('what each job sends', () => {
    test("place_wall tips the caller's own wrapped-SOL account, creating it in the same transaction if missing", async () => {
        const { payer, instructions } = await built('place_wall', { idleSol: WALL_THRESHOLD });
        const tipAccount = await ataOf(payer.address, WRAPPED_SOL);
        assert.equal(instructions.length, 2);
        const [create, place] = instructions;
        // The associated token program's CreateIdempotent (1): a no-op when the account exists.
        assert.equal(create!.programAddress, address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'));
        assert.deepEqual([...create!.data!], [1]);
        assert.deepEqual(accountsOf(create!).slice(0, 4), [payer.address, tipAccount, payer.address, WRAPPED_SOL]);
        assert.equal(place!.programAddress, BUY_WALL_AMM_PROGRAM_ADDRESS);
        const [vaultAuthority] = await findVaultAuthorityPda({ marketState: MARKET_STATE });
        assert.deepEqual(accountsOf(place!), [payer.address, MARKET_STATE, SOL_VAULT, tipAccount, WRAPPED_SOL, vaultAuthority, TOKEN_PROGRAM_ADDRESS]);
    });

    test("settle burns through the token's own program, signed by nobody but the fee payer", async () => {
        for (const tokenProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
            const { instructions } = await built('settle', { retiredTokens: 1n }, chainWith(tokenProgram));
            assert.equal(instructions.length, 1);
            const [vaultAuthority] = await findVaultAuthorityPda({ marketState: MARKET_STATE });
            assert.deepEqual(accountsOf(instructions[0]!), [MARKET_STATE, TOKEN_VAULT, TOKEN, vaultAuthority, tokenProgram]);
            assert.ok(instructions[0]!.accounts!.every((meta) => meta.role !== AccountRole.READONLY_SIGNER && meta.role !== AccountRole.WRITABLE_SIGNER));
        }
    });

    test("pay_rewards pays the rewards recipient's associated token account of the token's program", async () => {
        for (const tokenProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
            const { payer, instructions } = await built('pay_rewards', { rewardsOwed: 1n }, chainWith(tokenProgram));
            const accounts = accountsOf(instructions[0]!);
            assert.equal(accounts[0], payer.address);
            assert.equal(accounts[4], REWARDS_RECIPIENT);
            assert.equal(accounts[5], await ataOf(REWARDS_RECIPIENT, TOKEN, tokenProgram));
            assert.ok(accounts.includes(tokenProgram));
        }
    });

    test("sweep_fees pays each slot's wallet's wrapped-SOL account: the fee recipient, the designer, the suite treasury", async () => {
        const DESIGNER = address('9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt');
        const product = buyWallAmmWith({ designerRecipient: DESIGNER });
        const state = product.decode(marketBytes({ feesRecipient: 1n, feesDesigner: 1n, feesSuite: 1n }));
        const sweep = product.jobs.find((j) => j.name === 'sweep_fees')!;
        const payer = await generateKeyPairSigner();
        const wallets = [FEE_RECIPIENT, DESIGNER, SUITE_TREASURY];
        for (const unit of sweep.due(state)) {
            const [instruction] = await sweep.build({ rpc: chainWith(TOKEN_PROGRAM_ADDRESS), marketState: MARKET_STATE, state, unit, payer });
            const accounts = accountsOf(instruction!);
            assert.equal(accounts[4], wallets[unit.slot!]);
            assert.equal(accounts[5], await ataOf(wallets[unit.slot!]!, WRAPPED_SOL));
            // The slot is the instruction's one argument, after its 8-byte discriminator.
            assert.equal(instruction!.data![8], unit.slot);
        }
    });
});

describe('a payout into an account that does not exist yet', () => {
    // A payout creates a missing account at the caller's expense, so it waits until what it
    // pays is worth that rent (docs/spec/pool4-for-solana.md, "For the keeper runner").
    const skip = async (name: string, fields: Fields, rpc: Rpc<GetAccountInfoApi>) => {
        const { job: target, input } = await built(name, fields, rpc);
        return target.skipReason!(input);
    };

    test('sweep_fees waits while the ledger is worth less than the rent, and goes from exactly the rent', async () => {
        const missing = chainWith(TOKEN_PROGRAM_ADDRESS);
        assert.match((await skip('sweep_fees', { feesRecipient: TOKEN_ACCOUNT_RENT - 1n }, missing)) ?? '', /rent/);
        assert.equal(await skip('sweep_fees', { feesRecipient: TOKEN_ACCOUNT_RENT }, missing), null);
    });

    test('sweep_fees pays any amount into an account that exists', async () => {
        const exists = chainWith(TOKEN_PROGRAM_ADDRESS, [await ataOf(FEE_RECIPIENT, WRAPPED_SOL)]);
        assert.equal(await skip('sweep_fees', { feesRecipient: 1n }, exists), null);
    });

    test("pay_rewards values the rewards at the market's price against the rent of the token program's account", async () => {
        // At price 1 a token unit is worth a lamport; at price 4 (sqrt 2) four.
        const missing = chainWith(TOKEN_PROGRAM_ADDRESS);
        assert.match((await skip('pay_rewards', { rewardsOwed: TOKEN_ACCOUNT_RENT - 1n }, missing)) ?? '', /rent/);
        assert.equal(await skip('pay_rewards', { rewardsOwed: TOKEN_ACCOUNT_RENT }, missing), null);
        assert.match((await skip('pay_rewards', { rewardsOwed: TOKEN_ACCOUNT_RENT / 4n - 1n, sqrtPrice: 2n * Q }, missing)) ?? '', /rent/);
        assert.equal(await skip('pay_rewards', { rewardsOwed: TOKEN_ACCOUNT_RENT / 4n, sqrtPrice: 2n * Q }, missing), null);
        const missing2022 = chainWith(TOKEN_2022_PROGRAM_ADDRESS);
        assert.match((await skip('pay_rewards', { rewardsOwed: TOKEN_2022_ACCOUNT_RENT - 1n }, missing2022)) ?? '', /rent/);
        assert.equal(await skip('pay_rewards', { rewardsOwed: TOKEN_2022_ACCOUNT_RENT }, missing2022), null);
    });

    test('pay_rewards pays any amount into an account that exists', async () => {
        const exists = chainWith(TOKEN_PROGRAM_ADDRESS, [await ataOf(REWARDS_RECIPIENT, TOKEN)]);
        assert.equal(await skip('pay_rewards', { rewardsOwed: 1n }, exists), null);
    });
});
