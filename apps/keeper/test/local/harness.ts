// What the runner tests need from a local validator running devnet's router and the tax AMM,
// after the tax AMM's local demo run has registered the strategy (apps/keeper/README.md,
// "Testing"): funded wallets, tax markets created from the metadata as Aviary will create them,
// swaps through the router that leave tax owed, and a runner on a fake clock.
//
// LOCAL_VALIDATOR_URL names the validator (default http://127.0.0.1:8899); its socket is the
// next port, as solana-test-validator opens it.

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
    address,
    addSignersToTransactionMessage,
    appendTransactionMessageInstructions,
    createSolanaRpc,
    createTransactionMessage,
    generateKeyPairSigner,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type Address,
    type Instruction,
    type KeyPairSigner,
    type Signature,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
    AuthorityType,
    fetchToken,
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getInitializeMint2Instruction,
    getMintSize,
    getMintToInstruction,
    getSetAuthorityInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
    ExtensionType,
    getDisableMemoTransfersInstruction,
    getEnableMemoTransfersInstruction,
    getReallocateInstruction,
    TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import * as pipeline from '@pipeline-placeholder/sdk';
import { taxAmm, type AnyKeeperProduct } from 'keeper-jobs';
import { buildActionInstruction, findAction } from 'strategy-actions';
import { fetchTaxMarket, findVault0Pda, findVault1Pda, TAX_AMM_PROGRAM_ADDRESS, type TaxMarket } from 'tax-amm-scripts/client/index.ts';
import { termsArg, termsHash } from 'tax-amm-scripts/terms.ts';

import { rpcChain, type Chain } from '../../src/chain.ts';
import { FakeClock } from '../../src/clock.ts';
import { MemoryLogger, type Row } from '../../src/log.ts';
import type { Heartbeat } from '../../src/heartbeat.ts';
import type { Recorder } from '../../src/record.ts';
import { Runner } from '../../src/runner.ts';
import { loadSettings } from '../../src/settings.ts';

export const LOCAL_URL = process.env.LOCAL_VALIDATOR_URL ?? 'http://127.0.0.1:8899';
export const LOCAL_WS_URL = (() => {
    const url = new URL(LOCAL_URL);
    url.protocol = 'ws:';
    url.port = String(Number(url.port || 8899) + 1);
    return url.toString();
})();

export const rpc = createSolanaRpc(LOCAL_URL);
const DEFAULT_ADDRESS = address('11111111111111111111111111111111');
const MAX_CREATOR_LAMPORTS = 100_000_000n;
export const DAY_MS = 86_400_000;

const metadata = (() => {
    const path = fileURLToPath(new URL('../../../../programs/tax-amm/metadata.json', import.meta.url));
    const parsed = pipeline.parseStrategyMetadata(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.ok) throw new Error(`the tax AMM's metadata.json is invalid: ${parsed.errors.join('; ')}`);
    return parsed.value;
})();

/** Refuses to run unless the validator is local. */
export function checkLocalHost() {
    const host = new URL(LOCAL_URL).hostname;
    if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error(`LOCAL_VALIDATOR_URL must be a local validator, not ${LOCAL_URL}`);
}

/** Refuses to run unless the validator is local and the tax AMM is registered with its router. */
export async function checkLocalValidator() {
    checkLocalHost();
    const strategy = await rpc.getAccountInfo(await pipeline.strategyPda(TAX_AMM_PROGRAM_ADDRESS), { encoding: 'base64' }).send();
    if (!strategy.value) {
        throw new Error(`the tax AMM is not registered on ${LOCAL_URL}: run its local demo first (docs/toolchain.md, "Local demo run")`);
    }
}

export async function fund(account: Address, amount: bigint) {
    const signature = await rpc.requestAirdrop(account, lamports(amount), { commitment: 'confirmed' }).send();
    await confirm(signature);
}

/** A fresh wallet holding `sol` SOL. */
export async function wallet(sol = 2n): Promise<KeyPairSigner> {
    const signer = await generateKeyPairSigner();
    await fund(signer.address, sol * 1_000_000_000n);
    return signer;
}

