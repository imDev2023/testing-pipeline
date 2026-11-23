// What the runner tests need of the lending AMM on a local validator running devnet's router and
// devnet's klend with our Kamino lending market cloned, after the lending AMM's local demo run
// has registered the strategy (apps/keeper/README.md, "Testing"): WSOL-lent markets created
// with their first deposit from the metadata as Aviary will create them, buys and sells through
// the router that push the buffer out of its band, and the entry seeing only the test's markets.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { address, generateKeyPairSigner, type Address, type KeyPairSigner, type Signature } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
    AuthorityType,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getInitializeMint2Instruction,
    getMintSize,
    getMintToInstruction,
    getSetAuthorityInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import * as pipeline from '@pipeline-placeholder/sdk';
import { lendingAmm, type AnyKeeperProduct, type LendingMarket } from 'keeper-jobs';
import { refreshReserveInstruction } from 'keeper-jobs/lending-amm.ts';
import { getLendingAmmMarketDecoder, LENDING_AMM_PROGRAM_ADDRESS, parseRebalancedEvent, REBALANCED_EVENT_DISCRIMINATOR, RebalanceDirection, TRADE_MAX_RESERVE_AGE_SLOTS } from 'lending-amm-scripts/client/index.ts';
import { decodeReserve } from 'lending-amm-scripts/kamino.ts';
import { buildActionInstruction, findAction } from 'strategy-actions';

import { wrapSol, WSOL } from './buy-wall.ts';
import { rpc, send, tokenAccount } from './harness.ts';

const MAX_CREATOR_LAMPORTS = 100_000_000n;

type KaminoDevnet = { lendingMarket: { address: string }; reserves: { wsol: { address: string; collateralMint: string } } };
const KAMINO = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../deployments/kamino-devnet.json', import.meta.url)), 'utf8')) as KaminoDevnet;
/** Our devnet WSOL reserve and its lending market, cloned onto the validator by fetch-accounts.sh. */
export const RESERVE = address(KAMINO.reserves.wsol.address);
const LENDING_MARKET = address(KAMINO.lendingMarket.address);
const COLLATERAL_MINT = address(KAMINO.reserves.wsol.collateralMint);

const metadata = (() => {
    const path = fileURLToPath(new URL('../../../../programs/lending-amm/metadata.json', import.meta.url));
    const parsed = pipeline.parseStrategyMetadata(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.ok) throw new Error(`the lending AMM's metadata.json is invalid: ${parsed.errors.join('; ')}`);
    return parsed.value;
})();

/** Refuses to run unless the lending AMM is registered with the validator's router and our WSOL reserve is cloned. */
export async function checkLendingRegistered(url: string) {
    const strategy = await rpc.getAccountInfo(await pipeline.strategyPda(LENDING_AMM_PROGRAM_ADDRESS), { encoding: 'base64' }).send();
    if (!strategy.value) {
        throw new Error(`the lending AMM is not registered on ${url}: run its local demo with --register-only first (docs/toolchain.md, "Local demo run")`);
    }
    const reserve = await rpc.getAccountInfo(RESERVE, { encoding: 'base64' }).send();
    if (!reserve.value) throw new Error(`our WSOL reserve ${RESERVE} is not on ${url}: run programs/lending-amm/scripts/fetch-accounts.sh, then restart the validator`);
}

export type LentMarket = { marketState: Address; view: pipeline.MarketView; token: Address; owner: KeyPairSigner };

/** A token with its mint authority removed, all of it held by `owner`. */
async function createToken(owner: KeyPairSigner, amount: bigint): Promise<Address> {
    const mint = await generateKeyPairSigner();
    const space = BigInt(getMintSize());
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
    await send(
        owner,
        [
            getCreateAccountInstruction({ payer: owner, newAccount: mint, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
            getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: owner.address }),
            await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: owner, owner: owner.address, mint: mint.address }),
            getMintToInstruction({ mint: mint.address, token: await tokenAccount(owner.address, mint.address), mintAuthority: owner, amount }),
            getSetAuthorityInstruction({ owned: mint.address, owner, authorityType: AuthorityType.MintTokens, newAuthority: null }),
        ],
        [mint],
    );
    return mint.address;
}

/**
 * A WSOL-lent market of a fresh token (the token mint 0, WSOL mint 1), created with both fee
 * accounts and its first deposit of `deposit` from the metadata in one transaction, as the
 * demo creates it: the whole lent side starts in the buffer, above its band. `owner` keeps as
 * many tokens again and `sol` SOL wrapped, for trading.
 */
