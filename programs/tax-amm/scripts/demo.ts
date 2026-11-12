// The tax AMM's demo: lists the strategy on a Pipeline router, creates and seeds a tax
// market and trades it both ways, step by step, building the market creation and the seed
// from metadata.json with Pipeline's TypeScript SDK, as Aviary will, and reading the market
// back with the generated client (client/):
//
//   1. check the program is deployed and the upgrade-authority key is its upgrade authority;
//   2. check metadata.json, and the published copy at the metadata URI;
//   3. register the strategy, signed and paid for by the upgrade authority (once), or point
//      it at a new metadata URI;
//   4. create two test tokens;
//   5. compute, before sending anything, the addresses the creation will use: the router's
//      market and fee accounts, and the tax AMM's market state, vaults and vault authority;
//   6. create a tax market from the metadata's `init` form, with a fee account for each mint
//      and the metadata's `seed` action, in one transaction;
//   7. check every address computed in step 5 exists as what it should be, and read back from
//      the market state exactly the parameters sent, open and holding exactly the seed;
//   8. buy and sell through the router with the SDK, each swap with its quote as the minimum,
//      checking that it delivered the quote and that the quote is the spec's price;
//   9. read the market state back: its reserves, owed amounts and counters must equal this
//      script's own calculation from the spec's formulas (spec-model.ts), to the unit;
//  10. on a local validator only, graduate a token from the stand-in launchpad
//      (launchpad.ts): it calls `pipeline_seed_liquidity`, built from the metadata's
//      `seed_liquidity` form, and the same transaction records the market with
//      `register_existing_market` and both fee accounts; then check the escrows lost exactly
//      the seed, `SeedResult.taken` says so, the market state is open with the launchpad's
//      PDA as its seeder, and trade it both ways as in steps 8 and 9.
//
// Grown from Pipeline's strategy template (scripts/deploy-devnet.ts at 5ad130d). Deploy the
// program first; docs/toolchain.md says how, on a local validator and on devnet.
//
// Usage, from this directory after `pnpm install` (docs/toolchain.md, "Local demo run"):
//
//   node demo.ts --cluster <localnet|devnet|URL> \
//     --payer <keypair.json> --upgrade-authority <keypair.json> \
//     [--metadata-uri <URI>] [--program-id <address>]
//
//   --cluster            localnet (http://127.0.0.1:8899), devnet, or an RPC URL of either;
//                        the cluster's genesis hash must be devnet's, or the URL a local
//                        validator's: devnet only until Pipeline is on mainnet
//   --payer              pays fees, creates the tokens and the market
//   --upgrade-authority  the program's upgrade authority; signs register_strategy and pays
//                        its listing fee (docs/spec/README.md, "Upgrade authority")
//   --metadata-uri       where metadata.json is published (default: this repo's main branch)
//   --program-id         the strategy program (default: the address in declare_id!)
//
// On a local cluster the script airdrops the SOL both keys need; on devnet it never does
// (fund them with devnet-airdrop, docs/toolchain.md).

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
    AccountRole,
    address,
    addSignersToTransactionMessage,
    appendTransactionMessageInstructions,
    createDefaultRpcTransport,
    createKeyPairSignerFromBytes,
    createSolanaRpcFromTransport,
    createTransactionMessage,
    generateKeyPairSigner,
    getAddressDecoder,
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
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getInitializeMint2Instruction,
    getMintSize,
    getMintToInstruction,
    getTransferCheckedInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import * as pipeline from '@pipeline-placeholder/sdk';

import {
    fetchTaxMarket,
    findAuthorityPda,
    findMarketStatePda,
    findVault0Pda,
    findVault1Pda,
    MarketStatus,
    SUITE_SHARE_BPS,
} from './client/index.ts';
import { findSeederPda, graduateInstruction, graduationFromLogs, LAUNCHPAD_PROGRAM_ADDRESS } from './launchpad.ts';
import { price, swap as specSwap, type SpecMarket } from './spec-model.ts';

// Written by Pipeline's scripts/new-strategy.sh; the same address as `declare_id!`.
const DEFAULT_PROGRAM_ID = 'J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t';
// The all-zero key: an unused tax recipient slot.
const DEFAULT_ADDRESS = address('11111111111111111111111111111111');
const DEFAULT_METADATA_URI =
    'https://raw.githubusercontent.com/imDev2023/testing-pipeline/main/programs/tax-amm/metadata.json';

// The demo market: the demo's own choices, in one place, not the program's policy values
// (docs/spec/tax-amm.md, "Where its policy values live"). Taxes are taken in token B; the
// payer is the tax authority, the seeder and the first tax recipient. Token A has 6
// decimals and token B 9, so the seed is 100,000 A against 200 B, and side A prices 50 A
// more than it holds through its virtual reserve.
const MINTED = 1_000_000_000_000n;
const DEMO_MARKET = {
    taxSide: 1,
    buyTaxBps: 300,
    sellTaxBps: 500,
    buyTaxRangeBps: [100, 800],
    sellTaxRangeBps: [0, 900],
    // Tax recipients beyond the payer are fresh addresses; unused slots stay empty.
    otherRecipients: 1,
    shares: [6_000, 3_000, 0, 0],
    burnShareBps: 1_000,
    virtualSide: 0,
    virtualReserve: 50_000_000n,
    seed: [100_000_000_000n, 200_000_000_000n],
    // Buy token A with token B (a buy tax, on the input), then sell some back (a sell tax,
    // on the output): [input index, output index, amount in].
    trades: [
        [1, 0, 1_000_000_000n],
        [0, 1, 300_000n],
    ],
} as const;
// The launch the stand-in launchpad graduates in step 10, on a local validator only: the
// demo market's parameters and seed, from escrows holding more than the seed, so the market
// takes exactly the seed and leaves the rest; the launchpad lends the strategy at most
// `maxPayerLamports` for rent and takes back what it did not spend.
const LAUNCH = {
    decimals: [6, 9],
    escrowed: [150_000_000_000n, 300_000_000_000n],
    maxPayerLamports: 50_000_000n,
} as const;
// The most SOL the strategy's setup may spend on rent; the router returns the rest.
const MAX_CREATOR_LAMPORTS = 100_000_000n;
// What a local run airdrops when a key holds less: the payer creates tokens and a market,
// and the upgrade authority pays the listing fee and the strategy account's rent.
const LOCAL_FUNDING = { payer: 10_000_000_000n, upgradeAuthority: 1_000_000_000n };

