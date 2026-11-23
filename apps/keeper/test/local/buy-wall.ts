// What the runner tests need of the buy wall AMM on a local validator running devnet's router,
// after the buy wall AMM's local demo run has registered the strategy (apps/keeper/README.md,
// "Testing"): markets created and seeded from the metadata as Aviary will create them, buys
// and sells through the router that leave its keeper jobs due, and its entry seeing only the
// test's own markets.

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { address, generateKeyPairSigner, type Address, type KeyPairSigner, type Signature } from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
    AuthorityType,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getInitializeMint2Instruction,
    getMintSize,
    getMintToInstruction,
    getSetAuthorityInstruction,
    getSyncNativeInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import * as pipeline from '@pipeline-placeholder/sdk';
import {
    BUY_WALL_AMM_PROGRAM_ADDRESS,
    fetchMarketState,
    findSolVaultPda,
    findTokenVaultPda,
} from 'buy-wall-amm-scripts/client/index.ts';
import { buyWallAmm, type AnyKeeperProduct, type BuyWallMarket } from 'keeper-jobs';
import { buildActionInstruction, findAction } from 'strategy-actions';

import { rpc, send, tokenAccount } from './harness.ts';

export const WSOL = address('So11111111111111111111111111111111111111112');
const MAX_CREATOR_LAMPORTS = 100_000_000n;
/** The demo's launch values: a 1% fee, half of it to the wall, a 15% reward share. */
const SEED = { tokens: 1_000_000_000_000n, lamports: 10_000_000_000n };

const metadata = (() => {
    const path = fileURLToPath(new URL('../../../../programs/buy-wall-amm/metadata.json', import.meta.url));
    const parsed = pipeline.parseStrategyMetadata(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.ok) throw new Error(`the buy wall AMM's metadata.json is invalid: ${parsed.errors.join('; ')}`);
    return parsed.value;
})();

/** Refuses to run unless the buy wall AMM is registered with the local validator's router. */
export async function checkBuyWallRegistered(url: string) {
    const strategy = await rpc.getAccountInfo(await pipeline.strategyPda(BUY_WALL_AMM_PROGRAM_ADDRESS), { encoding: 'base64' }).send();
    if (!strategy.value) {
        throw new Error(`the buy wall AMM is not registered on ${url}: run its local demo first (docs/toolchain.md, "Local demo run")`);
    }
}

export type WallMarket = {
    marketState: Address;
    view: pipeline.MarketView;
    token: Address;
    owner: KeyPairSigner;
};

/** A token with its mint authority removed, as the seed requires, all of it held by `owner`. */
async function createToken(owner: KeyPairSigner): Promise<Address> {
    const mint = await generateKeyPairSigner();
    const space = BigInt(getMintSize());
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
    await send(
        owner,
        [
            getCreateAccountInstruction({ payer: owner, newAccount: mint, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
            getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: owner.address }),
            await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: owner, owner: owner.address, mint: mint.address }),
            getMintToInstruction({ mint: mint.address, token: await tokenAccount(owner.address, mint.address), mintAuthority: owner, amount: 2n * SEED.tokens }),
            getSetAuthorityInstruction({ owned: mint.address, owner, authorityType: AuthorityType.MintTokens, newAuthority: null }),
        ],
        [mint],
    );
    return mint.address;
}

/** Wraps `amount` lamports into `owner`'s wrapped-SOL account. */
export async function wrapSol(owner: KeyPairSigner, amount: bigint) {
    const account = await tokenAccount(owner.address, WSOL);
    await send(owner, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: owner, owner: owner.address, mint: WSOL }),
        getTransferSolInstruction({ source: owner, destination: account, amount }),
        getSyncNativeInstruction({ account }),
    ]);
}

/**
 * A buy wall market of a fresh token at the demo's launch values (`owner` its fee and rewards
 * recipient, unless `rewardsRecipient` says otherwise, and its seeder), created with both fee accounts and seeded from the metadata in
 * one transaction; `owner` keeps as many tokens again and `sol` SOL wrapped, for trading.
 */