async function confirm(signature: Signature) {
    for (let i = 0; i < 120; i++) {
        const { value } = await rpc.getSignatureStatuses([signature]).send();
        const status = value[0];
        if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err, (_, v) => (typeof v === 'bigint' ? `${v}` : v))}`);
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
        await sleep(250);
    }
    throw new Error(`${signature} was not confirmed in 30 s`);
}

export async function send(payer: KeyPairSigner, instructions: Instruction[], extra: KeyPairSigner[] = []): Promise<Signature> {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
        (m) => addSignersToTransactionMessage(extra, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' }).send();
    const signature = getSignatureFromTransaction(signed);
    await confirm(signature);
    return signature;
}

/** The token program of each mint `tokens` created: SPL Token unless it says otherwise. */
const programOf = new Map<Address, Address>();
const tokenProgramOf = (mint: Address) => programOf.get(mint) ?? TOKEN_PROGRAM_ADDRESS;

export const tokenAccount = async (owner: Address, mint: Address) =>
    (await findAssociatedTokenPda({ owner, mint, tokenProgram: tokenProgramOf(mint) }))[0];

export async function tokenBalance(owner: Address, mint: Address): Promise<bigint> {
    const account = await tokenAccount(owner, mint);
    const found = await rpc.getAccountInfo(account, { encoding: 'base64', commitment: 'confirmed' }).send();
    return found.value ? (await fetchToken(rpc, account, { commitment: 'confirmed' })).data.amount : 0n;
}

export async function supply(mint: Address): Promise<bigint> {
    return BigInt((await rpc.getTokenSupply(mint, { commitment: 'confirmed' }).send()).value.amount);
}

export async function balance(account: Address): Promise<bigint> {
    return (await rpc.getBalance(account, { commitment: 'confirmed' }).send()).value;
}

/** The keeper wallet's transactions, newest first. */
export async function signaturesOf(account: Address): Promise<Signature[]> {
    return (await rpc.getSignaturesForAddress(account, { commitment: 'confirmed' }).send()).map((entry) => entry.signature);
}

/**
 * A fresh mint of `tokenProgram` with its whole supply minted to `owner`, then no mint
 * authority and no freeze authority: a tax market's seed refuses a mint that keeps either,
 * unless it is a quote mint (`TAX-16`).
 */
async function createToken(owner: KeyPairSigner, decimals: number, tokenProgram: Address): Promise<Address> {
    const mint = await generateKeyPairSigner();
    programOf.set(mint.address, tokenProgram);
    const space = BigInt(getMintSize());
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
    const onProgram = { programAddress: tokenProgram };
    await send(
        owner,
        [
            getCreateAccountInstruction({ payer: owner, newAccount: mint, lamports: rent, space, programAddress: tokenProgram }),
            getInitializeMint2Instruction({ mint: mint.address, decimals, mintAuthority: owner.address, freezeAuthority: null }, onProgram),
            await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: owner, owner: owner.address, mint: mint.address, tokenProgram }),
            getMintToInstruction({ mint: mint.address, token: await tokenAccount(owner.address, mint.address), mintAuthority: owner, amount: 1_000_000_000_000_000n }, onProgram),
            getSetAuthorityInstruction({ owned: mint.address, owner, authorityType: AuthorityType.MintTokens, newAuthority: null }, onProgram),
        ],
        [mint],
    );
    return mint.address;
}

export type TestMarket = {
    marketState: Address;
    view: pipeline.MarketView;
    /** Token A (6 decimals) and token B (9 decimals, the tax side). */
    mints: [Address, Address];
    owner: KeyPairSigner;
    recipients: Address[];
    /** The keys of `recipients` after the owner, for tests that act as a recipient. */
    recipientKeys: KeyPairSigner[];
};

/**
 * Two fresh tokens for a market: A on SPL Token, and B, the tax side, on Token-2022 when
 * `blockable`, so a recipient can require memos on its token account and make its payout fail
 * (`blockRecipient`); `distribute` sends no memo (the tax AMM's spec, "Payout").
 */
export async function tokens(owner: KeyPairSigner, blockable = false): Promise<[Address, Address]> {
    return [
        await createToken(owner, 6, TOKEN_PROGRAM_ADDRESS),
        await createToken(owner, 9, blockable ? TOKEN_2022_PROGRAM_ADDRESS : TOKEN_PROGRAM_ADDRESS),
    ];
}

/**
 * A tax market of `mints`, taxed in token B at 3% buy and 5% sell, created and then seeded from
 * the metadata. Its tax recipients are `owner` and `others` (fresh wallets with
 * no token accounts), sharing 90% with 10% burned.
 */
export async function createMarket(owner: KeyPairSigner, mints: [Address, Address], others = 1): Promise<TestMarket> {
    const init = metadata.init!;
    const recipientKeys = await Promise.all(Array.from({ length: others }, () => generateKeyPairSigner()));
    const recipients = [owner.address, ...recipientKeys.map((key) => key.address)];
    const shares = recipients.length === 1 ? [9_000] : [6_000, 3_000, 0, 0].slice(0, recipients.length);
    const marketStateKey = await generateKeyPairSigner();
    const marketState = marketStateKey.address;
    const args: Record<string, number | bigint | Address> = {
        tax_side: 1,
        buy_tax_bps: 300,
        sell_tax_bps: 500,
        buy_tax_min_bps: 0,
        buy_tax_max_bps: 1_000,
        sell_tax_min_bps: 0,
        sell_tax_max_bps: 1_000,
        tax_authority: owner.address,
        seeder: owner.address,
        burn_share_bps: 1_000,
        virtual_side: 0,
        virtual_reserve: 0n,
    };
    for (let i = 0; i < 4; i++) {
        args[`recipient_${i}`] = recipients[i] ?? DEFAULT_ADDRESS;
        args[`share_${i}`] = shares[i] ?? 0;
    }
    const { instruction: create } = await pipeline.buildCreateMarketFromMetadata({
        init,
        strategyProgram: TAX_AMM_PROGRAM_ADDRESS,
        creator: owner.address,
        marketState,
        args,
        inputs: { mint_0: mints[0], mint_1: mints[1] },
        tokenPrograms: { [mints[0]]: tokenProgramOf(mints[0]), [mints[1]]: tokenProgramOf(mints[1]) },
        maxCreatorLamports: MAX_CREATOR_LAMPORTS,
        rpc,
    });
    const market = await pipeline.marketPda(TAX_AMM_PROGRAM_ADDRESS, marketState);
    const [vault0] = await findVault0Pda({ marketState, mint0: mints[0] });
    const [vault1] = await findVault1Pda({ marketState, mint1: mints[1] });
    const view: pipeline.MarketView = {
        market,
        strategyProgram: TAX_AMM_PROGRAM_ADDRESS,
        marketState,
        mints,
        vaults: [vault0, vault1],
        tokenPrograms: [tokenProgramOf(mints[0]), tokenProgramOf(mints[1])],
        supportsExactOut: false,
    };
    const seed = await buildActionInstruction({
        action: findAction(metadata, 'seed')!,
        market: view,
        wallet: owner.address,
        args: {
            amount_0: 100_000_000_000n,
            amount_1: 200_000_000_000n,
            // The hash of the terms just sent (`TAX-59`).
            expected_terms: termsArg(
                termsHash(mints, {
                    taxSide: 1,
                    buyTaxBps: 300,
                    sellTaxBps: 500,
                    buyTaxMinBps: 0,
                    buyTaxMaxBps: 1_000,
                    sellTaxMinBps: 0,
                    sellTaxMaxBps: 1_000,
                    taxAuthority: owner.address,
                    seeder: owner.address,
                    recipients: [0, 1, 2, 3].map((i) => recipients[i] ?? DEFAULT_ADDRESS),
                    shares: [0, 1, 2, 3].map((i) => shares[i] ?? 0),
                    burnShareBps: 1_000,
                    virtualSide: 0,
                    virtualReserve: 0n,
                }),
            ),
        },
    });
    const fees = await Promise.all(mints.map((mint) => pipeline.initFeeAccount({ payer: owner.address, market, mint, tokenProgram: tokenProgramOf(mint) })));
    // The seed in a transaction of its own, which the hash of the terms makes safe: a market of
    // two token programs is too big for one with its creation (the tax AMM's spec, "Creating a
    // market").
    await send(owner, [create, ...fees], [marketStateKey]);
    await send(owner, [seed]);
    return { marketState, view, mints, owner, recipients, recipientKeys };
}

/** Buys token A with `amount` of token B through the router, leaving tax owed in token B. */
export async function trade(market: TestMarket, amount = 1_000_000_000n): Promise<Signature> {
    const trader = market.owner;
    const { view } = market;
    const trade = { mode: pipeline.TradeMode.ExactIn, inputIndex: 1, outputIndex: 0, amount, trader: trader.address, extra: new Uint8Array() };
    const simulation = { commitment: 'confirmed' } as const;
    const strategyAccounts = await pipeline.resolveAccounts(rpc, view, trade, trader.address, simulation);
    const { quote } = await pipeline.quoteStrategy(rpc, view, trade, strategyAccounts, trader.address, simulation);
    const swap = await pipeline.swap(
        {
            trader: trader.address,
            strategyProgram: TAX_AMM_PROGRAM_ADDRESS,
            marketState: view.marketState,
            traderInput: await tokenAccount(trader.address, view.mints[1]!),
            traderOutput: await tokenAccount(trader.address, view.mints[0]!),
            inputVault: view.vaults[1]!,
            inputMint: view.mints[1]!,
            outputMint: view.mints[0]!,
            inputTokenProgram: tokenProgramOf(view.mints[1]!),
            outputTokenProgram: tokenProgramOf(view.mints[0]!),
            strategyAccounts,
        },
        { mode: pipeline.TradeMode.ExactIn, amountIn: amount, amountOut: 0n, minAmountOut: quote.amountOut, integratorFeeBps: 0, extra: new Uint8Array() },
    );
    return send(trader, [swap]);
}

export async function owed(market: TestMarket): Promise<bigint[]> {
    return [...(await fetchTaxMarket(rpc, market.marketState, { commitment: 'confirmed' })).data.owed];
}

/**
 * Gives a recipient a Token-2022 account for token B that requires memos on incoming
 * transfers, which its owner may turn on at any time, so its payouts fail (the tax AMM's
 * hardening, R02 and H025, signed off). The market's owner pays the rent.
 */
export async function blockRecipient(market: TestMarket, recipient: KeyPairSigner) {
    const mint = market.mints[1];
    const tokenProgram = TOKEN_2022_PROGRAM_ADDRESS;
    const token = await tokenAccount(recipient.address, mint);
    await send(
        market.owner,
        [
            await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: market.owner, owner: recipient.address, mint, tokenProgram }),
            getReallocateInstruction({ token, payer: market.owner, owner: recipient, newExtensionTypes: [ExtensionType.MemoTransfer] }),
            getEnableMemoTransfersInstruction({ token, owner: recipient }),
        ],
        [recipient],
    );
}

/** Turns the recipient's memo requirement off again, so its payouts go through. */
export async function unblockRecipient(market: TestMarket, recipient: KeyPairSigner) {
    const token = await tokenAccount(recipient.address, market.mints[1]);
    await send(market.owner, [getDisableMemoTransfersInstruction({ token, owner: recipient })], [recipient]);
}

/** The tax AMM entry, seeing only markets of the given mints, so tests on one validator don't meet. */
export function scoped(mints: readonly Address[]): AnyKeeperProduct {
    const of = new Set(mints);
    return {
        ...taxAmm,
        isMarket(data: Uint8Array) {
            if (!taxAmm.isMarket(data)) return false;
            const state: TaxMarket = taxAmm.decode(data);
            return state.mints.every((mint) => of.has(mint));
        },
    };
}

export type TestRunner = { runner: Runner; log: MemoryLogger; clock: FakeClock; chain: Chain; keeper: KeyPairSigner };

/**
 * A runner on a fake clock (starting at the real time), the keeper wallet given, seeing only
 * `mints`' tax markets, or only the products given; its daily pass `dailyInMinutes` after the start unless `env` says otherwise.
 */
export function testRunner(
    keeper: KeyPairSigner,
    mints: readonly Address[],
    options: {
        env?: Record<string, string>;
        chain?: Chain;
        dailyInMinutes?: number;
        products?: readonly AnyKeeperProduct[];
        recorder?: (log: MemoryLogger) => Recorder;
        heartbeat?: Heartbeat;
    } = {},
): TestRunner {
    const clock = new FakeClock(Date.now());
    const settings = loadSettings({
        KEEPER_RPC_URL: LOCAL_URL,
        KEEPER_DISCOVERY_RPC_URL: LOCAL_URL,
        KEEPER_WS_URL: LOCAL_WS_URL,
        KEEPER_KEYPAIR: '/not/read/by/tests',
        KEEPER_DAILY_PASS_UTC: dailyPassIn(clock, options.dailyInMinutes ?? 12 * 60),
        ...options.env,
    });
    const log = new MemoryLogger();
    const real = options.chain ?? rpcChain(settings);
    const runner = new Runner({
        settings,
        chain: real,
        clock,
        wallet: keeper,
        log,
        products: options.products ?? [scoped(mints)],
        recorder: options.recorder?.(log),
        heartbeat: options.heartbeat,
    });
    return { runner, log, clock, chain: real, keeper };
}

/** The job rows about one market. */
export const jobRows = (log: MemoryLogger, market: TestMarket): Row[] => log.of('job').filter((row) => row.market === market.marketState);

/** Waits, in real time, until `check` holds. */
export async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return;
        await sleep(200);
    }
    throw new Error(`timed out waiting for ${what}`);
}

/** DAILY_PASS_UTC set `minutes` after the clock's time. */
export function dailyPassIn(clock: FakeClock, minutes: number): string {
    const at = new Date(clock.now() + minutes * 60_000);
    return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
}