// A transaction's most bytes on the wire.
const MAX_TRANSACTION_BYTES = 1232;

const LOCALNET_URL = 'http://127.0.0.1:8899';
const DEVNET_URL = 'https://api.devnet.solana.com';
// What `getGenesisHash` answers on each public cluster; a local validator has its own.
const GENESIS_HASHES = {
    devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
    mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'];

const { values: options } = parseArgs({
    options: {
        cluster: { type: 'string' },
        payer: { type: 'string' },
        'upgrade-authority': { type: 'string' },
        'metadata-uri': { type: 'string', default: DEFAULT_METADATA_URI },
        'program-id': { type: 'string', default: DEFAULT_PROGRAM_ID },
    },
    strict: true,
});

function usage(message: string): never {
    console.error(`${message}\n`);
    console.error(
        'Usage: node demo.ts --cluster <localnet|devnet|URL> --payer <keypair.json> --upgrade-authority <keypair.json> [--metadata-uri <URI>] [--program-id <address>]',
    );
    process.exit(2);
}

/**
 * The RPC URL for `--cluster`, and whether it points at a local validator. Which network it
 * really is gets checked against its genesis hash in `checkCluster`, not from the name.
 */
function clusterUrl(cluster: string | undefined): { url: string; local: boolean } {
    if (!cluster) usage('--cluster is required');
    if (cluster === 'localnet') return { url: LOCALNET_URL, local: true };
    if (cluster === 'devnet') return { url: DEVNET_URL, local: false };
    let host: string;
    try {
        host = new URL(cluster).hostname;
    } catch {
        usage(`--cluster must be localnet, devnet or an RPC URL, not "${cluster}"`);
    }
    return { url: cluster, local: LOCAL_HOSTS.includes(host) };
}

const cluster = clusterUrl(options.cluster);
const payerPath = options.payer ?? usage('--payer is required');
const upgradeAuthorityPath = options['upgrade-authority'] ?? usage('--upgrade-authority is required');
const metadataUri = options['metadata-uri'];
const onDevnet = !cluster.local;

// Public RPC endpoints rate-limit bursts (HTTP 429); retry those with back-off.
const baseTransport = createDefaultRpcTransport({ url: cluster.url });
const retryingTransport = (async (...args: Parameters<typeof baseTransport>) => {
    for (let attempt = 0; ; attempt++) {
        try {
            return await baseTransport(...args);
        } catch (error) {
            if (attempt >= 8 || !String(error).includes('429')) throw error;
            await sleep(500 * 2 ** attempt);
        }
    }
}) as typeof baseTransport;
const rpc = createSolanaRpcFromTransport(retryingTransport);

/** What the run did, printed at the end for the record. */
const record: [string, string][] = [];

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function step(title: string) {
    console.log(`\n== ${title}`);
}

function info(message: string) {
    console.log(`   ${message}`);
}

function fail(message: string): never {
    console.error(`\nStopped: ${message}`);
    process.exit(1);
}

/** An explorer link on devnet; on a local validator the bare value, which no explorer knows. */
function explorer(kind: 'tx' | 'address', value: string) {
    return onDevnet ? `https://orbmarkets.io/${kind}/${value}?cluster=devnet` : value;
}

/** Stops unless the cluster is devnet, or a local validator that is not a public cluster. */
async function checkCluster() {
    const genesis = await rpc.getGenesisHash().send();
    if (genesis === GENESIS_HASHES.mainnet || genesis === GENESIS_HASHES.testnet) {
        fail(`${cluster.url} is ${genesis === GENESIS_HASHES.mainnet ? 'mainnet' : 'testnet'}; this demo runs only on devnet or a local validator`);
    }
    if (!cluster.local && genesis !== GENESIS_HASHES.devnet) {
        fail(`${cluster.url} is not devnet (genesis hash ${genesis}); this demo runs only on devnet or a local validator`);
    }
    info(`cluster: ${cluster.local ? 'a local validator' : 'devnet'} (genesis hash ${genesis})`);
}

async function loadKey(path: string): Promise<KeyPairSigner> {
    const bytes = new Uint8Array(JSON.parse(readFileSync(path, 'utf8')));
    return createKeyPairSignerFromBytes(bytes);
}

async function waitFor(label: string, signature: Signature) {
    for (let i = 0; ; i++) {
        const { value } = await rpc.getSignatureStatuses([signature]).send();
        const status = value[0];
        if (status?.err) fail(`${label} failed: ${JSON.stringify(status.err)} (${explorer('tx', signature)})`);
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
        if (i > 120) fail(`${label}: not confirmed after 60 s (${explorer('tx', signature)})`);
        await sleep(500);
    }
}

/** Sends a transaction and waits for confirmation by polling (public RPCs often refuse WebSockets). */
async function send(label: string, feePayer: KeyPairSigner, instructions: Instruction[], extra: KeyPairSigner[] = []) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
        (m) => addSignersToTransactionMessage(extra, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signed);
    const wire = getBase64EncodedWireTransaction(signed);
    await rpc.sendTransaction(wire, { encoding: 'base64' }).send();
    await waitFor(label, signature);
    const bytes = Buffer.from(wire, 'base64').length;
    info(`${label}: ${explorer('tx', signature)} (${bytes} of ${MAX_TRANSACTION_BYTES} bytes)`);
    record.push([label, signature]);
    return signature;
}

