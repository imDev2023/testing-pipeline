// For the keeper's devnet demo: sells the demo token on the tax AMM's devnet demo market
// (deployments/devnet-demo-tax-amm.json) through the router, so the market owes tax for the
// runner's daily pass to pay out, and prints what each slot is owed and its wallet's balance.
//
//   node apps/keeper/scripts/demo-trade.ts --payer ~/.config/testing-pipeline/devnet/wallet.json [--amount <units>]
//   node apps/keeper/scripts/demo-trade.ts --balances      # only print the owed amounts and balances
//
// The payer holds the demo token and a wrapped-SOL account since the demo market's creation.
// It reads through KEEPER_RPC_URL, or Alchemy's devnet endpoint from ALCHEMY_API_KEY.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
    address,
    appendTransactionMessageInstructions,
    createKeyPairSignerFromBytes,
    createSolanaRpc,
    createTransactionMessage,
    getBase64EncodedWireTransaction,
    getBase64Encoder,
    getSignatureFromTransaction,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type Address,
} from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import * as pipeline from '@pipeline-placeholder/sdk';
import { fetchTaxMarket, SUITE_SLOT, SUITE_TREASURY, TAX_AMM_PROGRAM_ADDRESS } from 'tax-amm-scripts/client/index.ts';

import { loadSettings } from '../src/settings.ts';

const { values } = parseArgs({ options: { payer: { type: 'string' }, amount: { type: 'string', default: '1000000000' }, balances: { type: 'boolean', default: false } } });
const record = JSON.parse(readFileSync(new URL('../../../deployments/devnet-demo-tax-amm.json', import.meta.url), 'utf8')) as { record: [string, string][] };
const named = (label: string) => address(record.record.find(([name]) => name === label)![1]);
const market = named('demo market: market');
const marketState = named('demo market: market state');
const rpc = createSolanaRpc(loadSettings({ ...process.env, KEEPER_KEYPAIR: 'unused' }).rpcUrl);
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

async function balances() {
    const { data } = await fetchTaxMarket(rpc, marketState, { commitment: 'confirmed' });
    const taxMint = data.mints[data.taxSide]!;
    const wallets: [number, Address][] = [
        ...data.recipients.flatMap((wallet, slot): [number, Address][] => (wallet === address('11111111111111111111111111111111') ? [] : [[slot, wallet]])),
        [SUITE_SLOT, SUITE_TREASURY],
    ];
    for (const [slot, wallet] of wallets) {
        const [account] = await findAssociatedTokenPda({ owner: wallet, mint: taxMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
        const found = await rpc.getTokenAccountBalance(account, { commitment: 'confirmed' }).send().catch(() => null);
        console.log(`slot ${slot}: owed ${data.owed[slot]}, wallet ${wallet}, its account ${account} holds ${found?.value.amount ?? 'nothing (no account)'}`);
    }
}

if ((await rpc.getGenesisHash().send()) !== DEVNET_GENESIS) throw new Error('the RPC is not devnet');
if (!values.balances) {
    if (!values.payer) throw new Error('--payer <keypair.json> is required to trade');
    const payer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(values.payer, 'utf8'))));
    const routerMarket = pipeline.decodeMarket(new Uint8Array(getBase64Encoder().encode((await rpc.getAccountInfo(market, { encoding: 'base64' }).send()).value!.data[0])));
    const view = pipeline.marketViewFromMarket(market, routerMarket!, [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS]);
    const amount = BigInt(values.amount!);
    // Sell the demo token (index 0) for wrapped SOL (index 1, the tax side): the sell tax is owed.
    const trade = { mode: pipeline.TradeMode.ExactIn, inputIndex: 0, outputIndex: 1, amount, trader: payer.address, extra: new Uint8Array() };
    const simulation = { commitment: 'confirmed' } as const;
    const strategyAccounts = await pipeline.resolveAccounts(rpc, view, trade, payer.address, simulation);
    const { quote } = await pipeline.quoteStrategy(rpc, view, trade, strategyAccounts, payer.address, simulation);
    // Since Pipeline 0.3 a sale into wrapped SOL pays the router's fee out of what arrived, and the
    // minimum is checked against what the trader keeps (docs/toolchain.md, "Pipeline 0.3").
    const kept = pipeline.marketViewFeeSide(view, view.mints[1]!) === 'output' ? pipeline.keptAfterOutputFee(quote.amountOut) : quote.amountOut;
    const account = async (mint: Address) => (await findAssociatedTokenPda({ owner: payer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
    const swap = await pipeline.swap(
        {
            trader: payer.address,
            strategyProgram: TAX_AMM_PROGRAM_ADDRESS,
            marketState,
            traderInput: await account(view.mints[0]!),
            traderOutput: await account(view.mints[1]!),
            inputVault: view.vaults[0]!,
            inputMint: view.mints[0]!,
            outputMint: view.mints[1]!,
            inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
            outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
            strategyAccounts,
        },
        { mode: pipeline.TradeMode.ExactIn, amountIn: amount, amountOut: 0n, minAmountOut: kept, integratorFeeBps: 0, extra: new Uint8Array() },
    );
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const signed = await signTransactionMessageWithSigners(
        pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayerSigner(payer, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
            (m) => appendTransactionMessageInstructions([swap], m),
        ),
    );
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' }).send();
    const signature = getSignatureFromTransaction(signed);
    for (let i = 0; ; i++) {
        const status = (await rpc.getSignatureStatuses([signature]).send()).value[0];
        if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err, (_, v) => (typeof v === 'bigint' ? `${v}` : v))}`);
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') break;
        if (i > 120) throw new Error(`${signature} not confirmed after 60 s`);
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.log(`sold ${amount} of the demo token for ${quote.amountOut} lamports of wrapped SOL: ${signature}`);
}
await balances();