export async function createLentMarket(owner: KeyPairSigner, deposit = { token: 250_000_000_000n, wsol: 500_000_000n }, sol = 2n): Promise<LentMarket> {
    const token = await createToken(owner, 2n * deposit.token);
    await wrapSol(owner, deposit.wsol + sol * 1_000_000_000n);
    const mints = [token, WSOL] as const;
    const tokenPrograms = { [token]: TOKEN_PROGRAM_ADDRESS, [WSOL]: TOKEN_PROGRAM_ADDRESS };
    const { instruction: create, resolved } = await pipeline.buildCreateMarketFromMetadata({
        init: metadata.init!,
        strategyProgram: LENDING_AMM_PROGRAM_ADDRESS,
        creator: owner.address,
        args: { lent_index: 1, lp_fee_bps: 30 },
        inputs: { other_mint: token, lent_mint: WSOL, collateral_mint: COLLATERAL_MINT },
        tokenPrograms,
        maxCreatorLamports: MAX_CREATOR_LAMPORTS,
        rpc,
    });
    const vaultOf = (name: string) => resolved.strategyAccounts[metadata.init!.accounts!.findIndex((account) => account.name === name)]!.address;
    const view: pipeline.MarketView = {
        market: resolved.market,
        strategyProgram: LENDING_AMM_PROGRAM_ADDRESS,
        marketState: resolved.marketState,
        mints,
        vaults: [vaultOf('vault_0'), vaultOf('vault_1')],
        tokenPrograms: [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS],
        supportsExactOut: false,
    };
    const fees = await Promise.all(mints.map((mint) => pipeline.initFeeAccount({ payer: owner.address, market: resolved.market, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS })));
    // The first deposit's shares, isqrt(token x wsol) - MINIMUM_LIQUIDITY, taken as the minimum.
    const add = await buildActionInstruction({
        action: findAction(metadata, 'add_liquidity')!,
        market: view,
        wallet: owner.address,
        args: { max_0: deposit.token, max_1: deposit.wsol, min_lp: 1n },
        inputs: { reserve: RESERVE },
        tokenPrograms,
    });
    await send(owner, [create, ...fees, add]);
    const record = await rpc.getAccountInfo(resolved.market, { encoding: 'base64', commitment: 'confirmed' }).send();
    const routerMarket = record.value && pipeline.decodeMarket(new Uint8Array(Buffer.from(record.value.data[0], 'base64')));
    if (!routerMarket) throw new Error(`no router market at ${resolved.market}`);
    return { marketState: resolved.marketState, view: { ...view, feeMint: pipeline.marketFeeMint(routerMarket) }, token, owner };
}

/**
 * Refreshes our WSOL reserve when its last refresh is older than a quote allows, as a trader's
 * desk does before quoting a market that holds cTokens.
 */
export async function keepReserveFresh(payer: KeyPairSigner) {
    const account = await rpc.getAccountInfo(RESERVE, { encoding: 'base64', commitment: 'confirmed' }).send();
    const view = decodeReserve(new Uint8Array(Buffer.from(account.value!.data[0], 'base64')));
    if (typeof view === 'string') throw new Error(`our WSOL reserve: ${view}`);
    const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
    if (slot - view.lastUpdateSlot > TRADE_MAX_RESERVE_AGE_SLOTS / 4n) await send(payer, [refreshReserveInstruction(RESERVE, LENDING_MARKET, view)]);
}

/**
 * A swap through the router, its own accounts resolved (a sale beyond the buffer lists klend's
 * redeem accounts) and what the trader keeps of its quote as the minimum: a buy of the token with
 * `amount` lamports, or a sale of `amount` token units.
 */
export async function swap(market: LentMarket, side: 'buy' | 'sell', amount: bigint): Promise<Signature> {
    const trader = market.owner;
    await keepReserveFresh(trader);
    const [input, output] = side === 'buy' ? [1, 0] : [0, 1];
    const { view } = market;
    const trade = { mode: pipeline.TradeMode.ExactIn, inputIndex: input, outputIndex: output, amount, trader: trader.address, extra: new Uint8Array() };
    const simulation = { commitment: 'confirmed' } as const;
    const strategyAccounts = await pipeline.resolveAccounts(rpc, view, trade, trader.address, simulation);
    const { quote } = await pipeline.quoteStrategy(rpc, view, trade, strategyAccounts, trader.address, simulation);
    const feeSide = pipeline.marketViewFeeSide(view, view.mints[output]!);
    const kept = feeSide === 'output' ? pipeline.keptAfterOutputFee(quote.amountOut) : quote.amountOut;
    const instruction = await pipeline.swap(
        {
            trader: trader.address,
            strategyProgram: LENDING_AMM_PROGRAM_ADDRESS,
            marketState: view.marketState,
            traderInput: await tokenAccount(trader.address, view.mints[input]!),
            traderOutput: await tokenAccount(trader.address, view.mints[output]!),
            inputVault: view.vaults[input]!,
            inputMint: view.mints[input]!,
            outputMint: view.mints[output]!,
            inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
            outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
            strategyAccounts,
        },
        { mode: pipeline.TradeMode.ExactIn, amountIn: amount, amountOut: 0n, minAmountOut: kept, integratorFeeBps: 0, extra: new Uint8Array() },
        feeSide,
    );
    return send(trader, [instruction]);
}

