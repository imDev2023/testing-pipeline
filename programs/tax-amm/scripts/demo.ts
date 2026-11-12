// The tax AMM's demo: lists the strategy on a Pipeline router, then creates, seeds, trades and
// pays out two tax markets, step by step, building every market creation and custom action
// from metadata.json with Pipeline's TypeScript SDK, as Aviary will, and reading each market
// back with the generated client (client/):
//
//   1. check the program is deployed and the upgrade-authority key is its upgrade authority;
//   2. check metadata.json, and the published copy at the metadata URI;
//   3. register the strategy, signed and paid for by the upgrade authority (once), or point
//      it at a new metadata URI;
//   4. create two test tokens, and wrap the SOL the market taxed in SOL needs;
//
// then for each market of DEMO_MARKETS, the first taxed in wrapped SOL and the second in a
// token with a burn:
//
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
//  10. pay out every slot with the metadata's `distribute` action: each tax recipient and the
//      suite treasury must receive exactly what the market state said it was owed, a
//      recipient with no token account must get one, the burn must lower the mint's supply
//      by exactly its owed amount, and every owed amount must be 0 afterwards, with the
//      tax-side vault holding exactly the real reserve.
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
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getInitializeMint2Instruction,
    getMintSize,
    getMintToInstruction,
    getSyncNativeInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import * as pipeline from '@pipeline-placeholder/sdk';

import {
    fetchTaxMarket,
    findAuthorityPda,
    findVault0Pda,
    findVault1Pda,
    MarketStatus,
    SUITE_SHARE_BPS,
    SUITE_TREASURY,
} from './client/index.ts';
import { price, swap as specSwap, type SpecMarket } from './spec-model.ts';

// Written by Pipeline's scripts/new-strategy.sh; the same address as `declare_id!`.
const DEFAULT_PROGRAM_ID = 'J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t';
// The all-zero key: an unused tax recipient slot.
const DEFAULT_ADDRESS = address('11111111111111111111111111111111');
const DEFAULT_METADATA_URI =
    'https://raw.githubusercontent.com/imDev2023/testing-pipeline/main/programs/tax-amm/metadata.json';

// The demo markets: the demo's own choices, in one place, not the program's policy values
// (docs/spec/tax-amm.md, "Where its policy values live"). Both pair token A (6 decimals) at
// index 0 with a tax side at index 1; the payer is each market's tax authority, seeder and
// first tax recipient, and the second recipient is a fresh wallet with no token account, so
// `distribute` creates one. Side A prices 50 A more than it holds through its virtual
// reserve. The first market is taxed in wrapped SOL, Aviary's default tax side, so it has no
// burn; the second is taxed in token B (9 decimals) and burns part of the creator's share.
// Each trades both ways: buy token A with the tax side (a buy tax, on the input), then sell
// some back (a sell tax, on the output), as [input index, output index, amount in].
const MINTED = 1_000_000_000_000n;
const DEMO_MARKETS = [
    {
        label: 'market 1, taxed in SOL',
        taxedIn: 'wrapped SOL',
        buyTaxBps: 300,
        sellTaxBps: 500,
        buyTaxRangeBps: [100, 800],
        sellTaxRangeBps: [0, 900],
        shares: [6_000, 4_000, 0, 0],
        burnShareBps: 0,
        virtualReserve: 50_000_000n,
        seed: [100_000_000_000n, 500_000_000n],
        trades: [
            [1, 0, 50_000_000n],
            [0, 1, 1_000_000_000n],
        ],
    },
    {
        label: 'market 2, taxed in token B',
        taxedIn: 'token B',
        buyTaxBps: 300,
        sellTaxBps: 500,
        buyTaxRangeBps: [100, 800],
        sellTaxRangeBps: [0, 900],
        shares: [6_000, 3_000, 0, 0],
        burnShareBps: 1_000,
        virtualReserve: 50_000_000n,
        seed: [100_000_000_000n, 200_000_000_000n],
        trades: [
            [1, 0, 1_000_000_000n],
            [0, 1, 300_000n],
        ],
    },
] as const;
type DemoMarket = (typeof DEMO_MARKETS)[number];
// Both markets: the tax side and the virtual side, by mint index.
const TAX_SIDE = 1;
const VIRTUAL_SIDE = 0;
// SPL Token's native SOL mint: wrapped SOL, the same address on every cluster.
const WRAPPED_SOL = address('So11111111111111111111111111111111111111112');
// Tax slots, as the program numbers them (docs/spec/tax-amm.md, "Payout").
const BURN_SLOT = 4;
const SUITE_SLOT = 5;
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

