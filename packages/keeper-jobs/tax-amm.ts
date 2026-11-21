// The tax AMM's keeper job, `distribute { slot }`: due when a slot is owed more than 0, the
// burn slot included, and sent in the daily pass, one transaction per slot
// (docs/spec/keeper-runner.md, "The jobs"; docs/spec/tax-amm.md, "Payout").
//
// Built from the tax AMM's generated client. A payout passes the tax-side mint read-only, so
// it never write-locks it (for wrapped SOL, the native mint every SOL transfer reads); the
// burn, the same instruction for the burn slot, passes it writable (TAX-48). A slot's wallet
// is the tax recipient's, the suite treasury for the suite share, or the default key for the
// burn (TAX-45), and a hooked tax-side mint's transfer-hook accounts follow the payout's own.
//
// `distribute` on a slot owed nothing is not refused: it succeeds and moves nothing (TAX-43).
// So the job has no "nothing to do" refusal code; a successful simulation that emits no
// `Distributed` event did nothing, which is how a second keeper paying the slot first shows.

import {
    AccountRole,
    address,
    fetchEncodedAccount,
    getBase64Encoder,
    type Address,
    type GetAccountInfoApi,
    type Instruction,
    type Rpc,
} from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { decodeMint, resolveExtraAccountMetasForExecute, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
    BURN_SLOT,
    DISTRIBUTE_DISCRIMINATOR,
    DISTRIBUTED_EVENT_DISCRIMINATOR,
    findAuthorityPda,
    getDistributeInstruction,
    getTaxMarketDecoder,
    getTaxMarketSize,
    SUITE_SLOT,
    SUITE_TREASURY,
    TAX_AMM_PROGRAM_ADDRESS,
    TAX_MARKET_DISCRIMINATOR,
    type TaxMarket,
} from 'tax-amm-scripts/client/index.ts';

import type { JobUnit, KeeperJob, KeeperProduct } from './index.ts';

/** The all-zero key: an unused tax recipient slot, and the burn slot's wallet. */
const DEFAULT_ADDRESS = address('11111111111111111111111111111111');
const DISTRIBUTE = 'distribute';

/** The wallet a slot pays, or null when the slot has none to pay. */
function slotWallet(state: TaxMarket, slot: number): Address | null {
    if (slot === BURN_SLOT) return DEFAULT_ADDRESS;
    if (slot === SUITE_SLOT) return SUITE_TREASURY;
    const wallet = state.recipients[slot];
    return wallet === undefined || wallet === DEFAULT_ADDRESS ? null : wallet;
}

/** The tax-side mint's token program, and its transfer hook program if it has one. */
async function mintFacts(rpc: Rpc<GetAccountInfoApi>, mint: Address): Promise<{ tokenProgram: Address; hookProgram: Address | null }> {
    const account = await fetchEncodedAccount(rpc, mint, { commitment: 'confirmed' });
    if (!account.exists) throw new Error(`the tax-side mint ${mint} does not exist`);
    const tokenProgram = account.programAddress;
    if (tokenProgram === TOKEN_PROGRAM_ADDRESS) return { tokenProgram, hookProgram: null };
    if (tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) throw new Error(`the tax-side mint ${mint} is owned by ${tokenProgram}, not a token program`);
    const { data } = decodeMint(account);
    const hook = data.extensions.__option === 'Some' ? data.extensions.value.find((extension) => extension.__kind === 'TransferHook') : undefined;
    const hookProgram = hook && hook.__kind === 'TransferHook' && hook.programId !== DEFAULT_ADDRESS ? hook.programId : null;
    return { tokenProgram, hookProgram };
}

/** Whether a `Program data:` log line carries a `Distributed` event. */
function isDistributedEvent(line: string): boolean {
    if (!line.startsWith('Program data: ')) return false;
    const bytes = getBase64Encoder().encode(line.slice('Program data: '.length));
    return DISTRIBUTED_EVENT_DISCRIMINATOR.every((byte, i) => bytes[i] === byte);
}

const distribute: KeeperJob<TaxMarket> = {
    name: DISTRIBUTE,
    pass: 'daily',
    discriminator: DISTRIBUTE_DISCRIMINATOR,

    due(state) {
        const units: JobUnit[] = [];
        state.owed.forEach((owed, slot) => {
            // An unused recipient slot is refused (UnusedSlot), and can't be owed anything anyway.
            if (owed > 0n && slotWallet(state, slot) !== null) units.push({ job: DISTRIBUTE, key: `${DISTRIBUTE}:${slot}`, slot, owed });
        });
        return units;
    },

    async build({ rpc, marketState, state, unit, payer }) {
        const slot = unit.slot!;
        const wallet = slotWallet(state, slot);
        if (wallet === null) throw new Error(`tax slot ${slot} has no wallet to pay`);
        const taxMint = state.mints[state.taxSide]!;
        const taxVault = state.vaults[state.taxSide]!;
        const { tokenProgram, hookProgram } = await mintFacts(rpc, taxMint);
        const [recipientTokenAccount] = await findAssociatedTokenPda({ owner: wallet, mint: taxMint, tokenProgram });
        const [vaultAuthority] = await findAuthorityPda({ marketState });
        const instruction = getDistributeInstruction({
            payer,
            marketState,
            vaultAuthority,
            taxVault,
            taxMint,
            recipient: wallet,
            recipientTokenAccount,
            tokenProgram,
            slot,
        });
        const burn = slot === BURN_SLOT;
        const accounts = instruction.accounts.map((meta) =>
            // The burn lowers the mint's supply, so only the burn takes the mint writable.
            burn && meta.address === taxMint ? { ...meta, role: AccountRole.WRITABLE } : meta,
        );
        // A payout transfers, so a hooked mint's hook runs and needs its accounts; a burn does not.
        const hookAccounts =
            hookProgram === null || burn
                ? []
                : await resolveExtraAccountMetasForExecute({
                      rpc,
                      transferHookProgramAddress: hookProgram,
                      source: taxVault,
                      mint: taxMint,
                      destination: recipientTokenAccount,
                      owner: vaultAuthority,
                      amount: unit.owed ?? state.owed[slot]!,
                  });
        return [{ ...instruction, accounts: [...accounts, ...hookAccounts] } as Instruction];
    },

    refusals: { nothingToDo: [], laterSlot: [] },

    didNothing(logs) {
        return !logs.some(isDistributedEvent);
    },
};

export const taxAmm: KeeperProduct<TaxMarket> = {
    name: 'tax-amm',
    programAddress: TAX_AMM_PROGRAM_ADDRESS,
    isMarket(data) {
        return data.length === getTaxMarketSize() && TAX_MARKET_DISCRIMINATOR.every((byte, i) => data[i] === byte);
    },
    decode(data) {
        return getTaxMarketDecoder().decode(data);
    },
    jobs: [distribute],
};