/** On a local validator, tops `key` up to `amount` lamports. */
async function fundLocally(label: string, key: Address, amount: bigint) {
    const { value: balance } = await rpc.getBalance(key, { commitment: 'confirmed' }).send();
    if (balance >= amount) return;
    // A validator that has just started can refuse its first airdrop; the next one works.
    for (let attempt = 0; ; attempt++) {
        try {
            const signature = await rpc.requestAirdrop(key, lamports(amount - balance)).send();
            await waitFor(`airdrop to the ${label}`, signature);
            info(`airdropped ${Number(amount - balance) / 1e9} SOL to the ${label}`);
            return;
        } catch (error) {
            if (attempt >= 5) throw error;
            await sleep(2_000);
        }
    }
}

async function accountData(account: Address): Promise<Uint8Array | null> {
    const { value } = await rpc.getAccountInfo(account, { encoding: 'base64', commitment: 'confirmed' }).send();
    return value ? new Uint8Array(Buffer.from(value.data[0], 'base64')) : null;
}

/** A token account's balance. */
async function tokenBalance(account: Address): Promise<bigint> {
    const { value } = await rpc.getTokenAccountBalance(account, { commitment: 'confirmed' }).send();
    return BigInt(value.amount);
}

/** The router's swap event in a confirmed transaction. */
async function swapEvent(signature: Signature) {
    const tx = await rpc
        .getTransaction(signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
        .send();
    if (!tx?.meta?.innerInstructions) fail(`transaction ${signature} not found`);
    const keys = [
        ...tx.transaction.message.accountKeys,
        ...(tx.meta.loadedAddresses?.writable ?? []),
        ...(tx.meta.loadedAddresses?.readonly ?? []),
    ];
    const event = pipeline
        .extractEventsFromInnerInstructions(keys, tx.meta.innerInstructions)
        .find((candidate) => candidate.type === 'Swap');
    if (!event || event.type !== 'Swap') fail(`transaction ${signature} has no swap event`);
    return event.data;
}

async function walletTokenAccount(owner: Address, mint: Address): Promise<Address> {
    const [account] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    return account;
}

/** A new SPL Token mint, with `amount` minted to the wallet. */
async function createTestToken(wallet: KeyPairSigner, label: string, decimals: number, amount: bigint) {
    const mint = await generateKeyPairSigner();
    const space = BigInt(getMintSize());
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
    const holder = await walletTokenAccount(wallet.address, mint.address);
    await send(
        `create ${label}`,
        wallet,
        [
            getCreateAccountInstruction({
                payer: wallet,
                newAccount: mint,
                lamports: rent,
                space,
                programAddress: TOKEN_PROGRAM_ADDRESS,
            }),
            getInitializeMint2Instruction({ mint: mint.address, decimals, mintAuthority: wallet.address }),
            await getCreateAssociatedTokenIdempotentInstructionAsync({
                payer: wallet,
                owner: wallet.address,
                mint: mint.address,
            }),
            getMintToInstruction({ mint: mint.address, token: holder, mintAuthority: wallet, amount }),
        ],
        [mint],
    );
    info(`${label}: ${mint.address}`);
    return mint.address;
}

/** The creation parameters as the demo sends them, in the client's names. */
type SentParams = {
    taxSide: number;
    buyTaxBps: number;
    sellTaxBps: number;
    buyTaxMinBps: number;
    buyTaxMaxBps: number;
    sellTaxMinBps: number;
    sellTaxMaxBps: number;
    taxAuthority: Address;
    seeder: Address;
    recipients: Address[];
    shares: number[];
    burnShareBps: number;
    virtualSide: number;
    virtualReserve: bigint;
};

/** The demo market's creation parameters, with the given tax authority, seeder and recipients. */
function demoParams(taxAuthority: Address, seeder: Address, recipients: Address[]): SentParams {
    return {
        taxSide: DEMO_MARKET.taxSide,
        buyTaxBps: DEMO_MARKET.buyTaxBps,
        sellTaxBps: DEMO_MARKET.sellTaxBps,
        buyTaxMinBps: DEMO_MARKET.buyTaxRangeBps[0],
        buyTaxMaxBps: DEMO_MARKET.buyTaxRangeBps[1],
        sellTaxMinBps: DEMO_MARKET.sellTaxRangeBps[0],
        sellTaxMaxBps: DEMO_MARKET.sellTaxRangeBps[1],
        taxAuthority,
        seeder,
        recipients,
        shares: [...DEMO_MARKET.shares],
        burnShareBps: DEMO_MARKET.burnShareBps,
        virtualSide: DEMO_MARKET.virtualSide,
        virtualReserve: DEMO_MARKET.virtualReserve,
    };
}

/** The metadata's arguments, in its own names: the arrays flattened, as metadata has none. */
function metadataArgs(sent: SentParams): Record<string, number | bigint | Address> {
    const args: Record<string, number | bigint | Address> = {
        tax_side: sent.taxSide,
        buy_tax_bps: sent.buyTaxBps,
        sell_tax_bps: sent.sellTaxBps,
        buy_tax_min_bps: sent.buyTaxMinBps,
        buy_tax_max_bps: sent.buyTaxMaxBps,
        sell_tax_min_bps: sent.sellTaxMinBps,
        sell_tax_max_bps: sent.sellTaxMaxBps,
        tax_authority: sent.taxAuthority,
        seeder: sent.seeder,
        burn_share_bps: sent.burnShareBps,
        virtual_side: sent.virtualSide,
        virtual_reserve: sent.virtualReserve,
    };
    sent.recipients.forEach((recipient, i) => (args[`recipient_${i}`] = recipient));
    sent.shares.forEach((share, i) => (args[`share_${i}`] = share));
    return args;
}

/** The parameters the market state holds, in the client's names, for comparing with those sent. */
function paramsOf(state: Awaited<ReturnType<typeof fetchTaxMarket>>['data']): SentParams {
    return {
        taxSide: state.taxSide,
        buyTaxBps: state.buyTaxBps,
        sellTaxBps: state.sellTaxBps,
        buyTaxMinBps: state.buyTaxMinBps,
        buyTaxMaxBps: state.buyTaxMaxBps,
        sellTaxMinBps: state.sellTaxMinBps,
        sellTaxMaxBps: state.sellTaxMaxBps,
        taxAuthority: state.taxAuthority,
        seeder: state.seeder,
        recipients: [...state.recipients],
        shares: [...state.shares],
        burnShareBps: state.burnShareBps,
        virtualSide: state.virtualSide,
        virtualReserve: state.virtualReserve,
    };
}

/** The spec's own account of a market just seeded with `seed`, from what was sent. */
function freshSpec(sent: SentParams, seed: readonly bigint[]): SpecMarket {
    return {
        suiteShareBps: SUITE_SHARE_BPS,
        taxSide: sent.taxSide,
        buyTaxBps: sent.buyTaxBps,
        sellTaxBps: sent.sellTaxBps,
        shares: [...sent.shares],
        burnShareBps: sent.burnShareBps,
        virtualSide: sent.virtualSide,
        virtualReserve: sent.virtualReserve,
        reserves: [...seed],
        owed: [0n, 0n, 0n, 0n, 0n, 0n],
        taxCollected: 0n,
        volume: [0n, 0n],
        swapCount: 0n,
    };
}

const show = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

/**
 * Buys and sells through the router with the SDK, each swap with its quote as the minimum,
 * and stops unless each quote is the spec's price and each swap delivered it; `spec` follows
 * every swap.
 */
async function tradeBothWays(
    payer: KeyPairSigner,
    programId: Address,
    view: pipeline.MarketView,
    spec: SpecMarket,
    trades: readonly (readonly [number, number, bigint])[],
    names: readonly string[],
) {
    const payerAccounts = await Promise.all(view.mints.map((mint) => walletTokenAccount(payer.address, mint)));
    for (const [input, output, amount] of trades) {
        const label = `swap ${amount} ${names[input]} for ${names[output]}`;
        const trade = {
            mode: pipeline.TradeMode.ExactIn,
            inputIndex: input,
            outputIndex: output,
            amount,
            trader: payer.address,
            extra: new Uint8Array(),
        };
        // At the commitment the demo confirms at, so the quote sees the swap before it.
        const simulation = { commitment: 'confirmed' } as const;
        const strategyAccounts = await pipeline.resolveAccounts(rpc, view, trade, payer.address, simulation);
        const { quote, unitsConsumed } = await pipeline.quoteStrategy(
            rpc,
            view,
            trade,
            strategyAccounts,
            payer.address,
            simulation,
        );
        const expected = price(spec, input, output, amount);
        if (typeof expected === 'string') fail(`${label}: the spec refuses it, since ${expected}`);
        if (quote.amountIn !== amount || quote.amountOut !== expected.out) {
            fail(`${label}: quoted ${quote.amountOut} for ${quote.amountIn}, but the spec prices ${expected.out} for ${amount}`);
        }
        info(`${label}: quoted ${quote.amountOut}, the spec's price, with a tax of ${expected.tax} (${unitsConsumed} CU)`);
        const before = await tokenBalance(payerAccounts[output]!);
        const signature = await send(label, payer, [
            await pipeline.swap(
                {
                    trader: payer.address,
                    strategyProgram: programId,
                    marketState: view.marketState,
                    traderInput: payerAccounts[input]!,
                    traderOutput: payerAccounts[output]!,
                    inputVault: view.vaults[input]!,
                    inputMint: view.mints[input]!,
                    outputMint: view.mints[output]!,
                    inputTokenProgram: view.tokenPrograms[input]!,
                    outputTokenProgram: view.tokenPrograms[output]!,
                    strategyAccounts,
                },
                {
                    mode: pipeline.TradeMode.ExactIn,
                    amountIn: amount,
                    amountOut: 0n,
                    minAmountOut: quote.amountOut,
                    integratorFeeBps: 0,
                    extra: new Uint8Array(),
                },
            ),
        ]);
        const received = (await tokenBalance(payerAccounts[output]!)) - before;
        const event = await swapEvent(signature);
        if (received !== quote.amountOut || event.received !== quote.amountOut || event.netSent !== amount) {
            fail(`${label}: received ${received} (event: ${event.received} for ${event.netSent}), quoted ${quote.amountOut} for ${amount}`);
        }
        info(`${label}: received exactly the quote, Pipeline's fee ${event.pipelineFee}`);
        specSwap(spec, input, output, event.netSent);
    }
}

/** Stops unless the market state's reserves, owed amounts and counters equal `spec`'s. */
async function checkBooks(marketState: Address, spec: SpecMarket, virtualReserve: bigint) {
    const { data: traded } = await fetchTaxMarket(rpc, marketState, { commitment: 'confirmed' });
    const books = {
        reserves: [traded.reserves, spec.reserves],
        owed: [traded.owed, spec.owed],
        taxCollected: [traded.taxCollected, spec.taxCollected],
        volume: [traded.volume, spec.volume],
        swapCount: [traded.swapCount, spec.swapCount],
    };
    for (const [key, [got, wanted]] of Object.entries(books)) {
        if (show(got) !== show(wanted)) fail(`the market state's ${key} is ${show(got)}, but the spec's formulas give ${show(wanted)}`);
        info(`${key.padEnd(14)} ${show(got)}`);
    }
    if (traded.virtualReserve !== virtualReserve) fail('the virtual reserve changed');
    info("reserves, owed amounts and counters equal the spec's formulas to the unit");
}

/**
 * Step 10, on a local validator: the stand-in launchpad graduates a token into a tax market
 * through `pipeline_seed_liquidity`, built from the metadata's `seed_liquidity` form, and the
 * same transaction records it with `register_existing_market` and both fee accounts; then
 * the market trades both ways through the router at the spec's prices.
 */
async function graduateFromLaunchpad(payer: KeyPairSigner, programId: Address, metadata: pipeline.StrategyMetadata) {
    const launchpad = await pipeline.inspectProgram(rpc, LAUNCHPAD_PROGRAM_ADDRESS, { hashExecutable: false });
    if (!launchpad.deployed) {
        fail(`the stand-in launchpad is not at ${LAUNCHPAD_PROGRAM_ADDRESS}: start the validator with scripts/local-validator.sh`);
    }
    const form = metadata.seed_liquidity as pipeline.MetadataInit | undefined;
    if (!form?.market_state || !form.args || !form.accounts) fail('metadata.json needs its seed_liquidity form');

    const mintA = await createTestToken(payer, 'launched token', LAUNCH.decimals[0], MINTED);
    const mintB = await createTestToken(payer, 'launch quote token', LAUNCH.decimals[1], MINTED);
    const mints = [mintA, mintB];
    const tokenPrograms = mints.map(() => TOKEN_PROGRAM_ADDRESS);
    const seeder = await findSeederPda(payer.address);
    const escrows = await Promise.all(
        mints.map(async (mint) => (await findAssociatedTokenPda({ owner: seeder, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]),
    );
    const payerAccounts = await Promise.all(mints.map((mint) => walletTokenAccount(payer.address, mint)));
    await send(
        'fill the launch escrows',
        payer,
        await Promise.all(
            mints.flatMap((mint, i) => [
                getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: seeder, mint }),
                Promise.resolve(
                    getTransferCheckedInstruction({
                        source: payerAccounts[i]!,
                        mint,
                        destination: escrows[i]!,
                        authority: payer,
                        amount: LAUNCH.escrowed[i]!,
                        decimals: LAUNCH.decimals[i]!,
                    }),
                ),
            ]),
        ),
    );
    info(`seeder ${seeder}, the launchpad's PDA for this creator; escrows ${escrows.join(', ')}`);

    // The metadata's form resolves the market state and the strategy's own accounts before
    // anything is sent. `data` is the creation parameters; their seeder is ignored, since the
    // launchpad's PDA seeds the market, so the demo sends the default key there.
    const recipients = [payer.address, DEFAULT_ADDRESS, DEFAULT_ADDRESS, DEFAULT_ADDRESS];
    const sent = { ...demoParams(payer.address, DEFAULT_ADDRESS, recipients), shares: [9_000, 0, 0, 0] };
    const resolved = await pipeline.resolveInit({
        init: form,
        strategyProgram: programId,
        creator: payer.address,
        args: metadataArgs(sent),
        inputs: { seeder, mint_0: mintA, mint_1: mintB },
        tokenPrograms: Object.fromEntries(mints.map((mint) => [mint, TOKEN_PROGRAM_ADDRESS])),
        rpc,
    });
    const marketState = resolved.marketState;
    const [expectedState] = await findMarketStatePda({ seeder, mint0: mintA, mint1: mintB }, { programAddress: programId });
    if (marketState !== expectedState) fail(`the metadata resolved market state ${marketState}, not the program's PDA ${expectedState}`);
    const [authority] = await findAuthorityPda({ marketState }, { programAddress: programId });
    const [vault0] = await findVault0Pda({ marketState, mint0: mintA }, { programAddress: programId });
    const [vault1] = await findVault1Pda({ marketState, mint1: mintB }, { programAddress: programId });
    const vaults = [vault0, vault1];
    if (resolved.strategyAccounts.map((account) => account.address).join() !== [authority, vault0, vault1].join()) {
        fail("the metadata's seed_liquidity accounts are not the program's PDAs");
    }
    const market = resolved.market;
    const feeAccounts = await Promise.all(mints.map((mint) => pipeline.feeAccountPda(market, mint, TOKEN_PROGRAM_ADDRESS)));
    for (const [label, account] of [
        ['router market', market],
        ['market state', marketState],
        ['vault, launched token', vault0],
        ['vault, quote token', vault1],
        ['fee account, launched', feeAccounts[0]!],
        ['fee account, quote', feeAccounts[1]!],
    ] as const) {
        if (await accountData(account)) fail(`the ${label} ${account} exists before the graduation`);
        info(`${label.padEnd(22)} ${account}`);
    }

    const graduate = await graduateInstruction({
        creator: payer.address,
        strategyProgram: programId,
        amounts: DEMO_MARKET.seed,
        data: resolved.initData,
        maxPayerLamports: LAUNCH.maxPayerLamports,
        accounts: [
            { address: marketState, role: AccountRole.WRITABLE },
            // A tax market issues no LP shares, so the LP recipient is ignored.
            { address: payer.address, role: AccountRole.READONLY },
            ...mints.flatMap((mint, i) => [
                { address: mint, role: AccountRole.READONLY },
                { address: escrows[i]!, role: AccountRole.WRITABLE },
                { address: tokenPrograms[i]!, role: AccountRole.READONLY },
            ]),
            ...resolved.strategyAccounts,
        ],
    });
    const listing = await pipeline.registerAndListMarketInstructions({
        payer: payer.address,
        strategyProgram: programId,
        marketState,
        mints: mints.map((mint) => ({ mint, tokenProgram: TOKEN_PROGRAM_ADDRESS })),
    });
    const signature = await send('graduate (pipeline_seed_liquidity) + register_existing_market + init_fee_account x2', payer, [
        graduate,
        ...listing,
    ]);
    info(`market ${explorer('address', market)}`);
    record.push(['seeded market', market], ['seeded market state', marketState]);

    // What the transaction did: the launchpad's return data, and the strategy's cost.
    const transaction = await rpc
        .getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' })
        .send();
    const logs = transaction?.meta?.logMessages ?? fail('the graduation left no logs');
    const graduation = graduationFromLogs(logs) ?? fail("the launchpad's return data is missing");
    const left = await Promise.all(escrows.map(async (escrow, i) => LAUNCH.escrowed[i]! - (await tokenBalance(escrow))));
    if (show(graduation.leftEscrows) !== show(DEMO_MARKET.seed) || show(left) !== show(DEMO_MARKET.seed)) {
        fail(`the escrows lost ${show(left)} (the launchpad measured ${show(graduation.leftEscrows)}), not the seed ${show(DEMO_MARKET.seed)}`);
    }
    if (show(graduation.taken) !== show(left) || graduation.lpAmount !== 0n) {
        fail(`SeedResult says taken ${show(graduation.taken)}, lp_amount ${graduation.lpAmount}, but ${show(left)} left the escrows`);
    }
    info(`SeedResult: taken ${show(graduation.taken)}, exactly what left the escrows, lp_amount 0`);
    const consumed = logs
        .map((line) => line.match(new RegExp(`^Program ${programId} consumed (\\d+) of`))?.[1])
        .find((units) => units !== undefined);
    info(`pipeline_seed_liquidity: ${consumed} CU`);

    const routerMarket = pipeline.decodeMarket((await accountData(market)) ?? new Uint8Array());
    if (!routerMarket) fail(`the router has no market at ${market}`);
    const view = pipeline.marketViewFromMarket(market, routerMarket, tokenPrograms);
    if (view.mints.join() !== mints.join() || view.vaults.join() !== vaults.join()) {
        fail(`the router recorded mints ${view.mints.join(', ')} and vaults ${view.vaults.join(', ')}`);
    }
    for (const feeAccount of feeAccounts) {
        if (!(await accountData(feeAccount))) fail(`fee account ${feeAccount} was not created`);
    }
    info('router market: recorded in the same transaction, with both fee accounts');
    const { data: state } = await fetchTaxMarket(rpc, marketState, { commitment: 'confirmed' });
    const wanted = { ...sent, seeder };
    if (show(paramsOf(state)) !== show(wanted)) {
        fail(`the market state holds ${show(paramsOf(state))}, but ${show(wanted)} was sent, with the launchpad's seeder`);
    }
    if (state.status !== MarketStatus.Open || state.marketSigner !== market || show(state.reserves) !== show(DEMO_MARKET.seed)) {
        fail(`the market state is ${state.status} with reserves ${show(state.reserves)} and market signer ${state.marketSigner}`);
    }
    info("the market state holds the parameters sent, with the launchpad's PDA as its seeder; open, holding the seed");

    const spec = freshSpec(wanted, DEMO_MARKET.seed);
    await tradeBothWays(payer, programId, view, spec, DEMO_MARKET.trades, ['launched token', 'quote token']);
    await checkBooks(marketState, spec, wanted.virtualReserve);
    record.push(['seeded market, traded', 'graduated, recorded, traded at the spec\'s prices']);
}

async function main() {
    const payer = await loadKey(payerPath);
    const upgradeAuthority = await loadKey(upgradeAuthorityPath);
    const programId = address(options['program-id']);
    console.log(`Pipeline router ${pipeline.PIPELINE_PROGRAM_ADDRESS} on ${cluster.url}`);
    console.log(`Strategy ${programId}`);
    console.log(`Payer ${payer.address}, upgrade authority ${upgradeAuthority.address}`);
    record.push(['strategy program', programId]);
    await checkCluster();

    if (cluster.local) {
        step('0. Funding both keys on the local validator');
        await fundLocally('payer', payer.address, LOCAL_FUNDING.payer);
        await fundLocally('upgrade authority', upgradeAuthority.address, LOCAL_FUNDING.upgradeAuthority);
    }

    step('1. Checking the program');
    const program = await pipeline.inspectProgram(rpc, programId, { hashExecutable: false });
    if (!program.deployed) {
        fail(`nothing is deployed at ${programId}. Deploy it first (docs/toolchain.md).`);
    }
    if (program.upgradeAuthority !== upgradeAuthority.address) {
        fail(
            `registration must be signed by the program's upgrade authority (${program.upgradeAuthority ?? 'none: the program is frozen'}), not ${upgradeAuthority.address}. Pass its key as --upgrade-authority.`,
        );
    }
    info(`deployed (${program.loader} loader), upgrade authority ${program.upgradeAuthority}`);

    step('2. Checking metadata');
    const local = pipeline.parseStrategyMetadata(
        JSON.parse(readFileSync(new URL('../metadata.json', import.meta.url), 'utf8')),
    );
    if (!local.ok) {
        fail(`metadata.json is invalid:\n   ${local.errors.join('\n   ')}`);
    }
    if (local.warnings.length > 0) {
        fail(`metadata.json must pass with zero warnings:\n   ${local.warnings.join('\n   ')}`);
    }
    info(`metadata.json is valid with zero warnings: "${local.value.name}"`);
    const published = await pipeline.fetchStrategyMetadata(metadataUri);
    if (published.ok) {
        info(`${metadataUri} is valid`);
    } else {
        info(`warning: ${metadataUri} can't be used yet (${published.reason}: ${published.errors.join('; ')})`);
        info('desks will show the strategy without metadata until it can be fetched');
    }
    const metadata = local.value;
    if (!metadata.init) {
        fail('metadata.json needs `init` for this demo');
    }

    step('3. Registering the strategy');
    const config = pipeline.decodeConfig((await accountData(await pipeline.configPda())) ?? new Uint8Array());
    if (!config) {
        fail('the Pipeline router has no config on this cluster');
    }
    const strategyData = await accountData(await pipeline.strategyPda(programId));
    if (!strategyData) {
        info(`registering, which costs the listing fee: ${Number(config.listingFeeLamports) / 1e9} SOL`);
        await send(
            'register_strategy',
            payer,
            [
                await pipeline.registerStrategy({
                    payer: upgradeAuthority.address,
                    registrar: upgradeAuthority.address,
                    strategyProgram: programId,
                    listingFeeRecipient: config.listingFeeRecipient,
                    metadataUri,
                    maxListingFeeLamports: config.listingFeeLamports,
                }),
            ],
            [upgradeAuthority],
        );
    } else if (pipeline.decodeStrategy(strategyData)?.metadataUri !== metadataUri) {
        info('already registered; pointing it at the new metadata URI');
        await send(
            'update_metadata',
            payer,
            [
                await pipeline.updateMetadata({
                    registrar: upgradeAuthority.address,
                    strategyProgram: programId,
                    metadataUri,
                }),
            ],
            [upgradeAuthority],
        );
    } else {
        info('already registered with this metadata URI');
    }

    step('4. Creating two test tokens');
    const mintA = await createTestToken(payer, 'token A', 6, MINTED);
    const mintB = await createTestToken(payer, 'token B', 9, MINTED);
    const mints = [
        { mint: mintA, tokenProgram: TOKEN_PROGRAM_ADDRESS },
        { mint: mintB, tokenProgram: TOKEN_PROGRAM_ADDRESS },
    ];

    step('5. Computing the addresses the creation will use, before sending it');
    // `init` says how to create a market: the market state address, the init data and the
    // accounts. A desk does exactly this to show a "create market" form. The market state is
    // a fresh keypair, which signs the creation.
    if ((metadata.init.market_state ?? 'new_keypair') !== 'new_keypair') {
        fail('a tax market\'s state is a new keypair (docs/spec/tax-amm.md, "Addresses")');
    }
    const marketStateKey = await generateKeyPairSigner();
    const marketState = marketStateKey.address;
    const otherRecipients = await Promise.all(
        Array.from({ length: DEMO_MARKET.otherRecipients }, async () => (await generateKeyPairSigner()).address),
    );
    const recipients = [payer.address, ...otherRecipients];
    while (recipients.length < DEMO_MARKET.shares.length) recipients.push(DEFAULT_ADDRESS);
    const sent = demoParams(payer.address, payer.address, recipients);
    const args = metadataArgs(sent);

    const { instruction: createMarket, resolved } = await pipeline.buildCreateMarketFromMetadata({
        init: metadata.init,
        strategyProgram: programId,
        creator: payer.address,
        marketState,
        args,
        inputs: { mint_0: mintA, mint_1: mintB },
        tokenPrograms: Object.fromEntries(mints.map(({ mint, tokenProgram }) => [mint, tokenProgram])),
        maxCreatorLamports: MAX_CREATOR_LAMPORTS,
        rpc,
    });
    // What the metadata resolved, by its account names, checked against the client's PDAs.
    const initAccount = (name: string) => {
        const index = metadata.init!.accounts?.findIndex((account) => account.name === name) ?? -1;
        return resolved.strategyAccounts[index]?.address ?? fail(`metadata init has no account "${name}"`);
    };
    const [authority] = await findAuthorityPda({ marketState }, { programAddress: programId });
    const [vault0] = await findVault0Pda({ marketState, mint0: mintA }, { programAddress: programId });
    const [vault1] = await findVault1Pda({ marketState, mint1: mintB }, { programAddress: programId });
    const vaults = [vault0, vault1];
    if (initAccount('authority') !== authority || initAccount('vault_0') !== vault0 || initAccount('vault_1') !== vault1) {
        fail("the metadata's init accounts are not the program's PDAs");
    }
    const market = await pipeline.marketPda(programId, marketState);
    if (resolved.market !== market || resolved.marketState !== marketState) {
        fail('the SDK resolved a different market or market state');
    }
    const feeAccounts = await Promise.all(
        mints.map(({ mint, tokenProgram }) => pipeline.feeAccountPda(market, mint, tokenProgram)),
    );
    const computed: [string, Address][] = [
        ['router market', market],
        ['fee account, token A', feeAccounts[0]!],
        ['fee account, token B', feeAccounts[1]!],
        ['market state', marketState],
        ['vault, token A', vault0],
        ['vault, token B', vault1],
        // The vault authority only signs, so it never holds an account.
        ['vault authority', authority],
    ];
    for (const [label, account] of computed) {
        if (await accountData(account)) fail(`the ${label} ${account} exists before the creation`);
        info(`${label.padEnd(20)} ${account}`);
    }

    step("6. Creating the market from the metadata's init form, with its fee accounts and its seed");
    // init_fee_account for each mint, in the same transaction, so both tokens can be sold.
    const initFeeAccounts = await Promise.all(
        mints.map(({ mint, tokenProgram }) => pipeline.initFeeAccount({ payer: payer.address, market, mint, tokenProgram })),
    );
    // The metadata's `seed` action, built against the market as it will be once
    // create_market has run: every address is known before anything is sent.
    const seedAction = metadata.actions?.find((action) => action.name === 'seed') ?? fail('metadata.json has no seed action');
    const view: pipeline.MarketView = {
        market,
        strategyProgram: programId,
        marketState,
        mints: [mintA, mintB],
        vaults,
        tokenPrograms: mints.map(({ tokenProgram }) => tokenProgram),
        supportsExactOut: false,
    };
    const seed = await pipeline.buildActionInstruction({
        action: seedAction,
        market: view,
        wallet: payer.address,
        args: { amount_0: DEMO_MARKET.seed[0], amount_1: DEMO_MARKET.seed[1] },
    });
    await send(
        'create_market + init_fee_account x2 + seed',
        payer,
        [createMarket, ...initFeeAccounts, seed],
        [marketStateKey],
    );
    info(`market ${explorer('address', market)}`);
    record.push(['market', market], ['market state', marketState]);

    step('7. Checking what exists, and reading the market state back');
    const routerMarket = pipeline.decodeMarket((await accountData(market)) ?? new Uint8Array());
    if (!routerMarket) fail(`the router has no market at ${market}`);
    const recorded = pipeline.marketViewFromMarket(market, routerMarket, mints.map(({ tokenProgram }) => tokenProgram));
    if (recorded.mints.join() !== view.mints.join() || recorded.vaults.join() !== view.vaults.join()) {
        fail(`the router recorded mints ${recorded.mints.join(', ')} and vaults ${recorded.vaults.join(', ')}`);
    }
    info('router market: the mints in the creator\'s order, with the vaults computed in step 5');
    // One round trip for the fee accounts and the vaults: each must be a token account of
    // its mint's program; a vault also of its mint, owned by the vault authority.
    const { value: created } = await rpc
        .getMultipleAccounts([...feeAccounts, ...vaults], { encoding: 'base64', commitment: 'confirmed' })
        .send();
    const tokenAccount = (i: number) => {
        const account = created[i];
        return account && { owner: account.owner, data: new Uint8Array(Buffer.from(account.data[0], 'base64')) };
    };
    for (const [i, feeAccount] of feeAccounts.entries()) {
        if (tokenAccount(i)?.owner !== mints[i]!.tokenProgram) fail(`fee account ${feeAccount} is not a token account`);
    }
    info('fee accounts: both exist at the computed addresses');
    for (const [i, vault] of vaults.entries()) {
        const account = tokenAccount(feeAccounts.length + i);
        const mint = account && getAddressDecoder().decode(account.data.subarray(0, 32));
        const owner = account && getAddressDecoder().decode(account.data.subarray(32, 64));
        if (account?.owner !== mints[i]!.tokenProgram || mint !== mints[i]!.mint || owner !== authority) {
            fail(`vault ${vault} is not a token account of ${mints[i]!.mint} owned by the vault authority`);
        }
    }
    info('vaults: token accounts of their mints, owned by the vault authority, at the computed addresses');

    const { data: state } = await fetchTaxMarket(rpc, marketState, { commitment: 'confirmed' });
    const readBack = paramsOf(state);
    for (const key of Object.keys(sent) as (keyof typeof sent)[]) {
        const [wanted, got] = [show(sent[key]), show(readBack[key])];
        if (wanted !== got) fail(`the market state's ${key} is ${got}, but ${wanted} was sent`);
        info(`${key.padEnd(14)} ${got}`);
    }
    if (show(Object.keys(readBack).sort()) !== show(Object.keys(sent).sort())) fail('a parameter was not compared');
    if (state.status !== MarketStatus.Open || state.marketSigner !== market) {
        fail(`the market state is ${state.status}, with market signer ${state.marketSigner}`);
    }
    if (show(state.reserves) !== show(DEMO_MARKET.seed)) {
        fail(`the market recorded reserves ${show(state.reserves)}, but ${show(DEMO_MARKET.seed)} was seeded`);
    }
    if (state.mints.join() !== [mintA, mintB].join() || state.vaults.join() !== vaults.join()) {
        fail('the market state records other mints or vaults');
    }
    info(`the market state holds exactly the parameters sent; it is open, holding the seed ${show(state.reserves)}`);
    record.push(['parameters read back', 'all equal to those sent']);

    step('8. Trading both ways through the router');
    // The spec's own account of the market, from what was sent, never from the program.
    const spec = freshSpec(sent, DEMO_MARKET.seed);
    await tradeBothWays(payer, programId, view, spec, DEMO_MARKET.trades, ['token A', 'token B']);
    record.push(['swaps', 'both delivered their quotes, the spec\'s prices']);

    step("9. Reading the market state back against the spec's formulas");
    await checkBooks(marketState, spec, sent.virtualReserve);
    record.push(['market state after trading', "equal to the spec's formulas"]);

    step('10. Graduating a token from a launchpad into a tax market');
    if (cluster.local) {
        await graduateFromLaunchpad(payer, programId, metadata);
    } else {
        info('skipped: the stand-in launchpad is a test program, never deployed to devnet');
    }

    step(`Done on ${cluster.url}`);
    const width = Math.max(...record.map(([label]) => label.length));
    for (const [label, value] of record) info(`${label.padEnd(width)}  ${value}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
