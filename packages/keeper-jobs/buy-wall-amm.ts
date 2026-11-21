// The buy wall AMM's four keeper jobs (docs/spec/keeper-runner.md, "The jobs";
// docs/spec/pool4-for-solana.md, "Keeper jobs"), built from its generated client:
//
// - `place_wall`, after each transaction on a market and in every sweep, once `idle_sol` or the
//   wall's `converted` reaches `WALL_THRESHOLD`; refused with `SwapThisSlot` in a slot a swap
//   already ran in, which means "try again in a later slot" (POOL4-50). Its keeper tip is paid
//   into the caller's own wrapped-SOL account, created in the same transaction if missing.
// - `settle`, in the hourly pass, once anything is retired; the runner sends it at most once
//   every SETTLE_INTERVAL on each market. Nobody signs it but the fee payer (POOL4-38).
// - `pay_rewards`, in the daily pass, once any rewards are owed, into the rewards recipient's
//   associated token account, created at the caller's expense if missing. A buy wall market's
//   token never has a live transfer hook (the seed refuses one, POOL4-48), so it takes no hook
//   accounts.
// - `sweep_fees { slot }`, in the daily pass, one transaction per slot owed anything: slot 0 to
//   the fee recipient, slot 1 to DESIGNER_RECIPIENT and slot 2 to SUITE_TREASURY, each into the
//   wallet's wrapped-SOL account, created at the caller's expense if missing. Slot 1 waits
//   while DESIGNER_RECIPIENT is unset, which the program refuses with `RecipientUnset`.
//
// A payout into an account that does not exist yet creates it at the caller's expense, so the
// runner skips one whose ledger is worth less than that account's rent while it is missing
// (docs/spec/pool4-for-solana.md, "For the keeper runner"; SUITE-54); rewards are valued at
// the market's price.
//
// Every job waits for the seed: before it, the program refuses each with `MarketNotOpen`.

import { fetchEncodedAccount, type Address, type GetAccountInfoApi, type ReadonlyUint8Array, type Rpc } from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
    BUY_WALL_AMM_ERROR__NOTHING_OWED,
    BUY_WALL_AMM_ERROR__NOTHING_TO_SETTLE,
    BUY_WALL_AMM_ERROR__SWAP_THIS_SLOT,
    BUY_WALL_AMM_ERROR__WALL_BELOW_THRESHOLD,
    BUY_WALL_AMM_PROGRAM_ADDRESS,
    DESIGNER_RECIPIENT,
    findVaultAuthorityPda,
    getMarketStateDecoder,
    getMarketStateSize,
    getPayRewardsInstruction,
    getPlaceWallInstruction,
    getSettleInstruction,
    getSweepFeesInstruction,
    MARKET_STATE_DISCRIMINATOR,
    PAY_REWARDS_DISCRIMINATOR,
    PLACE_WALL_DISCRIMINATOR,
    SETTLE_DISCRIMINATOR,
    SUITE_TREASURY,
    SWEEP_FEES_DISCRIMINATOR,
    WALL_THRESHOLD,
} from 'buy-wall-amm-scripts/client/index.ts';

import type { JobUnit, KeeperJob, KeeperProduct } from './index.ts';

/** The market state's `status` once seeded (`STATUS_OPEN` in the program's state.rs). */
const STATUS_OPEN = 2;
const Q = 1n << 64n;
/** The all-zero key: DESIGNER_RECIPIENT while it is unset. */
const DEFAULT_ADDRESS = '11111111111111111111111111111111' as Address;

/** What the jobs read of a buy wall market state, its integers decoded. */
export type BuyWallMarket = {
    open: boolean;
    tokenMint: Address;
    wsolMint: Address;
    tokenVault: Address;
    solVault: Address;
    feeRecipient: Address;
    rewardsRecipient: Address;
    feeBps: bigint;
    /** Q64.64. */
    sqrtPrice: bigint;
    wallLiquidity: bigint;
    /** Q64.64. */
    wallTop: bigint;
    wallSolPlaced: bigint;
    idleSol: bigint;
    retiredTokens: bigint;
    rewardsOwed: bigint;
    /** The three fee slots' ledgers: the fee recipient's, the designer's and the suite's. */
    fees: readonly [bigint, bigint, bigint];
};

/** A little-endian unsigned integer, as the zero-copy market state stores each. */
function le(bytes: ReadonlyUint8Array): bigint {
    let value = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
    return value;
}

/**
 * The SOL the placed wall has spent buying tokens, `wall_sol_placed - floor(W x min(s, top) /
 * Q)`, or 0 with no wall: the program's `wall::converted`, to the lamport.
 */
export function converted(market: BuyWallMarket): bigint {
    if (market.wallLiquidity === 0n) return 0n;
    const price = market.sqrtPrice < market.wallTop ? market.sqrtPrice : market.wallTop;
    const held = (market.wallLiquidity * price) / Q;
    return market.wallSolPlaced > held ? market.wallSolPlaced - held : 0n;
}