/** JSON with bigints as strings, for comparing and printing values read back. */
function show(value: unknown) {
    return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
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

    step('4. Creating two test tokens, and wrapping the SOL the first market needs');
    const mintA = await createTestToken(payer, 'token A', 6, MINTED);
    const mintB = await createTestToken(payer, 'token B', 9, MINTED);
    const sideOne: Record<DemoMarket['taxedIn'], Address> = { 'wrapped SOL': WRAPPED_SOL, 'token B': mintB };
    for (const demo of DEMO_MARKETS) {
        if (sideOne[demo.taxedIn] === WRAPPED_SOL) await wrapSol(payer, wrappedSolNeeded(demo));
    }

    const context = { payer, programId, metadata };
    for (const [n, demo] of DEMO_MARKETS.entries()) {
        const market = await createAndTrade(context, n + 1, demo, [mintA, sideOne[demo.taxedIn]]);
        await payOut(context, n + 1, demo, market);
    }

    step(`Done on ${cluster.url}`);
    const width = Math.max(...record.map(([label]) => label.length));
    for (const [label, value] of record) info(`${label.padEnd(width)}  ${value}`);
}

type Context = { payer: KeyPairSigner; programId: Address; metadata: pipeline.StrategyMetadata };

/** What a market's later steps need from its creation and trades. */
type DemoRun = { view: pipeline.MarketView; spec: SpecMarket; recipients: Address[] };

/** The SOL a market taxed in wrapped SOL takes from the payer: its seed, and its buys with Pipeline's fee. */
function wrappedSolNeeded(demo: DemoMarket): bigint {
    const buys = demo.trades.filter(([input]) => input === TAX_SIDE).map(([, , amount]) => amount);
    const spend = (amount: bigint) => pipeline.maxTotalSpend(amount, 0) ?? fail(`a buy of ${amount} overflows`);
    return buys.reduce<bigint>((sum, amount) => sum + spend(amount), demo.seed[TAX_SIDE]);
}

/** Moves `amount` lamports into the wallet's wrapped SOL account, creating it if needed. */
async function wrapSol(wallet: KeyPairSigner, amount: bigint) {
    const holder = await walletTokenAccount(wallet.address, WRAPPED_SOL);
    await send(`wrap ${Number(amount) / 1e9} SOL`, wallet, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: wallet, owner: wallet.address, mint: WRAPPED_SOL }),
        getTransferSolInstruction({ source: wallet, destination: holder, amount }),
        getSyncNativeInstruction({ account: holder }),
    ]);
    info(`wrapped SOL: ${holder}`);
}

