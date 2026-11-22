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
//  10. as the tax authority, change both rates through the metadata's `set_taxes` action,
//      then trade both ways again and check each swap was taxed at the new rates;
//  11. change a tax recipient through the metadata's `set_recipients` action, and check the
//      slot names the new wallet with what it is owed unchanged;
//  12. renounce through the metadata's `renounce_tax_authority` action, and check that both
//      changes are refused afterwards, leaving the market as it was;
//  13. on a local validator only, graduate a token from the stand-in launchpad
//      (launchpad.ts): it calls `pipeline_seed_liquidity`, built from the metadata's
//      `seed_liquidity` form, and the same transaction records the market with
//      `register_existing_market` and both fee accounts; then check the escrows lost exactly
//      the seed, `SeedResult.taken` says so, the market state is open with the launchpad's
//      PDA as its seeder, and trade it both ways as in steps 8 and 9;
//  14. pay out every slot of the market with the metadata's `distribute` action, and its burn
//      slot with the `burn` action (the same instruction, with the mint writable): each tax
//      recipient and the suite treasury must receive exactly what the market state said it
//      was owed, a recipient with no token account must get one (the wallet given slot 1 in
//      step 11 has none), the burn must lower the mint's supply by exactly its owed amount,
//      and every owed amount must be 0 afterwards, with the tax-side vault holding exactly the
//      real reserve;
//  15. the demo market: create, seed and trade a market of a fresh demo token taxed in
//      wrapped SOL (Aviary's default tax side), from the metadata as in steps 5 to 9, and pay
//      it out as in step 14: its recipients are paid wrapped SOL, and its burn slot is owed
//      nothing.
//
// Steps 4 to 14 run on a local validator only; on devnet the demo creates only the demo
// market, whose parameters are all in one block, `SOL_MARKET`, and whose address the devnet
// deploy publishes (docs/toolchain.md, "Deploy to devnet").
//
// Grown from Pipeline's strategy template (scripts/deploy-devnet.ts at 5ad130d). Deploy the
// program first; docs/toolchain.md says how, on a local validator and on devnet.
//
// Usage, from this directory after `pnpm install` (docs/toolchain.md, "Local demo run"):
//
//   node demo.ts --cluster <localnet|devnet|URL> \
//     --payer <keypair.json> --upgrade-authority <keypair.json> \
//     [--metadata-uri <URI>] [--program-id <address>] [--demo-market-only] [--register-only]
//     [--record <file>]
//
//   --cluster            localnet (http://127.0.0.1:8899), devnet, or an RPC URL of either;
//                        the cluster's genesis hash must be devnet's, or the URL a local
//                        validator's: devnet only until Pipeline is on mainnet
//   --payer              pays fees, creates the tokens and the market
//   --upgrade-authority  the program's upgrade authority; signs register_strategy and pays
//                        its listing fee (docs/spec/README.md, "Upgrade authority")
//   --metadata-uri       where metadata.json is published (default: this repo's main branch)
//   --program-id         the strategy program (default: the address in declare_id!)
//   --demo-market-only   on a local validator, run only what runs on devnet: steps 1 to 3
//                        and the demo market (step 15)
//   --register-only      steps 1 to 3 only: register the strategy, or point it at a new
//                        metadata URI, as each later deploy does
//   --record             also write what the run did (addresses and signatures) to a file
//   --metadata-not-yet-public
//                        on devnet, register or point the strategy at a metadata URI of this
//                        repo that cannot resolve yet because the repo is still private; the
//                        URI must be this repo's metadata.json on main, before the metadata
//                        is pinned, or at a full commit on origin/main once it is; the copy
//                        the link will serve (origin/main's or the commit's) is checked
//                        instead, a commit's pinning the deploy main records with its report
//                        (TAX-54)
//
// On devnet the metadata URI must resolve and pass Pipeline's validator with zero warnings
// before the script registers it or points the strategy at it, unless
// --metadata-not-yet-public says the repo is still private.
//
// On a local cluster the script airdrops the SOL both keys need; on devnet it never does
// (fund them with devnet-airdrop, docs/toolchain.md).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
    isSolanaError,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
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
    getTransferCheckedInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import * as pipeline from '@pipeline-placeholder/sdk';
import { buildActionInstruction, findAction } from 'strategy-actions';

import {
    fetchTaxMarket,
    findAuthorityPda,
    findMarketStatePda,
    findVault0Pda,
    findVault1Pda,
    getTaxAmmErrorMessage,
    BURN_SLOT,
    MarketStatus,
    SUITE_SHARE_BPS,
    SUITE_SLOT,
    SUITE_TREASURY,
    TAX_AMM_ERROR__ALREADY_RENOUNCED,
    type TaxAmmError,
} from './client/index.ts';
import { findSeederPda, graduateInstruction, graduationFromLogs, LAUNCHPAD_PROGRAM_ADDRESS } from './launchpad.ts';
import { price, swap as specSwap, type SpecMarket } from './spec-model.ts';

// Written by Pipeline's scripts/new-strategy.sh; the same address as `declare_id!`.
const DEFAULT_PROGRAM_ID = 'J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t';
// The all-zero key: an unused tax recipient slot.
const DEFAULT_ADDRESS = address('11111111111111111111111111111111');
// Where this repo's committed files are served, once it is public.
const RAW_REPO = 'https://raw.githubusercontent.com/imDev2023/testing-pipeline';
const DEFAULT_METADATA_URI =
    'https://raw.githubusercontent.com/imDev2023/testing-pipeline/main/programs/tax-amm/metadata.json';

