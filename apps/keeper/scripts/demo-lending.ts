// For the keeper's devnet demo of the lending AMM's `rebalance`: trades the lending AMM's devnet
// demo market (deployments/devnet-demo-lending-amm.json) through the router so the buffer leaves
// its band, then waits for the keeper runner's `rebalance` and prints, for the PR, the swap's and
// the rebalance's signatures, the buffer's share of the lent side before the swap, after it and
// after the rebalance, and how long the runner took.
//
//   node apps/keeper/scripts/demo-lending.ts --payer ~/.config/testing-pipeline/devnet/wallet.json --buy <lamports>
//   node apps/keeper/scripts/demo-lending.ts --payer ~/.config/testing-pipeline/devnet/wallet.json --sell <token units>
//   node apps/keeper/scripts/demo-lending.ts --share       # only print the buffer's share
//
// The payer holds the demo token and a wrapped-SOL account since the demo market's creation. It
// reads and sends through KEEPER_RPC_URL, or Alchemy's devnet endpoint from ALCHEMY_API_KEY, and
// waits for a `rebalance` paid for by the keeper wallet (`--keeper <address>`, by default the
// published keeper address).

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import {
    address,
    appendTransactionMessageInstructions,
    createKeyPairSignerFromBytes,
    createSolanaRpc,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type Address,
    type Instruction,
    type KeyPairSigner,
    type Signature,
} from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import * as pipeline from '@pipeline-placeholder/sdk';
import { lendingAmm, type LendingMarket } from 'keeper-jobs';
import { refreshReserveInstruction, REFRESH_AFTER_SLOTS } from 'keeper-jobs/lending-amm.ts';
import { LENDING_AMM_PROGRAM_ADDRESS, parseRebalancedEvent, REBALANCED_EVENT_DISCRIMINATOR, RebalanceDirection } from 'lending-amm-scripts/client/index.ts';

import { loadSettings } from '../src/settings.ts';

const { values } = parseArgs({ options: { payer: { type: 'string' }, buy: { type: 'string' }, sell: { type: 'string' }, share: { type: 'boolean', default: false }, wait: { type: 'string', default: '120' }, keeper: { type: 'string', default: '8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2' } } });
const record = JSON.parse(readFileSync(new URL('../../../deployments/devnet-demo-lending-amm.json', import.meta.url), 'utf8')) as { record: [string, string][] };
const named = (label: string) => address(record.record.find(([name]) => name === label)![1]);
const market = named('demo market');
const marketState = named('demo market state');
const rpc = createSolanaRpc(loadSettings({ ...process.env, KEEPER_KEYPAIR: 'unused' }).rpcUrl);
const KEEPER_WALLET = address(values.keeper!);
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const commitment = 'confirmed' as const;

const bytes = (data: string) => new Uint8Array(Buffer.from(data, 'base64'));

/** The market with the accounts its keeper entry watches, read in one request. */
async function marketNow(): Promise<LendingMarket> {
    const first = await rpc.getAccountInfo(marketState, { encoding: 'base64', commitment }).send();
    const watches = lendingAmm.watches!(bytes(first.value!.data[0]));
    const { value } = await rpc.getMultipleAccounts([marketState, ...watches], { encoding: 'base64', commitment }).send();
    return lendingAmm.decode(bytes(value[0]!.data[0]), new Map(watches.map((account, i) => [account, value[i + 1] ? bytes(value[i + 1]!.data[0]) : null])));
}

/** The buffer's share of `L = B + V`, the cTokens valued at the reserve's stored rate. */
function share(buffer: bigint, ctokens: bigint, state: LendingMarket) {
    const reserve = state.kamino!.reserve;
    const value = ctokens === 0n ? 0n : (ctokens * reserve.totalSupplySf) / (reserve.mintTotalSupply << 60n);
    const bps = buffer + value === 0n ? 0n : (buffer * 10_000n) / (buffer + value);
    return `${(Number(bps) / 100).toFixed(2)}% (B ${buffer}, V ${value}, ${ctokens} cTokens)`;
}

async function transaction(signature: Signature) {
    for (let attempt = 0; attempt < 30; attempt++) {
        const found = await rpc.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
        if (found?.meta) return found;
        await sleep(1_000);
    }
    throw new Error(`the RPC served no transaction ${signature}`);
}

/** The buffer's share right after `signature`, from the balances it left in the buffer vault and the cToken account. */
async function shareAfter(signature: Signature): Promise<string> {
    const state = await marketNow();
    const found = await transaction(signature);
    const keys = [...found.transaction.message.accountKeys, ...(found.meta!.loadedAddresses?.writable ?? []), ...(found.meta!.loadedAddresses?.readonly ?? [])];
    const after = (account: Address, otherwise: bigint) => {
        const entry = found.meta!.postTokenBalances?.find((balance) => keys[balance.accountIndex] === account);
        return entry ? BigInt(entry.uiTokenAmount.amount) : otherwise;
    };
    return share(after(state.bufferVault, state.buffer), after(state.ctokenAccount, state.ctokens), state);
}