/** Steps 5 to 9 for one market: create and seed it, trade it both ways, check the books. */
async function createAndTrade({ payer, programId, metadata }: Context, n: number, demo: DemoMarket, marketMints: Address[]): Promise<DemoRun> {
    const init = metadata.init ?? fail('metadata.json needs `init` for this demo');
    const [mintA, mintB] = marketMints as [Address, Address];
    const names = ['token A', demo.taxedIn];
    const mints = marketMints.map((mint) => ({ mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

    step(`${n}.5. ${demo.label}: computing the addresses the creation will use, before sending it`);
    // `init` says how to create a market: the market state address, the init data and the
    // accounts. A desk does exactly this to show a "create market" form. The market state is
    // a fresh keypair, which signs the creation.
    if ((init.market_state ?? 'new_keypair') !== 'new_keypair') {
        fail('a tax market\'s state is a new keypair (docs/spec/tax-amm.md, "Addresses")');
    }
    const marketStateKey = await generateKeyPairSigner();
    const marketState = marketStateKey.address;
    const otherRecipients = await Promise.all(
        demo.shares.slice(1).filter((share) => share > 0).map(async () => (await generateKeyPairSigner()).address),
    );
    const recipients = [payer.address, ...otherRecipients];
    while (recipients.length < demo.shares.length) recipients.push(DEFAULT_ADDRESS);
    const sent = {
        taxSide: TAX_SIDE,
        buyTaxBps: demo.buyTaxBps,
        sellTaxBps: demo.sellTaxBps,
        buyTaxMinBps: demo.buyTaxRangeBps[0],
        buyTaxMaxBps: demo.buyTaxRangeBps[1],
        sellTaxMinBps: demo.sellTaxRangeBps[0],
        sellTaxMaxBps: demo.sellTaxRangeBps[1],
        taxAuthority: payer.address,
        seeder: payer.address,
        recipients,
        shares: [...demo.shares],
        burnShareBps: demo.burnShareBps,
        virtualSide: VIRTUAL_SIDE,
        virtualReserve: demo.virtualReserve,
    };
    // The metadata's arguments, in its own names: the arrays flattened, as metadata has none.
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

    const { instruction: createMarket, resolved } = await pipeline.buildCreateMarketFromMetadata({
        init,
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
        const index = init.accounts?.findIndex((account) => account.name === name) ?? -1;
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
        [`fee account, ${names[1]}`, feeAccounts[1]!],
        ['market state', marketState],
        ['vault, token A', vault0],
        [`vault, ${names[1]}`, vault1],
        // The vault authority only signs, so it never holds an account.
        ['vault authority', authority],
    ];
    for (const [label, account] of computed) {
        if (await accountData(account)) fail(`the ${label} ${account} exists before the creation`);
        info(`${label.padEnd(24)} ${account}`);
    }

    step(`${n}.6. ${demo.label}: creating it from the metadata's init form, with its fee accounts and its seed`);
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
        args: { amount_0: demo.seed[0], amount_1: demo.seed[1] },
    });
    await send(
        `${demo.label}: create_market + init_fee_account x2 + seed`,
        payer,
        [createMarket, ...initFeeAccounts, seed],
        [marketStateKey],
    );
    info(`market ${explorer('address', market)}`);
    record.push([`${demo.label}: market`, market], [`${demo.label}: market state`, marketState]);

    step(`${n}.7. ${demo.label}: checking what exists, and reading the market state back`);
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
    const readBack = {
        taxSide: state.taxSide,
        buyTaxBps: state.buyTaxBps,
        sellTaxBps: state.sellTaxBps,
        buyTaxMinBps: state.buyTaxMinBps,
        buyTaxMaxBps: state.buyTaxMaxBps,
        sellTaxMinBps: state.sellTaxMinBps,
        sellTaxMaxBps: state.sellTaxMaxBps,
        taxAuthority: state.taxAuthority,
        seeder: state.seeder,
        recipients: state.recipients,
        shares: state.shares,
        burnShareBps: state.burnShareBps,
        virtualSide: state.virtualSide,
        virtualReserve: state.virtualReserve,
    };
    for (const key of Object.keys(sent) as (keyof typeof sent)[]) {
        const [wanted, got] = [show(sent[key]), show(readBack[key])];
        if (wanted !== got) fail(`the market state's ${key} is ${got}, but ${wanted} was sent`);
        info(`${key.padEnd(14)} ${got}`);
    }
    if (show(Object.keys(readBack).sort()) !== show(Object.keys(sent).sort())) fail('a parameter was not compared');
    if (state.status !== MarketStatus.Open || state.marketSigner !== market) {
        fail(`the market state is ${state.status}, with market signer ${state.marketSigner}`);
    }
    if (show(state.reserves) !== show(demo.seed)) {
        fail(`the market recorded reserves ${show(state.reserves)}, but ${show(demo.seed)} was seeded`);
    }
    if (state.mints.join() !== [mintA, mintB].join() || state.vaults.join() !== vaults.join()) {
        fail('the market state records other mints or vaults');
    }
    info(`the market state holds exactly the parameters sent; it is open, holding the seed ${show(state.reserves)}`);
    record.push([`${demo.label}: parameters read back`, 'all equal to those sent']);

    step(`${n}.8. ${demo.label}: trading both ways through the router`);
    // The spec's own account of the market, from what was sent, never from the program.
    const spec: SpecMarket = {
        suiteShareBps: SUITE_SHARE_BPS,
        taxSide: sent.taxSide,
        buyTaxBps: sent.buyTaxBps,
        sellTaxBps: sent.sellTaxBps,
        shares: [...sent.shares],
        burnShareBps: sent.burnShareBps,
        virtualSide: sent.virtualSide,
        virtualReserve: sent.virtualReserve,
        reserves: [...demo.seed],
        owed: [0n, 0n, 0n, 0n, 0n, 0n],
        taxCollected: 0n,
        volume: [0n, 0n],
        swapCount: 0n,
    };
    const payerAccounts = await Promise.all([mintA, mintB].map((mint) => walletTokenAccount(payer.address, mint)));
    for (const [input, output, amount] of demo.trades) {
        const label = `${demo.label}: swap ${amount} ${names[input]} for ${names[output]}`;
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
                    marketState,
                    traderInput: payerAccounts[input]!,
                    traderOutput: payerAccounts[output]!,
                    inputVault: vaults[input]!,
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
    record.push([`${demo.label}: swaps`, 'both delivered their quotes, the spec\'s prices']);

    step(`${n}.9. ${demo.label}: reading the market state back against the spec's formulas`);
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
    if (traded.virtualReserve !== sent.virtualReserve) fail('the virtual reserve changed');
    info("reserves, owed amounts and counters equal the spec's formulas to the unit");
    record.push([`${demo.label}: market state after trading`, "equal to the spec's formulas"]);
    return { view, spec, recipients };
}

/** Step 10 for one market: pay out every slot it uses through the metadata's `distribute`. */
async function payOut({ payer, metadata }: Context, n: number, demo: DemoMarket, { view, spec, recipients }: DemoRun) {
    step(`${n}.10. ${demo.label}: paying out every slot with the metadata's distribute action`);
    const action = metadata.actions?.find((candidate) => candidate.name === 'distribute') ?? fail('metadata.json has no distribute action');
    const taxMint = view.mints[TAX_SIDE]!;
    const { data: before } = await fetchTaxMarket(rpc, view.marketState, { commitment: 'confirmed' });
    if (show(before.owed) !== show(spec.owed)) fail(`the market owes ${show(before.owed)}, but the spec's formulas give ${show(spec.owed)}`);
    // Each slot the market uses, with the wallet the market state names for it: the tax
    // recipients, the burn (no wallet: the default key), and the suite treasury, which the
    // client carries from the program's IDL.
    const slots: [number, string, Address][] = [
        ...before.recipients.flatMap((wallet, slot): [number, string, Address][] =>
            wallet === DEFAULT_ADDRESS ? [] : [[slot, `tax recipient ${slot + 1}`, wallet]],
        ),
        [BURN_SLOT, 'burn', DEFAULT_ADDRESS],
        [SUITE_SLOT, 'suite share', SUITE_TREASURY],
    ];
    if (show(slots.slice(0, -2).map(([, , wallet]) => wallet)) !== show(recipients.filter((r) => r !== DEFAULT_ADDRESS))) {
        fail('the market state names other tax recipients than those sent');
    }
    for (const [slot, label, wallet] of slots) {
        const owed = before.owed[slot]!;
        const account = await walletTokenAccount(wallet, taxMint);
        const existed = (await accountData(account)) !== null;
        const balance = existed ? await tokenBalance(account) : 0n;
        const supply = await mintSupply(taxMint);
        const instruction = await pipeline.buildActionInstruction({
            action,
            market: view,
            wallet: payer.address,
            args: { slot },
            inputs: { tax_mint: taxMint, recipient: wallet },
        });
        await send(`${demo.label}: distribute slot ${slot} (${label})`, payer, [instruction]);
        if (slot === BURN_SLOT) {
            const burned = supply - (await mintSupply(taxMint));
            if (burned !== owed) fail(`the burn lowered the supply by ${burned}, but the slot was owed ${owed}`);
            info(
                owed === 0n
                    ? `${label}: owed nothing, so nothing was burned (a market taxed in SOL burns nothing)`
                    : `${label}: the supply of ${demo.taxedIn} fell by exactly the ${owed} owed`,
            );
            continue;
        }
        const exists = (await accountData(account)) !== null;
        const received = exists ? (await tokenBalance(account)) - balance : 0n;
        if (received !== owed) fail(`${label} ${wallet} received ${received}, but was owed ${owed}`);
        // The recipients other than the payer are fresh wallets: the payout made their account.
        const fresh = recipients.indexOf(wallet) > 0;
        if (fresh && (existed || !exists)) fail(`${label} ${wallet} had a token account before, or has none now`);
        info(`${label}: ${wallet} received exactly the ${owed} owed${existed ? '' : ', in a token account created for it'}`);
        if (fresh) record.push([`${demo.label}: ${label}`, `had no token account and got one, ${account}`]);
    }
    const { data: after } = await fetchTaxMarket(rpc, view.marketState, { commitment: 'confirmed' });
    if (after.owed.some((owed) => owed !== 0n)) fail(`after the payouts the market still owes ${show(after.owed)}`);
    const vault = await tokenBalance(view.vaults[TAX_SIDE]!);
    if (vault !== after.reserves[TAX_SIDE]) fail(`the tax-side vault holds ${vault}, but the real reserve is ${after.reserves[TAX_SIDE]}`);
    info(`every owed amount is 0, and the tax-side vault holds exactly the real reserve, ${vault}`);
    record.push([`${demo.label}: payouts`, 'every slot paid exactly what it was owed']);
}

/** A mint's supply. */
async function mintSupply(mint: Address): Promise<bigint> {
    const { value } = await rpc.getTokenSupply(mint, { commitment: 'confirmed' }).send();
    return BigInt(value.amount);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