/** The market as the keeper jobs read it, with the accounts its entry watches read in the same request. */
export async function lentState(market: LentMarket): Promise<LendingMarket> {
    const marketData = await rpc.getAccountInfo(market.marketState, { encoding: 'base64', commitment: 'confirmed' }).send();
    if (!marketData.value) throw new Error(`no market state at ${market.marketState}`);
    const data = new Uint8Array(Buffer.from(marketData.value.data[0], 'base64'));
    const watches = lendingAmm.watches!(data);
    const { value } = await rpc.getMultipleAccounts([market.marketState, ...watches], { encoding: 'base64', commitment: 'confirmed' }).send();
    const watched = new Map(watches.map((account, i) => [account, value[i + 1] ? new Uint8Array(Buffer.from(value[i + 1]!.data[0], 'base64')) : null]));
    return lendingAmm.decode(new Uint8Array(Buffer.from(value[0]!.data[0], 'base64')), watched);
}

/**
 * The buffer's share right after transaction `signature`, from what it left in the market's buffer
 * vault and cToken account, the cTokens valued at the reserve's stored rate now: so a swap's effect
 * is measured even when a keeper has rebalanced since.
 */
export async function shareAfter(market: LentMarket, signature: Signature): Promise<bigint> {
    const state = await lentState(market);
    const transaction = await rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
    if (!transaction?.meta) throw new Error(`no transaction ${signature}`);
    const keys = [...transaction.transaction.message.accountKeys, ...(transaction.meta.loadedAddresses?.writable ?? []), ...(transaction.meta.loadedAddresses?.readonly ?? [])];
    const after = (account: Address) => {
        const entry = transaction.meta!.postTokenBalances?.find((balance) => keys[balance.accountIndex] === account);
        if (!entry) throw new Error(`${signature} left no balance for ${account}`);
        return BigInt(entry.uiTokenAmount.amount);
    };
    const buffer = after(state.bufferVault);
    const ctokens = keys.includes(state.ctokenAccount) ? after(state.ctokenAccount) : state.ctokens;
    const reserve = state.kamino!.reserve;
    const value = ctokens === 0n ? 0n : (ctokens * reserve.totalSupplySf) / (reserve.mintTotalSupply << 60n);
    return (buffer * 10_000n) / (buffer + value);
}

/** Which way the `rebalance` of transaction `signature` moved the lent mint, and how much. */
export async function rebalancedBy(signature: Signature): Promise<{ direction: 'Deposit' | 'Redeem'; liquidity: bigint }> {
    const transaction = await rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
    const events = (transaction?.meta?.logMessages ?? [])
        .filter((line) => line.startsWith('Program data: '))
        .map((line) => new Uint8Array(Buffer.from(line.slice('Program data: '.length), 'base64')))
        .filter((data) => REBALANCED_EVENT_DISCRIMINATOR.every((byte, i) => data[i] === byte));
    if (events.length !== 1) throw new Error(`${signature} logged ${events.length} Rebalanced events`);
    const event = parseRebalancedEvent(events[0]!);
    return { direction: RebalanceDirection[event.direction] as 'Deposit' | 'Redeem', liquidity: event.liquidity };
}

/** The buffer's share of the lent side, in basis points of `L = B + V` at the reserve's stored rate. */
export async function bufferShareBps(market: LentMarket): Promise<{ buffer: bigint; lentValue: bigint; bps: bigint }> {
    const state = await lentState(market);
    const reserve = state.kamino!.reserve;
    const lentValue = state.ctokens === 0n ? 0n : (state.ctokens * reserve.totalSupplySf) / (reserve.mintTotalSupply << 60n);
    const total = state.buffer + lentValue;
    return { buffer: state.buffer, lentValue, bps: total === 0n ? 0n : (state.buffer * 10_000n) / total };
}

/**
 * The lending AMM entry, seeing only markets of the given tokens, so tests on one validator don't
 * meet; a set given is read live, so a test can add a market's token after the runner starts.
 */
export function scopedLending(tokens: ReadonlySet<Address> | readonly Address[]): AnyKeeperProduct {
    const of: ReadonlySet<Address> = tokens instanceof Set ? tokens : new Set(tokens);
    return {
        ...lendingAmm,
        isMarket(data: Uint8Array) {
            return lendingAmm.isMarket(data) && getLendingAmmMarketDecoder().decode(data).mints.some((mint) => of.has(mint));
        },
    };
}