export async function createWallMarket(owner: KeyPairSigner, options: { sol?: bigint; rewardsRecipient?: Address } = {}): Promise<WallMarket> {
    const sol = options.sol ?? 5n;
    const token = await createToken(owner);
    await wrapSol(owner, SEED.lamports + sol * 1_000_000_000n);
    const marketStateKey = await generateKeyPairSigner();
    const tokenPrograms = [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS];
    const { instruction: create, resolved } = await pipeline.buildCreateMarketFromMetadata({
        init: metadata.init!,
        strategyProgram: BUY_WALL_AMM_PROGRAM_ADDRESS,
        creator: owner.address,
        marketState: marketStateKey.address,
        args: {
            fee_bps: 100,
            wall_split_bps: 5_000,
            fee_recipient: owner.address,
            reward_share_bps: 1_500,
            rewards_recipient: options.rewardsRecipient ?? owner.address,
            cap_floor_bps: 2_000,
            cap_decay_bps: 2_000,
            seeder: owner.address,
        },
        inputs: { token_mint: token },
        tokenPrograms: { [token]: TOKEN_PROGRAM_ADDRESS, [WSOL]: TOKEN_PROGRAM_ADDRESS },
        maxCreatorLamports: MAX_CREATOR_LAMPORTS,
        rpc,
    });
    const marketState = resolved.marketState;
    const [tokenVault] = await findTokenVaultPda({ marketState, tokenMint: token });
    const [solVault] = await findSolVaultPda({ marketState, wsolMint: WSOL });
    const view: pipeline.MarketView = {
        market: resolved.market,
        strategyProgram: BUY_WALL_AMM_PROGRAM_ADDRESS,
        marketState,
        mints: [token, WSOL],
        vaults: [tokenVault, solVault],
        tokenPrograms,
        supportsExactOut: false,
    };
    const fees = await Promise.all(view.mints.map((mint) => pipeline.initFeeAccount({ payer: owner.address, market: resolved.market, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS })));
    const seed = await buildActionInstruction({
        action: findAction(metadata, 'seed')!,
        market: view,
        wallet: owner.address,
        args: { token_amount: SEED.tokens, sol_amount: SEED.lamports },
    });
    await send(owner, [create, ...fees, seed], [marketStateKey]);
    // The fee mint the router recorded for the market (Pipeline 0.3), which says which side of a
    // trade pays Pipeline's fee.
    const record = await rpc.getAccountInfo(resolved.market, { encoding: 'base64', commitment: 'confirmed' }).send();
    const routerMarket = record.value && pipeline.decodeMarket(new Uint8Array(Buffer.from(record.value.data[0], 'base64')));
    if (!routerMarket) throw new Error(`no router market at ${resolved.market}`);
    return { marketState, view: { ...view, feeMint: pipeline.marketFeeMint(routerMarket) }, token, owner };
}

/**
 * A swap through the router with what the trader keeps of its quote as the minimum: a buy of the
 * token with `amount` lamports, or a sell of `amount` token units. Since Pipeline 0.3 a sale into
 * wrapped SOL pays the router's fee out of what arrived, so the minimum is checked against what is
 * kept (docs/toolchain.md, "Pipeline 0.3"). Returns what the trader kept.
 */
export async function swap(market: WallMarket, side: 'buy' | 'sell', amount: bigint): Promise<{ signature: Signature; received: bigint }> {
    const trader = market.owner;
    const [input, output] = side === 'buy' ? [1, 0] : [0, 1];
    const { view } = market;
    const trade = { mode: pipeline.TradeMode.ExactIn, inputIndex: input, outputIndex: output, amount, trader: trader.address, extra: new Uint8Array() };
    const simulation = { commitment: 'confirmed' } as const;
    const strategyAccounts = await pipeline.resolveAccounts(rpc, view, trade, trader.address, simulation);
    const { quote } = await pipeline.quoteStrategy(rpc, view, trade, strategyAccounts, trader.address, simulation);
    const kept = pipeline.marketViewFeeSide(view, view.mints[output]!) === 'output' ? pipeline.keptAfterOutputFee(quote.amountOut) : quote.amountOut;
    const instruction = await pipeline.swap(
        {
            trader: trader.address,
            strategyProgram: BUY_WALL_AMM_PROGRAM_ADDRESS,
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
    );
    return { signature: await send(trader, [instruction]), received: kept };
}

/** The market's state as the keeper jobs read it. */
export async function wallState(market: WallMarket): Promise<BuyWallMarket> {
    const account = await rpc.getAccountInfo(market.marketState, { encoding: 'base64', commitment: 'confirmed' }).send();
    if (!account.value) throw new Error(`no market state at ${market.marketState}`);
    return buyWallAmm.decode(new Uint8Array(Buffer.from(account.value.data[0], 'base64')));
}

/** Waits until the cluster's clock is at least `seconds` past the market's last cap step. */
async function waitForDecay(market: WallMarket, seconds: bigint) {
    const { data } = await fetchMarketState(rpc, market.marketState, { commitment: 'confirmed' });
    const decayTime = new DataView(new Uint8Array(data.decayTime).buffer).getBigInt64(0, true);
    for (;;) {
        const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
        const now = await rpc.getBlockTime(slot).send();
        if (now !== null && BigInt(now) >= decayTime + seconds) return;
        await sleep(250);
    }
}

/**
 * Trades until `place_wall` is due and `retired_tokens` above 0, in pairs as the demo trades:
 * a buy once the cluster's clock is 3 seconds past the last cap step, so the buy lowers the
 * cap by the decay credit built up, then a sell of what it bought, which that lower cap trims.
 * Each pair leaves the pool where it was, so the next pair's sell is trimmed too, and its
 * fees add to idle SOL. Returns the last swap.
 */
export async function makeWallDue(market: WallMarket): Promise<Signature> {
    const placeWall = buyWallAmm.jobs.find((job) => job.name === 'place_wall')!;
    for (;;) {
        await waitForDecay(market, 3n);
        const { received } = await swap(market, 'buy', 1_000_000_000n);
        const { signature } = await swap(market, 'sell', received);
        const state = await wallState(market);
        if (state.retiredTokens > 0n && placeWall.due(state).length > 0) return signature;
    }
}

/** The buy wall AMM entry, seeing only markets of `tokens`, so tests on one validator don't meet. */
export function scopedWall(tokens: readonly Address[]): AnyKeeperProduct {
    const of = new Set(tokens);
    return {
        ...buyWallAmm,
        isMarket(data: Uint8Array) {
            return buyWallAmm.isMarket(data) && of.has((buyWallAmm.decode(data) as BuyWallMarket).tokenMint);
        },
    };
}