async function send(payer: KeyPairSigner, instructions: Instruction[]): Promise<Signature> {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment }).send();
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', skipPreflight: false, preflightCommitment: commitment }).send();
    const signature = getSignatureFromTransaction(signed);
    for (let attempt = 0; attempt < 90; attempt++) {
        const { value } = await rpc.getSignatureStatuses([signature]).send();
        if (value[0]?.err) throw new Error(`${signature} failed: ${JSON.stringify(value[0].err)}`);
        if (value[0]?.confirmationStatus === 'confirmed' || value[0]?.confirmationStatus === 'finalized') return signature;
        await sleep(1_000);
    }
    throw new Error(`${signature} was not confirmed in 90 s`);
}

/** A swap through the router of `amount` from mint `input`, with what the trader keeps of its quote as the minimum. */
async function swap(payer: KeyPairSigner, input: 0 | 1, amount: bigint): Promise<Signature> {
    const state = await marketNow();
    // A quote on a market holding cTokens needs the reserve refreshed within TRADE_MAX_RESERVE_AGE_SLOTS; the keeper keeps it so.
    const age = state.kamino!.slot - state.kamino!.reserve.lastUpdateSlot;
    if (age > REFRESH_AFTER_SLOTS) {
        console.log(`the reserve was last refreshed ${age} slots ago: refreshing it first`);
        await send(payer, [refreshReserveInstruction(state.reserve, state.lendingMarket!, state.kamino!.reserve)]);
    }
    const routerMarket = pipeline.decodeMarket(bytes((await rpc.getAccountInfo(market, { encoding: 'base64', commitment }).send()).value!.data[0]))!;
    const view = pipeline.marketViewFromMarket(market, routerMarket, [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS]);
    const output = (1 - input) as 0 | 1;
    const trade = { mode: pipeline.TradeMode.ExactIn, inputIndex: input, outputIndex: output, amount, trader: payer.address, extra: new Uint8Array() };
    const strategyAccounts = await pipeline.resolveAccounts(rpc, view, trade, payer.address, { commitment });
    const { quote } = await pipeline.quoteStrategy(rpc, view, trade, strategyAccounts, payer.address, { commitment });
    const feeSide = pipeline.marketViewFeeSide(view, view.mints[output]!);
    const kept = feeSide === 'output' ? pipeline.keptAfterOutputFee(quote.amountOut) : quote.amountOut;
    const holding = async (mint: Address) => (await findAssociatedTokenPda({ owner: payer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
    const instruction = await pipeline.swap(
        {
            trader: payer.address,
            strategyProgram: LENDING_AMM_PROGRAM_ADDRESS,
            marketState,
            traderInput: await holding(view.mints[input]!),
            traderOutput: await holding(view.mints[output]!),
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
    console.log(`${input === 1 ? 'buy with' : 'sell'} ${amount}: quoted ${quote.amountOut} out`);
    return send(payer, [instruction]);
}

/** The keeper wallet's first successful rebalance of the market after `after`, waiting up to `seconds`. */
async function keeperRebalance(after: Signature, seconds: number) {
    const deadline = Date.now() + seconds * 1_000;
    while (Date.now() < deadline) {
        const newer = await rpc.getSignaturesForAddress(marketState, { until: after, commitment }).send();
        for (const entry of [...newer].reverse()) {
            if (entry.err) continue;
            const found = await transaction(entry.signature);
            if (found.transaction.message.accountKeys[0] !== KEEPER_WALLET) continue;
            const event = (found.meta!.logMessages ?? [])
                .filter((line) => line.startsWith('Program data: '))
                .map((line) => bytes(line.slice('Program data: '.length)))
                .find((data) => REBALANCED_EVENT_DISCRIMINATOR.every((byte, i) => data[i] === byte));
            if (event) return { signature: entry.signature, blockTime: found.blockTime, event: parseRebalancedEvent(event) };
        }
        await sleep(2_000);
    }
    return null;
}

if ((await rpc.getGenesisHash().send()) !== DEVNET_GENESIS) throw new Error('this demo runs on devnet only');
const before = await marketNow();
console.log(`demo market ${market}, market state ${marketState}`);
console.log(`buffer's share now: ${share(before.buffer, before.ctokens, before)}`);
if (!values.share) {
    if (!values.payer || (values.buy === undefined) === (values.sell === undefined)) throw new Error('give --payer and one of --buy <lamports> or --sell <token units>');
    const payer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(values.payer, 'utf8'))));
    const swapped = values.buy !== undefined ? await swap(payer, 1, BigInt(values.buy)) : await swap(payer, 0, BigInt(values.sell!));
    const swappedAt = (await transaction(swapped)).blockTime;
    console.log(`swap ${swapped}`);
    console.log(`buffer's share after the swap: ${await shareAfter(swapped)}`);
    const rebalance = await keeperRebalance(swapped, Number(values.wait));
    if (!rebalance) {
        console.log(`no rebalance by the keeper wallet ${KEEPER_WALLET} within ${values.wait} s`);
        process.exitCode = 1;
    } else {
        const seconds = rebalance.blockTime !== null && swappedAt !== null ? Number(rebalance.blockTime - swappedAt) : null;
        console.log(`rebalance ${rebalance.signature}: ${RebalanceDirection[rebalance.event.direction]} of ${rebalance.event.liquidity} lamports (${rebalance.event.ctokens} cTokens), ${seconds ?? '?'} s after the swap by block time`);
        console.log(`buffer's share after the rebalance: ${await shareAfter(rebalance.signature)}`);
    }
}