/** The token's program, SPL Token or Token-2022, as the mint's owner says. */
async function tokenProgramOf(rpc: Rpc<GetAccountInfoApi>, mint: Address): Promise<Address> {
    const account = await fetchEncodedAccount(rpc, mint, { commitment: 'confirmed' });
    if (!account.exists) throw new Error(`the token mint ${mint} does not exist`);
    return account.programAddress;
}

/**
 * The rent-exempt balance of an account of `size` bytes: (128 + size) bytes at 3,480 lamports
 * a byte-year, for two years, the cluster's rent since genesis.
 */
const rentExempt = (size: bigint) => (128n + size) * 3_480n * 2n;
/** A plain token account, and a Token-2022 associated token account with its ImmutableOwner extension. */
const TOKEN_ACCOUNT_SIZE = 165n;
const TOKEN_2022_ACCOUNT_SIZE = 170n;

/**
 * Why a payout of `worth` lamports into `account` should wait, or null: it waits only while the
 * account is missing, so the payout would create it, and `worth` is less than its rent.
 */
async function worthTheRent(rpc: Rpc<GetAccountInfoApi>, account: Address, tokenProgram: Address, worth: bigint): Promise<string | null> {
    if ((await fetchEncodedAccount(rpc, account, { commitment: 'confirmed' })).exists) return null;
    const rent = rentExempt(tokenProgram === TOKEN_PROGRAM_ADDRESS ? TOKEN_ACCOUNT_SIZE : TOKEN_2022_ACCOUNT_SIZE);
    return worth < rent ? `it would create ${account}, whose rent of ${rent} lamports is more than the ${worth} lamports it would pay` : null;
}

const PLACE_WALL = 'place_wall';
const SETTLE = 'settle';
const PAY_REWARDS = 'pay_rewards';
const SWEEP_FEES = 'sweep_fees';