// Each market's parameters are the demo's own choices, in one named block per market, not the
// program's policy values (docs/spec/tax-amm.md, "Where its policy values live").
const MINTED = 1_000_000_000_000n;
// The token-taxed market of steps 4 to 14, on a local validator only: taxes are taken in
// token B; the payer is the tax authority, the seeder and the first tax recipient. Token A has
// 6 decimals and token B 9, so the seed is 100,000 A against 200 B, and side A prices 50 A
// more than it holds through its virtual reserve. After trading, the tax authority moves
// both rates inside their ranges, trades again, hands the second recipient's slot to a new
// wallet, and renounces.
const TOKEN_MARKET = {
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
    // The tax authority's new rates: [buy, sell], each inside its range.
    newTaxesBps: [600, 900],
} as const;
// The launch the stand-in launchpad graduates in step 13, on a local validator only: the
// token-taxed market's parameters and seed, from escrows holding more than the seed, so the market
// takes exactly the seed and leaves the rest; the launchpad lends the strategy at most
// `maxPayerLamports` for rent and takes back what it did not spend.
const LAUNCH = {
    decimals: [6, 9],
    escrowed: [150_000_000_000n, 300_000_000_000n],
    maxPayerLamports: 50_000_000n,
} as const;
// The demo market, step 15: the one market the demo creates on devnet, where its address is
// published (docs/toolchain.md, "Deploy to devnet"), and the second market on a local
// validator. A fresh demo token (6 decimals) against wrapped SOL, taxed in wrapped SOL as
// Aviary's launch form defaults the tax side, so it burns nothing; both taxes above 0, inside
// ranges that leave its tax authority room to move them; two tax recipients and the suite
// share. The payer is its tax authority, seeder and first tax recipient, and the second
// recipient a fresh wallet with no token account. No virtual reserve, so `pipeline-check`
// checks it at its default amounts. It is seeded with 100,000 tokens against 0.5 SOL, buys the
// token with 0.05 SOL, then sells 1,000 back.
const SOL_MARKET = {
    tokenDecimals: 6,
    taxSide: 1,
    buyTaxBps: 300,
    sellTaxBps: 500,
    buyTaxRangeBps: [100, 800],
    sellTaxRangeBps: [0, 900],
    otherRecipients: 1,
    shares: [6_000, 4_000, 0, 0],
    burnShareBps: 0,
    virtualSide: 0,
    virtualReserve: 0n,
    seed: [100_000_000_000n, 500_000_000n],
    trades: [
        [1, 0, 50_000_000n],
        [0, 1, 1_000_000_000n],
    ],
} as const;
// SPL Token's native SOL mint: wrapped SOL, the same address on every cluster.
const WRAPPED_SOL = address('So11111111111111111111111111111111111111112');
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
        'demo-market-only': { type: 'boolean', default: false },
        'register-only': { type: 'boolean', default: false },
        record: { type: 'string' },
        'metadata-not-yet-public': { type: 'boolean', default: false },
    },
    strict: true,
});

