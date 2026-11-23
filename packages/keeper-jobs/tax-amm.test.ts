// The tax AMM's keeper job: `distribute`, one transaction per owed slot, the burn slot
// included (docs/spec/keeper-runner.md, "The jobs").

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
    AccountRole,
    address,
    generateKeyPairSigner,
    getBase64Decoder,
    some,
    type Address,
    type GetAccountInfoApi,
    type Rpc,
} from '@solana/kit';
import { findAssociatedTokenPda, getMintEncoder as getSplMintEncoder, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
    extension,
    findExtraAccountMetaListPda,
    getExtraAccountMetasEncoder,
    getMintEncoder as getToken2022MintEncoder,
    TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import {
    BURN_SLOT,
    getTaxMarketEncoder,
    MarketStatus,
    SUITE_SLOT,
    SUITE_TREASURY,
    TAX_AMM_PROGRAM_ADDRESS,
    type TaxMarketArgs,
} from 'tax-amm-scripts/client/index.ts';

import { taxAmm } from './tax-amm.ts';

const DEFAULT_ADDRESS = address('11111111111111111111111111111111');
const WRAPPED_SOL = address('So11111111111111111111111111111111111111112');
const TOKEN = address('4gqiCkoxxD72nbXGc7XtxQx4UjBHD3KiJyXpMvEZ6u8c');
const RECIPIENT_1 = address('9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt');
const RECIPIENT_2 = address('ACrn3UD4DLgyCKbNMiqx6Vcs2d49RSbHdbLJ82uw61s8');
const MARKET_STATE = address('FJ1PJovxT4Njfn3fkufxcKeCF8XtsPRAFLKadZZYXgDB');

/** A tax market's account bytes, as the program stores them, owing `owed` per slot. */
function marketBytes(owed: readonly bigint[], overrides: Partial<TaxMarketArgs> = {}): Uint8Array {
    const args: TaxMarketArgs = {
        version: 1,
        status: MarketStatus.Open,
        taxSide: 1,
        virtualSide: 0,
        authorityBump: 255,
        taxAuthorityRenounced: false,
        mints: [TOKEN, WRAPPED_SOL],
        vaults: [address('BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6'), address('J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t')],
        marketSigner: address('C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w'),
        buyTaxBps: 300,
        sellTaxBps: 500,
        buyTaxMinBps: 100,
        buyTaxMaxBps: 800,
        sellTaxMinBps: 0,
        sellTaxMaxBps: 900,
        taxAuthority: RECIPIENT_1,
        seeder: RECIPIENT_1,
        recipients: [RECIPIENT_1, RECIPIENT_2, DEFAULT_ADDRESS, DEFAULT_ADDRESS],
        shares: [6_000, 4_000, 0, 0],
        burnShareBps: 0,
        virtualReserve: 0n,
        reserves: [100_000_000_000n, 500_000_000n],
        owed: [...owed],
        taxCollected: 0n,
        volume: [0n, 0n],
        swapCount: 0n,
        createdSlot: 1n,
        createdAt: 1n,
        pendingBuyTaxBps: 0,
        pendingSellTaxBps: 0,
        pendingFromSlot: 0n,
        reserved: new Uint8Array(52),
        ...overrides,
    };
    return new Uint8Array(getTaxMarketEncoder().encode(args));
}

const HOOK_PROGRAM = address('HooKqPSe7g1bdzwT1h3zxh5i8Rv8Wc1Q6R5z1iEv3DxR');

/** An RPC that serves only the accounts given, as `getAccountInfo` answers them. */
function rpcWith(accounts: Map<Address, { owner: Address; data: Uint8Array }>): Rpc<GetAccountInfoApi> {
    return {
        getAccountInfo: (account: Address) => ({
            send: async () => {
                const found = accounts.get(account);
                return {
                    context: { slot: 1n },
                    value: found && {
                        owner: found.owner,
                        data: [getBase64Decoder().decode(found.data), 'base64'],
                        executable: false,
                        lamports: 1_000_000n,
                        space: BigInt(found.data.length),
                    },
                };
            },
        }),
    } as unknown as Rpc<GetAccountInfoApi>;
}

const mintArgs = { mintAuthority: null, supply: 1_000_000n, decimals: 6, isInitialized: true, freezeAuthority: null };
const splMint = () => ({ owner: TOKEN_PROGRAM_ADDRESS, data: new Uint8Array(getSplMintEncoder().encode(mintArgs)) });
/** Both mints of the fixture market, wrapped SOL and the token, as SPL Token mints. */
const plainMints = () => rpcWith(new Map<Address, { owner: Address; data: Uint8Array }>([[WRAPPED_SOL, splMint()], [TOKEN, splMint()]]));

const distribute = taxAmm.jobs.find((job) => job.name === 'distribute')!;
const dueSlots = (data: Uint8Array) => distribute.due(taxAmm.decode(data)).map((unit) => unit.slot);

describe('the tax AMM entry', () => {
    test('recognises a tax market account of its program, and nothing else', () => {
        assert.equal(taxAmm.programAddress, TAX_AMM_PROGRAM_ADDRESS);
        assert.equal(taxAmm.isMarket(marketBytes([0n, 0n, 0n, 0n, 0n, 0n])), true);
        assert.equal(taxAmm.isMarket(new Uint8Array(marketBytes([0n, 0n, 0n, 0n, 0n, 0n]).length)), false);
        assert.equal(taxAmm.isMarket(marketBytes([0n, 0n, 0n, 0n, 0n, 0n]).slice(0, 100)), false);
    });

    test('runs distribute in the daily pass', () => {
        assert.equal(distribute.pass, 'daily');
    });
});

describe("distribute's due rule", () => {
    test('a market owed nothing has no job due', () => {
        assert.deepEqual(dueSlots(marketBytes([0n, 0n, 0n, 0n, 0n, 0n])), []);
    });

    test('a slot owed 1 unit is due, and only that slot', () => {
        assert.deepEqual(dueSlots(marketBytes([0n, 1n, 0n, 0n, 0n, 0n])), [1]);
        assert.deepEqual(dueSlots(marketBytes([0n, 0n, 0n, 0n, 0n, 1n])), [SUITE_SLOT]);
    });

    test('every slot is due when every slot is owed, the burn slot included', () => {
        const allRecipients = [RECIPIENT_1, RECIPIENT_2, address('CbqE9TtDJf67xFnXybBrzV6Tg4Mw71hX2VhWcm4R9VZF'), TOKEN];
        const data = marketBytes([1n, 2n, 3n, 4n, 5n, 6n], {
            recipients: allRecipients,
            shares: [2_000, 2_000, 2_000, 2_000],
            burnShareBps: 2_000,
            mints: [WRAPPED_SOL, TOKEN],
        });
        const due = distribute.due(taxAmm.decode(data));
        assert.deepEqual(due.map((unit) => unit.slot), [0, 1, 2, 3, BURN_SLOT, SUITE_SLOT]);
        assert.deepEqual(due.map((unit) => unit.owed), [1n, 2n, 3n, 4n, 5n, 6n]);
        assert.deepEqual(due.map((unit) => unit.key), ['distribute:0', 'distribute:1', 'distribute:2', 'distribute:3', 'distribute:4', 'distribute:5']);
    });

    test('an unused recipient slot is never due, since the program refuses to pay it', () => {
        assert.deepEqual(dueSlots(marketBytes([0n, 0n, 7n, 0n, 0n, 0n])), []);
    });
});

describe("distribute's instruction", () => {
    test("pays a recipient slot to the slot wallet's token account, with the mint read-only", async () => {
        const payer = await generateKeyPairSigner();
        const data = marketBytes([5n, 0n, 0n, 0n, 0n, 0n]);
        const state = taxAmm.decode(data);
        const [unit] = distribute.due(state);
        const [instruction] = await distribute.build({ rpc: plainMints(), marketState: MARKET_STATE, state, unit: unit!, payer });
        assert.equal(instruction!.programAddress, TAX_AMM_PROGRAM_ADDRESS);
        const accounts = instruction!.accounts!;
        assert.equal(accounts[0]!.address, payer.address);
        assert.equal(accounts[1]!.address, MARKET_STATE);
        assert.equal(accounts[3]!.address, state.vaults[1]);
        assert.equal(accounts[4]!.address, WRAPPED_SOL);
        assert.equal(accounts[4]!.role, AccountRole.READONLY);
        assert.equal(accounts[5]!.address, RECIPIENT_1);
        const [ata] = await findAssociatedTokenPda({ owner: RECIPIENT_1, mint: WRAPPED_SOL, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        assert.equal(accounts[6]!.address, ata);
        assert.equal(accounts[7]!.address, TOKEN_PROGRAM_ADDRESS);
        assert.equal(accounts.length, 10);
        assert.equal(instruction!.data![8], 0);
    });

    test("forwards a hooked tax-side mint's transfer-hook accounts after the payout's own", async () => {
        const payer = await generateKeyPairSigner();
        const hooked = address('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
        const [validation] = await findExtraAccountMetaListPda({ mint: hooked }, { programAddress: HOOK_PROGRAM });
        const rpc = rpcWith(
            new Map<Address, { owner: Address; data: Uint8Array }>([
                [
                    hooked,
                    {
                        owner: TOKEN_2022_PROGRAM_ADDRESS,
                        data: new Uint8Array(
                            getToken2022MintEncoder().encode({
                                ...mintArgs,
                                extensions: some([extension('TransferHook', { authority: RECIPIENT_1, programId: HOOK_PROGRAM })]),
                            }),
                        ),
                    },
                ],
                [validation, { owner: HOOK_PROGRAM, data: new Uint8Array(getExtraAccountMetasEncoder().encode([])) }],
            ]),
        );
        const state = taxAmm.decode(marketBytes([0n, 4n, 0n, 0n, 0n, 0n], { mints: [TOKEN, hooked] }));
        const [unit] = distribute.due(state);
        const [instruction] = await distribute.build({ rpc, marketState: MARKET_STATE, state, unit: unit!, payer });
        const accounts = instruction!.accounts!;
        const [ata] = await findAssociatedTokenPda({ owner: RECIPIENT_2, mint: hooked, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
        assert.equal(accounts[6]!.address, ata);
        assert.equal(accounts[7]!.address, TOKEN_2022_PROGRAM_ADDRESS);
        assert.deepEqual(accounts.slice(10), [
            { address: HOOK_PROGRAM, role: AccountRole.READONLY },
            { address: validation, role: AccountRole.READONLY },
        ]);
    });

    test('pays the suite share to the suite treasury', async () => {
        const payer = await generateKeyPairSigner();
        const state = taxAmm.decode(marketBytes([0n, 0n, 0n, 0n, 0n, 9n]));
        const [unit] = distribute.due(state);
        const [instruction] = await distribute.build({ rpc: plainMints(), marketState: MARKET_STATE, state, unit: unit!, payer });
        assert.equal(instruction!.accounts![5]!.address, SUITE_TREASURY);
        assert.equal(instruction!.data![8], SUITE_SLOT);
    });

    test('burns the burn slot with the mint writable and the default key as its wallet', async () => {
        const payer = await generateKeyPairSigner();
        const state = taxAmm.decode(marketBytes([0n, 0n, 0n, 0n, 3n, 0n], { mints: [WRAPPED_SOL, TOKEN], burnShareBps: 1_000, shares: [5_000, 4_000, 0, 0] }));
        const [unit] = distribute.due(state);
        const [instruction] = await distribute.build({ rpc: plainMints(), marketState: MARKET_STATE, state, unit: unit!, payer });
        assert.equal(instruction!.accounts![4]!.address, TOKEN);
        assert.equal(instruction!.accounts![4]!.role, AccountRole.WRITABLE);
        assert.equal(instruction!.accounts![5]!.address, DEFAULT_ADDRESS);
        assert.equal(instruction!.data![8], BURN_SLOT);
    });
});

describe('what counts as nothing to do', () => {
    // distribute on a slot owed nothing is not refused: it succeeds and moves nothing
    // (TAX-43). So a simulation that emits no Distributed event for the slot did nothing,
    // which is how a second keeper paying first shows.
    test('a simulation with no Distributed event did nothing', () => {
        assert.equal(distribute.refusals.nothingToDo.length, 0);
        assert.equal(distribute.didNothing!(['Program J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t success']), true);
    });

    test('a simulation with a Distributed event paid the slot', () => {
        const event = new Uint8Array(8 + 32 + 1 + 32 + 8);
        event.set([10, 212, 24, 78, 35, 202, 182, 134]);
        assert.equal(distribute.didNothing!([`Program data: ${Buffer.from(event).toString('base64')}`]), false);
    });
});