const placeWall: KeeperJob<BuyWallMarket> = {
    name: PLACE_WALL,
    discriminator: PLACE_WALL_DISCRIMINATOR,
    pass: 'sweep',

    due(market) {
        if (!market.open) return [];
        const work = converted(market) > market.idleSol ? converted(market) : market.idleSol;
        return work >= WALL_THRESHOLD ? [{ job: PLACE_WALL, key: PLACE_WALL, owed: work }] : [];
    },

    async build({ marketState, state, payer }) {
        // The caller's own wrapped-SOL account takes the tip; the market's SOL vault is plain SPL Token.
        const [tipAccount] = await findAssociatedTokenPda({ owner: payer.address, mint: state.wsolMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        const [vaultAuthority] = await findVaultAuthorityPda({ marketState });
        return [
            getCreateAssociatedTokenIdempotentInstruction({ payer, ata: tipAccount, owner: payer.address, mint: state.wsolMint }),
            getPlaceWallInstruction({ caller: payer, marketState, solVault: state.solVault, tipAccount, wsolMint: state.wsolMint, vaultAuthority }),
        ];
    },

    refusals: { nothingToDo: [BUY_WALL_AMM_ERROR__WALL_BELOW_THRESHOLD], laterSlot: [BUY_WALL_AMM_ERROR__SWAP_THIS_SLOT] },
};

const settle: KeeperJob<BuyWallMarket> = {
    name: SETTLE,
    discriminator: SETTLE_DISCRIMINATOR,
    pass: 'hourly',

    due(market) {
        return market.open && market.retiredTokens > 0n ? [{ job: SETTLE, key: SETTLE, owed: market.retiredTokens }] : [];
    },

    async build({ rpc, marketState, state }) {
        const [vaultAuthority] = await findVaultAuthorityPda({ marketState });
        const tokenProgram = await tokenProgramOf(rpc, state.tokenMint);
        return [getSettleInstruction({ marketState, tokenVault: state.tokenVault, tokenMint: state.tokenMint, vaultAuthority, tokenProgram })];
    },

    refusals: { nothingToDo: [BUY_WALL_AMM_ERROR__NOTHING_TO_SETTLE], laterSlot: [] },
};

const payRewards: KeeperJob<BuyWallMarket> = {
    name: PAY_REWARDS,
    discriminator: PAY_REWARDS_DISCRIMINATOR,
    pass: 'daily',

    due(market) {
        return market.open && market.rewardsOwed > 0n ? [{ job: PAY_REWARDS, key: PAY_REWARDS, owed: market.rewardsOwed }] : [];
    },

    async build({ rpc, marketState, state, payer }) {
        const tokenProgram = await tokenProgramOf(rpc, state.tokenMint);
        const [recipientTokenAccount] = await findAssociatedTokenPda({ owner: state.rewardsRecipient, mint: state.tokenMint, tokenProgram });
        const [vaultAuthority] = await findVaultAuthorityPda({ marketState });
        return [
            getPayRewardsInstruction({
                payer,
                marketState,
                tokenVault: state.tokenVault,
                tokenMint: state.tokenMint,
                rewardsRecipient: state.rewardsRecipient,
                recipientTokenAccount,
                vaultAuthority,
                tokenProgram,
            }),
        ];
    },

    async skipReason({ rpc, state }) {
        const tokenProgram = await tokenProgramOf(rpc, state.tokenMint);
        const [account] = await findAssociatedTokenPda({ owner: state.rewardsRecipient, mint: state.tokenMint, tokenProgram });
        // A token unit is worth (s / Q)^2 lamports at the market's price.
        return worthTheRent(rpc, account, tokenProgram, (state.rewardsOwed * state.sqrtPrice * state.sqrtPrice) / (Q * Q));
    },

    refusals: { nothingToDo: [BUY_WALL_AMM_ERROR__NOTHING_OWED], laterSlot: [] },
};

/** The program-wide wallets the fee slots pay, as the deployed build fixes them. */
export type BuyWallConstants = { designerRecipient: Address };

/** `sweep_fees`, for a build whose DESIGNER_RECIPIENT is `designerRecipient`. */
function sweepFees({ designerRecipient }: BuyWallConstants): KeeperJob<BuyWallMarket> {
    /** The wallet a fee slot pays, or null while it has none (slot 1 before DESIGNER_RECIPIENT is set). */
    const slotWallet = (market: BuyWallMarket, slot: number): Address | null =>
        slot === 0 ? market.feeRecipient : slot === 1 ? (designerRecipient === DEFAULT_ADDRESS ? null : designerRecipient) : SUITE_TREASURY;

    return {
        name: SWEEP_FEES,
        discriminator: SWEEP_FEES_DISCRIMINATOR,
        pass: 'daily',

        due(market) {
            if (!market.open) return [];
            const units: JobUnit[] = [];
            market.fees.forEach((owed, slot) => {
                if (owed > 0n && slotWallet(market, slot) !== null) units.push({ job: SWEEP_FEES, key: `${SWEEP_FEES}:${slot}`, slot, owed });
            });
            return units;
        },

        async build({ marketState, state, unit, payer }) {
            const slot = unit.slot!;
            const recipient = slotWallet(state, slot);
            if (recipient === null) throw new Error(`fee slot ${slot} has no wallet to pay while DESIGNER_RECIPIENT is unset`);
            const [recipientTokenAccount] = await findAssociatedTokenPda({ owner: recipient, mint: state.wsolMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
            const [vaultAuthority] = await findVaultAuthorityPda({ marketState });
            return [
                getSweepFeesInstruction({ payer, marketState, solVault: state.solVault, wsolMint: state.wsolMint, recipient, recipientTokenAccount, vaultAuthority, slot }),
            ];
        },

        async skipReason({ rpc, state, unit }) {
            const recipient = slotWallet(state, unit.slot!);
            if (recipient === null) return null;
            const [account] = await findAssociatedTokenPda({ owner: recipient, mint: state.wsolMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
            return worthTheRent(rpc, account, TOKEN_PROGRAM_ADDRESS, state.fees[unit.slot!]!);
        },

        refusals: { nothingToDo: [BUY_WALL_AMM_ERROR__NOTHING_OWED], laterSlot: [] },
    };
}

function decode(data: Uint8Array): BuyWallMarket {
    const state = getMarketStateDecoder().decode(data);
    return {
        open: state.status === STATUS_OPEN,
        tokenMint: state.tokenMint,
        wsolMint: state.wsolMint,
        tokenVault: state.tokenVault,
        solVault: state.solVault,
        feeRecipient: state.feeRecipient,
        rewardsRecipient: state.rewardsRecipient,
        feeBps: le(state.feeBps),
        sqrtPrice: le(state.sqrtPrice),
        wallLiquidity: le(state.wallLiquidity),
        wallTop: le(state.wallTop),
        wallSolPlaced: le(state.wallSolPlaced),
        idleSol: le(state.idleSol),
        retiredTokens: le(state.retiredTokens),
        rewardsOwed: le(state.rewardsOwed),
        fees: [le(state.feesRecipient), le(state.feesDesigner), le(state.feesSuite)],
    };
}

/** The buy wall AMM's entry for a build with the given wallets: tests pass a set DESIGNER_RECIPIENT. */
export function buyWallAmmWith(constants: BuyWallConstants): KeeperProduct<BuyWallMarket> {
    return {
        name: 'buy-wall-amm',
        programAddress: BUY_WALL_AMM_PROGRAM_ADDRESS,
        isMarket(data) {
            return data.length === getMarketStateSize() && MARKET_STATE_DISCRIMINATOR.every((byte, i) => data[i] === byte);
        },
        decode,
        jobs: [placeWall, settle, payRewards, sweepFees(constants)],
    };
}

/** The buy wall AMM's entry, with the wallets the generated client reads from the program's IDL. */
export const buyWallAmm = buyWallAmmWith({ designerRecipient: DESIGNER_RECIPIENT });