function usage(message: string): never {
    console.error(`${message}\n`);
    console.error(
        'Usage: node demo.ts --cluster <localnet|devnet|URL> --payer <keypair.json> --upgrade-authority <keypair.json> [--metadata-uri <URI>] [--program-id <address>] [--demo-market-only] [--register-only] [--record <file>]',
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
// On devnet the demo creates only the demo market; --demo-market-only does the same locally.
const onlyDemoMarket = onDevnet || options['demo-market-only'];

// Public RPC endpoints rate-limit bursts (HTTP 429) and drop connections now and then
// (`fetch failed`, seen on public devnet on 2026-11-20); retry both with back-off, a rate limit
// recognised by its HTTP status. A transaction sent is never resent here: a dropped connection
// can come after the node took it, so `send` looks for its signature instead.
const baseTransport = createDefaultRpcTransport({ url: cluster.url });
const rateLimited = (error: unknown) =>
    (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && error.context.statusCode === 429) ||
    // Some providers answer a burst with HTTP 200 and a JSON-RPC error instead.
    (isSolanaError(error) && /too many requests|rate limit/i.test(error.message));
const dropped = (error: unknown) => error instanceof TypeError && error.message === 'fetch failed';
const retryingTransport = (async (...args: Parameters<typeof baseTransport>) => {
    const sending = (args[0].payload as { method?: string } | undefined)?.method === 'sendTransaction';
    for (let attempt = 0; ; attempt++) {
        try {
            return await baseTransport(...args);
        } catch (error) {
            if (attempt >= 8 || !(rateLimited(error) || (dropped(error) && !sending))) throw error;
            await sleep(500 * 2 ** attempt);
        }
    }
}) as typeof baseTransport;
const rpc = createSolanaRpcFromTransport(retryingTransport);

/** The repository's root, wherever the script is run from. */
function repoRoot(): string {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' }).trim();
}

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

/** A version 0 transaction of `instructions`, signed and ready to send or simulate. */
async function buildSigned(feePayer: KeyPairSigner, instructions: Instruction[], extra: KeyPairSigner[] = []) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
        (m) => addSignersToTransactionMessage(extra, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    return {
        signature: getSignatureFromTransaction(signed),
        wire: getBase64EncodedWireTransaction(signed),
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
    };
}

/**
 * After a send whose connection dropped: waits for the transaction until its blockhash
 * expires, so a late landing is seen, and stops saying whether it landed.
 */
async function waitAfterDrop(label: string, signature: Signature, lastValidBlockHeight: bigint) {
    for (;;) {
        const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
        const status = value[0];
        if (status?.err) fail(`${label} failed: ${JSON.stringify(status.err)} (${explorer('tx', signature)})`);
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
        const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
        if (height > lastValidBlockHeight) {
            fail(`${label}: the connection dropped while sending and ${signature} never landed before its blockhash expired; nothing was done, so the step can be run again`);
        }
        await sleep(1000);
    }
}

/** Sends a transaction and waits for confirmation by polling (public RPCs often refuse WebSockets). */
async function send(label: string, feePayer: KeyPairSigner, instructions: Instruction[], extra: KeyPairSigner[] = []) {
    const { signature, wire, lastValidBlockHeight } = await buildSigned(feePayer, instructions, extra);
    let sent = true;
    try {
        await rpc.sendTransaction(wire, { encoding: 'base64' }).send();
    } catch (error) {
        // The node may have taken it before the connection dropped: its signature says.
        if (!dropped(error)) throw error;
        sent = false;
        info(`${label}: the connection dropped while sending; looking for ${signature} until its blockhash expires`);
    }
    await (sent ? waitFor(label, signature) : waitAfterDrop(label, signature, lastValidBlockHeight));
    const bytes = Buffer.from(wire, 'base64').length;
    info(`${label}: ${explorer('tx', signature)} (${bytes} of ${MAX_TRANSACTION_BYTES} bytes)`);
    record.push([label, signature]);
    return signature;
}

/**
 * Simulates a transaction and returns the custom error code its first failing instruction
 * returned, or null if it would succeed. Used to show a refusal without paying for it.
 */
async function simulatedErrorCode(feePayer: KeyPairSigner, instructions: Instruction[]): Promise<number | null> {
    const { wire } = await buildSigned(feePayer, instructions);
    const { value } = await rpc.simulateTransaction(wire, { encoding: 'base64', commitment: 'confirmed' }).send();
    if (!value.err) return null;
    const failure = (value.err as { InstructionError?: [unknown, { Custom?: number | bigint }] }).InstructionError;
    const custom = failure?.[1]?.Custom;
    if (custom === undefined) fail(`the simulation failed without a custom error: ${JSON.stringify(value.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    return Number(custom);
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

/**
 * The side a trade into `outputMint` pays Pipeline's fee on, from the market the router
 * recorded (Pipeline 0.3: the output when it is the market's fee mint).
 */
async function routerFeeSide(market: Address, outputMint: Address): Promise<pipeline.FeeSide> {
    const recorded = pipeline.decodeMarket((await accountData(market)) ?? new Uint8Array());
    if (!recorded) fail(`the router has no market at ${market}`);
    return pipeline.feeSideOf(recorded, outputMint);
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

async function walletTokenAccount(owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM_ADDRESS): Promise<Address> {
    const [account] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
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

/** A market block's creation parameters, with the given tax authority, seeder and recipients. */
function paramsOfBlock(
    block: typeof TOKEN_MARKET | typeof SOL_MARKET,
    taxAuthority: Address,
    seeder: Address,
    recipients: Address[],
): SentParams {
    return {
        taxSide: block.taxSide,
        buyTaxBps: block.buyTaxBps,
        sellTaxBps: block.sellTaxBps,
        buyTaxMinBps: block.buyTaxRangeBps[0],
        buyTaxMaxBps: block.buyTaxRangeBps[1],
        sellTaxMinBps: block.sellTaxRangeBps[0],
        sellTaxMaxBps: block.sellTaxRangeBps[1],
        taxAuthority,
        seeder,
        recipients,
        shares: [...block.shares],
        burnShareBps: block.burnShareBps,
        virtualSide: block.virtualSide,
        virtualReserve: block.virtualReserve,
    };
}

/** The payer and `block.otherRecipients` fresh wallets, then empty slots. */
async function recipientsOfBlock(payer: Address, block: typeof TOKEN_MARKET | typeof SOL_MARKET): Promise<Address[]> {
    const others = await Promise.all(
        Array.from({ length: block.otherRecipients }, async () => (await generateKeyPairSigner()).address),
    );
    const recipients = [payer, ...others];
    while (recipients.length < block.shares.length) recipients.push(DEFAULT_ADDRESS);
    return recipients;
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
 * Swaps `amount` of mint `input` for mint `output` through the router with the SDK, with its
 * quote as the minimum, and stops unless the quote is the spec's price and the swap
 * delivered it; then applies the swap to the spec's account of the market. Since Pipeline
 * 0.3 a trade into the market's fee mint (wrapped SOL here) pays Pipeline's fee out of what
 * arrived, so the minimum and the check are on what the trader keeps.
 */
async function tradeChecked(
    payer: KeyPairSigner,
    programId: Address,
    view: pipeline.MarketView,
    spec: SpecMarket,
    names: readonly string[],
    input: number,
    output: number,
    amount: bigint,
) {
    const payerAccounts = await Promise.all(view.mints.map((mint) => walletTokenAccount(payer.address, mint)));
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
    const feeSide = await routerFeeSide(view.market, view.mints[output]!);
    const kept = feeSide === 'output' ? pipeline.keptAfterOutputFee(quote.amountOut) : quote.amountOut;
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
                minAmountOut: kept,
                integratorFeeBps: 0,
                extra: new Uint8Array(),
            },
            feeSide,
        ),
    ]);
    const received = (await tokenBalance(payerAccounts[output]!)) - before;
    const event = await swapEvent(signature);
    const feeMint = view.mints[feeSide === 'output' ? output : input]!;
    if (received !== kept || event.received !== quote.amountOut || event.netSent !== amount || event.feeMint !== feeMint) {
        fail(`${label}: kept ${received} (event: ${event.received} for ${event.netSent}, fee in ${event.feeMint}), quoted ${quote.amountOut} for ${amount}, to keep ${kept}`);
    }
    info(`${label}: received exactly the quote, Pipeline's fee ${event.pipelineFee} in the ${feeSide === 'output' ? 'output' : 'input'}, ${received} kept`);
    specSwap(spec, input, output, event.netSent);
}

/**
 * Stops unless the market state's reserves, owed amounts and counters equal `spec`'s, and
 * returns the market state.
 */
async function checkBooksAgainst(marketState: Address, spec: SpecMarket, virtualReserve: bigint) {
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
    return traded;
}

/**
 * Step 13, on a local validator: the stand-in launchpad graduates a token into a tax market
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
    const sent = { ...paramsOfBlock(TOKEN_MARKET, payer.address, DEFAULT_ADDRESS, recipients), shares: [9_000, 0, 0, 0] };
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
        amounts: TOKEN_MARKET.seed,
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
    if (show(graduation.leftEscrows) !== show(TOKEN_MARKET.seed) || show(left) !== show(TOKEN_MARKET.seed)) {
        fail(`the escrows lost ${show(left)} (the launchpad measured ${show(graduation.leftEscrows)}), not the seed ${show(TOKEN_MARKET.seed)}`);
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
    if (state.status !== MarketStatus.Open || state.marketSigner !== market || show(state.reserves) !== show(TOKEN_MARKET.seed)) {
        fail(`the market state is ${state.status} with reserves ${show(state.reserves)} and market signer ${state.marketSigner}`);
    }
    info("the market state holds the parameters sent, with the launchpad's PDA as its seeder; open, holding the seed");

    const spec = freshSpec(wanted, TOKEN_MARKET.seed);
    for (const [input, output, amount] of TOKEN_MARKET.trades) {
        await tradeChecked(payer, programId, view, spec, ['launched token', 'quote token'], input, output, amount);
    }
    await checkBooksAgainst(marketState, spec, wanted.virtualReserve);
    record.push(['seeded market, traded', 'graduated, recorded, traded at the spec\'s prices']);
}

/** A mint's supply. */
async function mintSupply(mint: Address): Promise<bigint> {
    const { value } = await rpc.getTokenSupply(mint, { commitment: 'confirmed' }).send();
    return BigInt(value.amount);
}

/**
 * Step 14, and the end of step 15: pays out every slot `view`'s market uses, a tax recipient
 * or the suite share through the metadata's `distribute` action and the burn slot through
 * its `burn` action (the same instruction with the mint writable, so payouts never
 * write-lock the mint), giving the actions' `tax_mint` and `recipient` inputs from the market
 * state. Stops unless each wallet's account grew by exactly what its slot was owed, a fresh
 * recipient got its token account from the payout, the burn lowered the supply by exactly
 * its owed amount, and afterwards nothing is owed and the tax-side vault holds exactly the
 * real reserve.
 */
async function payOut(
    payer: KeyPairSigner,
    metadata: pipeline.StrategyMetadata,
    view: pipeline.MarketView,
    spec: SpecMarket,
    label: string,
    taxedIn: string,
) {
    const actionNamed = (name: string) =>
        findAction(metadata, name) ?? fail(`metadata.json has no ${name} action`);
    const [distribute, burn] = [actionNamed('distribute'), actionNamed('burn')];
    const { data: before } = await fetchTaxMarket(rpc, view.marketState, { commitment: 'confirmed' });
    const taxSide = before.taxSide;
    const [taxMint, taxTokenProgram] = [view.mints[taxSide]!, view.tokenPrograms[taxSide]!];
    if (show(before.owed) !== show(spec.owed)) fail(`the market owes ${show(before.owed)}, but the spec's formulas give ${show(spec.owed)}`);
    // Each slot the market uses, with the wallet the market state names for it: the tax
    // recipients, the burn (no wallet: the default key), and the suite treasury; the client
    // carries the treasury and the slot numbers from the program's IDL.
    const slots: [number, string, Address][] = [
        ...before.recipients.flatMap((wallet, slot): [number, string, Address][] =>
            wallet === DEFAULT_ADDRESS ? [] : [[slot, `tax recipient ${slot + 1}`, wallet]],
        ),
        [BURN_SLOT, 'burn', DEFAULT_ADDRESS],
        [SUITE_SLOT, 'suite share', SUITE_TREASURY],
    ];
    for (const [slot, slotLabel, wallet] of slots) {
        const owed = before.owed[slot]!;
        const account = await walletTokenAccount(wallet, taxMint, taxTokenProgram);
        const existed = (await accountData(account)) !== null;
        const balance = existed ? await tokenBalance(account) : 0n;
        const supply = slot === BURN_SLOT ? await mintSupply(taxMint) : 0n;
        const instruction = await buildActionInstruction({
            action: slot === BURN_SLOT ? burn : distribute,
            market: view,
            wallet: payer.address,
            args: { slot },
            inputs: { tax_mint: taxMint, recipient: wallet },
        });
        await send(`${label}: ${slot === BURN_SLOT ? 'burn' : 'distribute'} slot ${slot} (${slotLabel})`, payer, [instruction]);
        if (slot === BURN_SLOT) {
            const burned = supply - (await mintSupply(taxMint));
            if (burned !== owed) fail(`the burn lowered the supply by ${burned}, but the slot was owed ${owed}`);
            info(
                owed === 0n
                    ? `${slotLabel}: owed nothing, so nothing was burned (a market taxed in SOL burns nothing)`
                    : `${slotLabel}: the supply of ${taxedIn} fell by exactly the ${owed} owed`,
            );
            continue;
        }
        const exists = (await accountData(account)) !== null;
        const received = exists ? (await tokenBalance(account)) - balance : 0n;
        if (received !== owed) fail(`${slotLabel} ${wallet} received ${received}, but was owed ${owed}`);
        // The tax recipients other than the payer are fresh wallets: a payout made their account.
        const fresh = slot < BURN_SLOT && wallet !== payer.address && owed > 0n;
        if (fresh && (existed || !exists)) fail(`${slotLabel} ${wallet} had a token account before, or has none now`);
        info(`${slotLabel}: ${wallet} received exactly the ${owed} owed${existed ? '' : ', in a token account created for it'}`);
        if (fresh) record.push([`${label}: ${slotLabel}`, `had no token account and got one, ${account}`]);
    }
    const { data: after } = await fetchTaxMarket(rpc, view.marketState, { commitment: 'confirmed' });
    if (after.owed.some((owed) => owed !== 0n)) fail(`after the payouts the market still owes ${show(after.owed)}`);
    const vault = await tokenBalance(view.vaults[taxSide]!);
    if (vault !== after.reserves[taxSide]) fail(`the tax-side vault holds ${vault}, but the real reserve is ${after.reserves[taxSide]}`);
    info(`every owed amount is 0, and the tax-side vault holds exactly the real reserve, ${vault}`);
    record.push([`${label}: payouts`, 'every slot paid exactly what it was owed']);
}

/**
 * Step 15, the demo market: a fresh demo token against wrapped SOL, taxed in SOL, created and
 * seeded from the metadata in one transaction as in steps 5 and 6, its parameters and seed
 * read back as in step 7, traded both ways and its books checked as in steps 8 and 9, then
 * paid out.
 */
async function solTaxedMarket(payer: KeyPairSigner, programId: Address, metadata: pipeline.StrategyMetadata) {
    const init = metadata.init ?? fail('metadata.json needs `init` for this demo');
    const label = 'demo market';
    const token = await createTestToken(payer, 'demo token', SOL_MARKET.tokenDecimals, MINTED);
    // Wrap the seed and the buys, with Pipeline's fee on each.
    const buys = SOL_MARKET.trades.filter(([input]) => input === SOL_MARKET.taxSide).map(([, , amount]) => amount);
    const spend = (amount: bigint) => pipeline.maxTotalSpend(amount, 0) ?? fail(`a buy of ${amount} overflows`);
    const wrap = buys.reduce<bigint>((sum, amount) => sum + spend(amount), SOL_MARKET.seed[SOL_MARKET.taxSide]);
    const holder = await walletTokenAccount(payer.address, WRAPPED_SOL);
    await send(`wrap ${Number(wrap) / 1e9} SOL`, payer, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: payer.address, mint: WRAPPED_SOL }),
        getTransferSolInstruction({ source: payer, destination: holder, amount: wrap }),
        getSyncNativeInstruction({ account: holder }),
    ]);

    const mints = [token, WRAPPED_SOL];
    const tokenPrograms = mints.map(() => TOKEN_PROGRAM_ADDRESS);
    const marketStateKey = await generateKeyPairSigner();
    const marketState = marketStateKey.address;
    const sent = paramsOfBlock(SOL_MARKET, payer.address, payer.address, await recipientsOfBlock(payer.address, SOL_MARKET));
    const { instruction: createMarket } = await pipeline.buildCreateMarketFromMetadata({
        init,
        strategyProgram: programId,
        creator: payer.address,
        marketState,
        args: metadataArgs(sent),
        inputs: { mint_0: mints[0]!, mint_1: mints[1]! },
        tokenPrograms: Object.fromEntries(mints.map((mint, i) => [mint, tokenPrograms[i]!])),
        maxCreatorLamports: MAX_CREATOR_LAMPORTS,
        rpc,
    });
    const market = await pipeline.marketPda(programId, marketState);
    const [vault0] = await findVault0Pda({ marketState, mint0: mints[0]! }, { programAddress: programId });
    const [vault1] = await findVault1Pda({ marketState, mint1: mints[1]! }, { programAddress: programId });
    const view: pipeline.MarketView = {
        market,
        strategyProgram: programId,
        marketState,
        mints,
        vaults: [vault0, vault1],
        tokenPrograms,
        supportsExactOut: false,
    };
    const seedAction = findAction(metadata, 'seed') ?? fail('metadata.json has no seed action');
    await send(
        `${label}: create_market + init_fee_account x2 + seed`,
        payer,
        [
            createMarket,
            ...(await Promise.all(
                mints.map((mint, i) => pipeline.initFeeAccount({ payer: payer.address, market, mint, tokenProgram: tokenPrograms[i]! })),
            )),
            await buildActionInstruction({
                action: seedAction,
                market: view,
                wallet: payer.address,
                args: { amount_0: SOL_MARKET.seed[0], amount_1: SOL_MARKET.seed[1] },
            }),
        ],
        [marketStateKey],
    );
    record.push([`${label}: market`, market], [`${label}: market state`, marketState], [`${label}: demo token`, token]);
    const { data: state } = await fetchTaxMarket(rpc, marketState, { commitment: 'confirmed' });
    if (show(paramsOf(state)) !== show(sent)) fail(`the ${label}'s state holds ${show(paramsOf(state))}, but ${show(sent)} was sent`);
    if (state.status !== MarketStatus.Open || show(state.reserves) !== show(SOL_MARKET.seed)) {
        fail(`the ${label} is ${state.status}, holding ${show(state.reserves)}`);
    }
    info(`market ${market}: the parameters sent, open, holding the seed ${show(state.reserves)}`);

    const spec = freshSpec(sent, SOL_MARKET.seed);
    for (const [input, output, amount] of SOL_MARKET.trades) {
        await tradeChecked(payer, programId, view, spec, ['demo token', 'wrapped SOL'], input, output, amount);
    }
    await checkBooksAgainst(marketState, spec, sent.virtualReserve);
    record.push([`${label}: swaps`, "both delivered their quotes, the spec's prices"]);
    await payOut(payer, metadata, view, spec, label, 'wrapped SOL');
}

/**
 * Steps 4 to 14, on a local validator only: the token-taxed market, created, seeded, traded,
 * changed by its tax authority and paid out, and a launch graduated from the stand-in
 * launchpad.
 */
async function tokenMarket(payer: KeyPairSigner, programId: Address, metadata: pipeline.StrategyMetadata) {
    const init = metadata.init ?? fail('metadata.json needs `init` for this demo');
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
    if ((init.market_state ?? 'new_keypair') !== 'new_keypair') {
        fail('a tax market\'s state is a new keypair (docs/spec/tax-amm.md, "Addresses")');
    }
    const marketStateKey = await generateKeyPairSigner();
    const marketState = marketStateKey.address;
    const sent = paramsOfBlock(TOKEN_MARKET, payer.address, payer.address, await recipientsOfBlock(payer.address, TOKEN_MARKET));
    const args = metadataArgs(sent);

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
    const seedAction = findAction(metadata, 'seed') ?? fail('metadata.json has no seed action');
    const view: pipeline.MarketView = {
        market,
        strategyProgram: programId,
        marketState,
        mints: [mintA, mintB],
        vaults,
        tokenPrograms: mints.map(({ tokenProgram }) => tokenProgram),
        supportsExactOut: false,
    };
    const seed = await buildActionInstruction({
        action: seedAction,
        market: view,
        wallet: payer.address,
        args: { amount_0: TOKEN_MARKET.seed[0], amount_1: TOKEN_MARKET.seed[1] },
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
    if (show(state.reserves) !== show(TOKEN_MARKET.seed)) {
        fail(`the market recorded reserves ${show(state.reserves)}, but ${show(TOKEN_MARKET.seed)} was seeded`);
    }
    if (state.mints.join() !== [mintA, mintB].join() || state.vaults.join() !== vaults.join()) {
        fail('the market state records other mints or vaults');
    }
    info(`the market state holds exactly the parameters sent; it is open, holding the seed ${show(state.reserves)}`);
    record.push(['parameters read back', 'all equal to those sent']);

    step('8. Trading both ways through the router');
    // The spec's own account of the market, from what was sent, never from the program.
    const spec = freshSpec(sent, TOKEN_MARKET.seed);
    const names = ['token A', 'token B'];
    const tradeAndCheck = (input: number, output: number, amount: bigint) =>
        tradeChecked(payer, programId, view, spec, names, input, output, amount);
    for (const [input, output, amount] of TOKEN_MARKET.trades) await tradeAndCheck(input, output, amount);
    record.push(['swaps', 'both delivered their quotes, the spec\'s prices']);

    step("9. Reading the market state back against the spec's formulas");
    const checkBooks = () => checkBooksAgainst(marketState, spec, sent.virtualReserve);
    await checkBooks();
    record.push(['market state after trading', "equal to the spec's formulas"]);

    // The tax authority's actions, from the metadata, as Aviary's generic forms build them.
    const actionNamed = (name: string) =>
        findAction(metadata, name) ?? fail(`metadata.json has no ${name} action`);
    const authorityAction = async (name: string, actionArgs: Record<string, number | bigint | Address>) =>
        buildActionInstruction({ action: actionNamed(name), market: view, wallet: payer.address, args: actionArgs });
    const recipientArgs = (recipients: readonly Address[], shares: readonly number[], burnShareBps: number) => {
        const result: Record<string, number | Address> = { burn_share_bps: burnShareBps };
        recipients.forEach((recipient, i) => (result[`recipient_${i}`] = recipient));
        shares.forEach((share, i) => (result[`share_${i}`] = share));
        return result;
    };

    step("10. Changing both rates through the metadata's set_taxes action, then trading at them");
    const [newBuy, newSell] = TOKEN_MARKET.newTaxesBps;
    await send(`set_taxes (buy ${newBuy}, sell ${newSell})`, payer, [
        await authorityAction('set_taxes', { buy_tax_bps: newBuy, sell_tax_bps: newSell }),
    ]);
    const { data: retaxed } = await fetchTaxMarket(rpc, marketState, { commitment: 'confirmed' });
    if (retaxed.buyTaxBps !== newBuy || retaxed.sellTaxBps !== newSell) {
        fail(`the market state's rates are ${retaxed.buyTaxBps} and ${retaxed.sellTaxBps}, not ${newBuy} and ${newSell}`);
    }
    info(`buy tax ${sent.buyTaxBps} -> ${retaxed.buyTaxBps} bps, sell tax ${sent.sellTaxBps} -> ${retaxed.sellTaxBps} bps`);
    spec.buyTaxBps = newBuy;
    spec.sellTaxBps = newSell;
    // The same trades again: each quote must be the spec's price at the new rates.
    for (const [input, output, amount] of TOKEN_MARKET.trades) await tradeAndCheck(input, output, amount);
    await checkBooks();
    record.push(['set_taxes', `the next swaps were taxed at ${newBuy} and ${newSell} bps`]);

    step("11. Changing a tax recipient through the metadata's set_recipients action");
    const { data: beforeHandover } = await fetchTaxMarket(rpc, marketState, { commitment: 'confirmed' });
    const newRecipient = (await generateKeyPairSigner()).address;
    const handedOver = [...beforeHandover.recipients];
    const slot = 1;
    handedOver[slot] = newRecipient;
    await send('set_recipients', payer, [
        await authorityAction(
            'set_recipients',
            recipientArgs(handedOver, beforeHandover.shares, beforeHandover.burnShareBps),
        ),
    ]);
    const { data: afterHandover } = await fetchTaxMarket(rpc, marketState, { commitment: 'confirmed' });
    if (afterHandover.recipients.join() !== handedOver.join()) {
        fail(`the market state names recipients ${afterHandover.recipients.join(', ')}`);
    }
    if (beforeHandover.owed[slot] === 0n || show(afterHandover.owed) !== show(beforeHandover.owed)) {
        fail(`slot ${slot} was owed ${beforeHandover.owed[slot]} and is now owed ${afterHandover.owed[slot]}`);
    }
    if (show(afterHandover.shares) !== show(beforeHandover.shares) || afterHandover.burnShareBps !== beforeHandover.burnShareBps) {
        fail('the shares or the burn share changed');
    }
    info(`slot ${slot}: ${beforeHandover.recipients[slot]} -> ${afterHandover.recipients[slot]}`);
    info(`slot ${slot} is still owed ${afterHandover.owed[slot]}, now the new wallet's; every owed amount unchanged ${show(afterHandover.owed)}`);
    record.push(['set_recipients', `slot ${slot} names ${newRecipient}, still owed ${afterHandover.owed[slot]}`]);

    step("12. Renouncing through the metadata's renounce_tax_authority action");
    await send('renounce_tax_authority', payer, [await authorityAction('renounce_tax_authority', {})]);
    const { data: renounced } = await fetchTaxMarket(rpc, marketState, { commitment: 'confirmed' });
    if (!renounced.taxAuthorityRenounced || renounced.taxAuthority !== DEFAULT_ADDRESS) {
        fail(`after renouncing, the market state's tax authority is ${renounced.taxAuthority} (renounced: ${renounced.taxAuthorityRenounced})`);
    }
    info('the market has no tax authority now, and is marked as renounced');
    const refusals: [string, Instruction][] = [
        ['set_taxes', await authorityAction('set_taxes', { buy_tax_bps: sent.buyTaxBps, sell_tax_bps: sent.sellTaxBps })],
        [
            'set_recipients',
            await authorityAction('set_recipients', recipientArgs(beforeHandover.recipients, renounced.shares, renounced.burnShareBps)),
        ],
    ];
    for (const [name, instruction] of refusals) {
        const code = await simulatedErrorCode(payer, [instruction]);
        if (code !== TAX_AMM_ERROR__ALREADY_RENOUNCED) {
            fail(`${name} after renouncing: expected error ${TAX_AMM_ERROR__ALREADY_RENOUNCED} (AlreadyRenounced), got ${code ?? 'success'}`);
        }
        info(`${name}: refused with ${code}, "${getTaxAmmErrorMessage(code as TaxAmmError)}"`);
    }
    const { data: unchanged } = await fetchTaxMarket(rpc, marketState, { commitment: 'confirmed' });
    if (show(unchanged) !== show(renounced)) fail('the market state changed after renouncing');
    info('the market state is exactly as it was when the authority renounced');
    record.push(['renounce_tax_authority', 'set_taxes and set_recipients refused afterwards']);

    step('13. Graduating a token from a launchpad into a tax market');
    await graduateFromLaunchpad(payer, programId, metadata);

    step("14. Paying out every slot of the market with the metadata's distribute and burn actions");
    await payOut(payer, metadata, view, spec, 'market', 'token B');
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
    // Once the metadata pins a deploy, the router is pointed at it at its commit, never at main's
    // link, whose content moves with every later change; whether or not that link resolves yet.
    if (onDevnet && metadataUri === `${RAW_REPO}/main/programs/tax-amm/metadata.json`) {
        let onMain: { source?: { commit?: string } } | undefined;
        try {
            onMain = JSON.parse(execFileSync('git', ['-C', repoRoot(), 'show', 'origin/main:programs/tax-amm/metadata.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
        } catch {
            // No git or no origin/main here: the checkout's copy says.
        }
        const pinned = onMain?.source?.commit ?? (local.value as { source?: { commit?: string } }).source?.commit;
        if (pinned) fail(`the metadata.json on main is pinned to the deploy of ${pinned}: register it at the commit that holds it, not on main`);
    }
    const published = await pipeline.fetchStrategyMetadata(metadataUri);
    if (published.ok && published.warnings.length === 0) {
        info(`${metadataUri} is valid with zero warnings`);
    } else if (onDevnet && options['metadata-not-yet-public'] && !published.ok) {
        // The router only stores the URI; it resolves once the repo is public (TAX-54). Only a
        // URI that cannot be fetched: one that resolves with warnings still stops below. It
        // takes this repo's metadata.json on main, or at a commit on main, whose copy is
        // checked as the link will serve it.
        const at = new RegExp(`^${RAW_REPO.replaceAll('.', '\\.')}/(main|[0-9a-f]{40})/programs/tax-amm/metadata\\.json$`).exec(metadataUri)?.[1];
        if (!at) fail(`--metadata-not-yet-public takes only this repo's programs/tax-amm/metadata.json on main or at a full commit on ${RAW_REPO}, not ${metadataUri}`);
        // The copy the link will serve, origin/main's or the commit's, read from the repo's root
        // wherever the script is run from, after fetching main so it is the one served now. A
        // commit's copy must pin the deploy main records and carry its report.
        const root = repoRoot();
        const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        try {
            execFileSync('perl', ['-e', 'alarm 120; exec @ARGV', 'git', '-C', root, 'fetch', '-q', 'origin', 'main'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            const stderr = String((error as { stderr?: string }).stderr ?? '').trim();
            fail(`git fetch origin main failed${stderr ? `: ${stderr}` : ' (timed out after 120 s)'}; the copy the link serves could not be checked (if git names a lock under .git, a stalled fetch left it: remove it and try again)`);
        }
        const ref = at === 'main' ? 'origin/main' : at;
        if (at !== 'main') {
            try {
                git(['merge-base', '--is-ancestor', at, 'origin/main']);
            } catch {
                fail(`${at} is not a commit on origin/main`);
            }
        }
        let served: unknown;
        try {
            served = JSON.parse(git(['show', `${ref}:programs/tax-amm/metadata.json`]));
        } catch (error) {
            fail(`cannot read programs/tax-amm/metadata.json at ${ref}: ${String(error).split('\n')[0]}`);
        }
        const copy = pipeline.parseStrategyMetadata(served);
        if (!copy.ok || copy.warnings.length > 0) {
            fail(`the metadata.json at ${ref} does not pass the validator with zero warnings: ${copy.ok ? copy.warnings.join('; ') : copy.errors.join('; ')}`);
        }
        if (at !== 'main') {
            // The deploy main records, not this checkout's copy.
            let deployed: { commit?: string } | undefined;
            try {
                deployed = JSON.parse(git(['show', 'origin/main:deployments/devnet.json'])).programs?.['tax-amm'];
            } catch {
                fail('origin/main has no readable deployments/devnet.json, so there is no deploy to register metadata for');
            }
            const pinned = served as { source?: { commit?: string }; conformance?: { report?: string; sha256?: string } };
            if (!deployed?.commit || !pinned.source?.commit || pinned.source.commit !== deployed.commit || !pinned.conformance) {
                fail(`the metadata.json at ${at} pins ${pinned.source?.commit ?? 'no commit'}${pinned.conformance ? '' : ' and no report'}, not the deploy of ${deployed?.commit ?? 'nothing'} with its report`);
            }
            // Its report must be linked at a commit on main, and hash as that commit holds it.
            const reportCommit = new RegExp(`^${RAW_REPO.replaceAll('.', '\\.')}/([0-9a-f]{40})/programs/tax-amm/conformance/devnet\\.json$`).exec(pinned.conformance.report ?? '')?.[1];
            if (!reportCommit) fail(`the metadata.json at ${at} links its report at ${pinned.conformance.report}, not at a full commit of this repo`);
            let reportBytes: Buffer;
            try {
                git(['merge-base', '--is-ancestor', reportCommit, 'origin/main']);
                reportBytes = execFileSync('git', ['-C', root, 'show', `${reportCommit}:programs/tax-amm/conformance/devnet.json`], { stdio: ['ignore', 'pipe', 'pipe'] });
            } catch {
                fail(`the report commit ${reportCommit} is not on origin/main or holds no programs/tax-amm/conformance/devnet.json`);
            }
            const reportHash = createHash('sha256').update(reportBytes).digest('hex');
            if (reportHash !== pinned.conformance.sha256) fail(`the report at ${reportCommit} hashes to ${reportHash}, not the ${pinned.conformance.sha256} the metadata names`);
        }
        info(`${metadataUri} does not resolve yet (${published.reason}); registering it anyway with --metadata-not-yet-public`);
        info(`the metadata.json at ${ref} was checked instead; desks show the strategy without metadata until the repo is public`);
    } else if (onDevnet) {
        // Pipeline's registry and every terminal read the strategy through this URI.
        fail(
            `${metadataUri} must resolve and pass the validator with zero warnings before it is registered on devnet: ${
                published.ok ? published.warnings.join('; ') : `${published.reason}: ${published.errors.join('; ')}`
            }`,
        );
    } else {
        info(`warning: ${metadataUri} can't be used yet (${published.ok ? published.warnings.join('; ') : `${published.reason}: ${published.errors.join('; ')}`})`);
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

    if (options['register-only']) {
        info('--register-only: no market is created');
    } else {
        if (onlyDemoMarket) {
            step('4 to 14. The token-taxed market and the launch');
            info(
                onDevnet
                    ? 'skipped: on devnet the demo creates only the demo market, step 15'
                    : 'skipped by --demo-market-only, as on devnet',
            );
        } else {
            await tokenMarket(payer, programId, metadata);
        }

        step('15. The demo market, a demo token taxed in wrapped SOL: created, seeded, traded and paid out');
        await solTaxedMarket(payer, programId, metadata);
    }

    step(`Done on ${cluster.url}`);
    const width = Math.max(...record.map(([label]) => label.length));
    for (const [label, value] of record) info(`${label.padEnd(width)}  ${value}`);
    if (options.record) {
        const run = { cluster: onDevnet ? 'devnet' : cluster.url, metadataUri, at: new Date().toISOString(), record };
        writeFileSync(options.record, `${JSON.stringify(run, null, 2)}\n`);
        info(`written to ${options.record}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
