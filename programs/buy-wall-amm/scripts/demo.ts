// The buy wall AMM's demo: lists the strategy on a Pipeline router, then creates and seeds
// a market in one transaction, step by step, building the market creation and the seed
// from metadata.json with Pipeline's TypeScript SDK, as Aviary will:
//
//   1. check the program is deployed and the upgrade-authority key is its upgrade authority;
//   2. check metadata.json, and the published copy at the metadata URI;
//   3. register the strategy, signed and paid for by the upgrade authority (once), or point
//      it at a new metadata URI;
//   4. create a test token with its mint authority removed (it has no freeze authority),
//      and wrap the SOL for the seed and the buy;
//   5. in one transaction: create the market from the metadata's `init` form, add a fee
//      account for each mint, and seed it through the metadata's `seed` action;
//   6. read the market back: the router's record (token at index 0, wrapped SOL at index 1,
//      no exact-out) and the market state, through the generated client (client/), opened at
//      the price and liquidity the spec's maths gives, recomputed here independently;
//   7. trade both ways through the router: a buy of 1 SOL and a sell of what it bought, each
//      quoted and swapped with the SDK, the quote checked against the spec's formulas
//      (recomputed here independently) and the worked example's numbers, and the trader paid
//      exactly the quote;
//   8. read the books back: the price, the pool and fee ledgers and the counters equal the
//      spec's formulas to the unit, and each vault holds exactly the sum of its ledgers;
//   9. on a local validator only, graduate a second token from the stand-in launchpad
//      (programs/tax-amm/scripts/launchpad.ts): it calls `pipeline_seed_liquidity`, built
//      from the metadata's `seed_liquidity` form with the SDK's `resolveInit`, and the same
//      transaction records the market with `register_existing_market` and both fee
//      accounts; exactly the seed leaves the escrows, `SeedResult.taken` says so with
//      `lp_amount` 0, the market state is open at the seeded PDA with the launchpad's PDA
//      as its seeder and the parameters sent, and the market trades both ways through the
//      router at the spec's prices, which are the worked example's.
//
// On the pattern of the tax AMM's demo (programs/tax-amm/scripts/demo.ts). Deploy the
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
//   --payer              pays fees, creates the token and the market, and is its seeder
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
    compileTransaction,
    createDefaultRpcTransport,
    createKeyPairSignerFromBytes,
    createSolanaRpcFromTransport,
    createTransactionMessage,
    generateKeyPairSigner,
    getBase64EncodedWireTransaction,
    AccountRole,
    getSignatureFromTransaction,
    getTransactionEncoder,
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
    AuthorityType,
    findAssociatedTokenPda,
    getTransferCheckedInstruction,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getInitializeMint2Instruction,
    getMintSize,
    getMintToInstruction,
    getSetAuthorityInstruction,
    getSyncNativeInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import * as pipeline from '@pipeline-placeholder/sdk';

import { findSeederPda, graduateInstruction, graduationFromLogs, LAUNCHPAD_PROGRAM_ADDRESS } from '../../tax-amm/scripts/launchpad.ts';
import {
    fetchMarketState,
    findMarketStatePda,
    findSolVaultPda,
    findTokenVaultPda,
    findVaultAuthorityPda,
    getMarketStateSize,
    DESIGNER_SHARE_BPS,
    MARKET_STATE_DISCRIMINATOR,
    SUITE_SHARE_BPS,
} from './client/index.ts';

// Written by Pipeline's scripts/new-strategy.sh; the same address as `declare_id!`.
const DEFAULT_PROGRAM_ID = 'BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6';
const DEFAULT_METADATA_URI =
    'https://raw.githubusercontent.com/imDev2023/testing-pipeline/main/programs/buy-wall-amm/metadata.json';
const WSOL = address('So11111111111111111111111111111111111111112');

// The demo market: the spec's worked example (docs/spec/pool4-for-solana.md, "Worked
// example"), seeded with 1,000,000 tokens of 6 decimals and 10 SOL. These are the demo's
// own choices, not the program's policy values; the parameters are IMD's launch values,
// as Aviary's create form pre-fills them.
const DEMO = {
    decimals: 6,
    tokens: 1_000_000_000_000n,
    lamports: 10_000_000_000n,
    feeBps: 100,
    wallSplitBps: 5_000,
    rewardShareBps: 1_500,
    capFloorBps: 2_000,
    capDecayBps: 2_000,
    // Step 7's buy, and the tokens and SOL beyond the seed the payer keeps so that each
    // trade can pay Pipeline's fee on top of its input.
    buy: 1_000_000_000n,
    spareTokens: 1_000_000_000n,
    spareLamports: 100_000_000n,
};

// The worked example's two trades, which the demo market must reproduce exactly
// (docs/spec/pool4-for-solana.md, "Worked example").
const WORKED = {
    buyOut: 90_081_892_629n,
    buySqrtPrice: 2_027_297_173_702_505_949n,
    sellOut: 980_099_999n,
    sellSqrtPrice: 1_844_674_407_372_029_099n,
};
// The most SOL the strategy's setup may spend on rent; the router returns the rest.
const MAX_CREATOR_LAMPORTS = 100_000_000n;
// The launch the stand-in launchpad graduates in step 9, on a local validator only: the demo
// market's parameters and seed, from escrows holding more than the seed, so the market takes
// exactly the seed and leaves the rest; the launchpad lends the strategy at most
// `maxPayerLamports` for rent and takes back what it did not spend.
const LAUNCH = {
    escrowedTokens: 1_500_000_000_000n,
    escrowedLamports: 12_000_000_000n,
    maxPayerLamports: 50_000_000n,
};
// What a local run airdrops when a key holds less: the payer creates both tokens and both
// markets and brings both seeds' SOL, and the upgrade authority pays the listing fee and the
// strategy account's rent.
const LOCAL_FUNDING = { payer: 40_000_000_000n, upgradeAuthority: 1_000_000_000n };
// Solana's limit on a transaction's size on the wire.
const TRANSACTION_SIZE_LIMIT = 1_232;

const LOCALNET_URL = 'http://127.0.0.1:8899';
const DEVNET_URL = 'https://api.devnet.solana.com';
// What `getGenesisHash` answers on each public cluster; a local validator has its own.
const GENESIS_HASHES = {
    devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
    mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'];

// `status` once a market is seeded (docs/spec/pool4-for-solana.md, "Byte offsets").
const STATUS_OPEN = 2;

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

/** Builds and signs a transaction, returning it with its size on the wire. */
async function sign(feePayer: KeyPairSigner, instructions: Instruction[], extra: KeyPairSigner[]) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = pipe(
        createTransactionMessage({ version: 'legacy' }),
        (m) => setTransactionMessageFeePayerSigner(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
        (m) => addSignersToTransactionMessage(extra, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const size = getTransactionEncoder().encode(compileTransaction(message)).length;
    return { signed, size };
}

/**
 * Sends a transaction and waits for confirmation by polling (public RPCs often refuse
 * WebSockets). Stops before sending if the transaction is over Solana's size limit.
 */
async function send(label: string, feePayer: KeyPairSigner, instructions: Instruction[], extra: KeyPairSigner[] = []) {
    const { signed, size } = await sign(feePayer, instructions, extra);
    if (size > TRANSACTION_SIZE_LIMIT) {
        fail(`${label} is ${size} bytes, over the ${TRANSACTION_SIZE_LIMIT}-byte limit; nothing was sent`);
    }
    const signature = getSignatureFromTransaction(signed);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' }).send();
    await waitFor(label, signature);
    info(`${label}: ${explorer('tx', signature)}`);
    record.push([label, signature]);
    return { signature, size };
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

async function tokenBalance(account: Address): Promise<bigint> {
    const { value } = await rpc.getTokenAccountBalance(account, { commitment: 'confirmed' }).send();
    return BigInt(value.amount);
}

async function walletTokenAccount(owner: Address, mint: Address): Promise<Address> {
    const [account] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    return account;
}

/** A little-endian unsigned integer: the market state keeps every integer as its bytes. */
function le(bytes: ArrayLike<number>): bigint {
    let value = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i] ?? 0);
    return value;
}

/** floor(sqrt(n)) for a non-negative bigint, by Newton's method. */
function isqrt(n: bigint): bigint {
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
    }
    return x;
}

/** The opening the spec's maths gives a seed of `x` token units and `y` lamports. */
function expectedOpening(x: bigint, y: bigint) {
    const Q = 1n << 64n;
    const sqrtPrice = isqrt((y << 128n) / x);
    const tokenSide = (x * sqrtPrice) / Q;
    const solSide = (y * Q) / sqrtPrice;
    return { sqrtPrice, liquidity: tokenSide < solSide ? tokenSide : solSide };
}

/**
 * A new SPL Token mint with `amount` minted to the wallet and its mint authority then
 * removed (it never had a freeze authority), as the buy wall AMM requires of a token by the
 * time it is seeded.
 */
async function createTestToken(wallet: KeyPairSigner, decimals: number, amount: bigint) {
    const mint = await generateKeyPairSigner();
    const space = BigInt(getMintSize());
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
    const holder = await walletTokenAccount(wallet.address, mint.address);
    await send(
        'create the test token, mint it and remove its mint authority',
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
            getSetAuthorityInstruction({
                owned: mint.address,
                owner: wallet,
                authorityType: AuthorityType.MintTokens,
                newAuthority: null,
            }),
        ],
        [mint],
    );
    info(`token: ${mint.address}`);
    return mint.address;
}

/** Wraps `amount` lamports into the wallet's wrapped SOL account. */
async function wrapSol(wallet: KeyPairSigner, amount: bigint) {
    const account = await walletTokenAccount(wallet.address, WSOL);
    await send('wrap SOL', wallet, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: wallet, owner: wallet.address, mint: WSOL }),
        getTransferSolInstruction({ source: wallet, destination: account, amount }),
        getSyncNativeInstruction({ account }),
    ]);
    return account;
}

/**
 * The spec's pricing with no buy wall (docs/spec/pool4-for-solana.md, "A sell", "A buy" and
 * "The fee"), written out here from the spec rather than taken from the program, so the
 * demo checks the program against the spec. The demo's trades stay far from the price
 * bounds, so the model leaves them out: a trade the program refused at a bound would fail
 * the demo at its quote.
 */
const Q = 1n << 64n;
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;
const ceilBps = (amount: bigint, bps: bigint) => ceilDiv(amount * bps, 10_000n);

type Curve = { sqrtPrice: bigint; liquidity: bigint };
type Priced = { fee: bigint; out: bigint; sqrtPrice: bigint };

function specBuy({ sqrtPrice: s, liquidity: l }: Curve, a: bigint, feeBps: bigint): Priced {
    const fee = ceilBps(a, feeBps);
    const next = s + ((a - fee) * Q) / l;
    return { fee, out: (l * Q * (next - s)) / (next * s), sqrtPrice: next };
}

function specSell({ sqrtPrice: s, liquidity: l }: Curve, a: bigint, feeBps: bigint): Priced {
    const next = ceilDiv(l * Q * s, l * Q + a * s);
    const gross = (l * (s - next)) / Q;
    const fee = ceilBps(gross, feeBps);
    return { fee, out: gross - fee, sqrtPrice: next };
}

/** The fee split: designer, suite, wall and recipient, as "The fee" writes it. */
function specSplit(fee: bigint, wallSplitBps: bigint) {
    const designer = (fee * BigInt(DESIGNER_SHARE_BPS)) / 10_000n;
    const suite = (fee * BigInt(SUITE_SHARE_BPS)) / 10_000n;
    const rest = fee - designer - suite;
    const wall = (rest * wallSplitBps) / 10_000n;
    return { designer, suite, wall, recipient: rest - wall };
}

/** A token amount and a wrapped SOL amount, for messages. */
const show = (amounts: readonly bigint[]) => amounts.map(String).join(' / ');

/**
 * Step 9, on a local validator: the stand-in launchpad graduates a new token into a buy wall
 * market through `pipeline_seed_liquidity`, built from the metadata's `seed_liquidity` form,
 * and the same transaction records it with `register_existing_market` and both fee accounts;
 * then the market trades both ways through the router at the spec's prices.
 */
async function graduateFromLaunchpad(payer: KeyPairSigner, programId: Address, metadata: pipeline.StrategyMetadata) {
    const launchpad = await pipeline.inspectProgram(rpc, LAUNCHPAD_PROGRAM_ADDRESS, { hashExecutable: false });
    if (!launchpad.deployed) {
        fail(`the stand-in launchpad is not at ${LAUNCHPAD_PROGRAM_ADDRESS}: start the validator with scripts/local-validator.sh`);
    }
    const form = (metadata as { seed_liquidity?: pipeline.MetadataInit }).seed_liquidity;
    if (!form?.market_state || !form.args || !form.accounts) fail('metadata.json needs its seed_liquidity form');

    // A new token, the payer's, with its mint authority removed; the launch's escrows are
    // the seeder's own token accounts, filled from the payer's.
    const token = await createTestToken(payer, DEMO.decimals, LAUNCH.escrowedTokens + DEMO.spareTokens);
    const seeder = await findSeederPda(payer.address);
    const mints = [token, WSOL];
    const tokenPrograms = [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS];
    const escrows = await Promise.all(
        mints.map(async (mint) => (await findAssociatedTokenPda({ owner: seeder, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]),
    );
    await send('fill the launch escrows', payer, [
        ...(await Promise.all(
            mints.map((mint) => getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: seeder, mint })),
        )),
        getTransferCheckedInstruction({
            source: await walletTokenAccount(payer.address, token),
            mint: token,
            destination: escrows[0]!,
            authority: payer,
            amount: LAUNCH.escrowedTokens,
            decimals: DEMO.decimals,
        }),
        getTransferSolInstruction({ source: payer, destination: escrows[1]!, amount: LAUNCH.escrowedLamports }),
        getSyncNativeInstruction({ account: escrows[1]! }),
    ]);
    info(`seeder ${seeder}, the launchpad's PDA for this creator; escrows ${escrows.join(', ')}`);

    // The metadata's form resolves the market state and the strategy's own accounts before
    // anything is sent. `data` is the creation parameters; their seeder is ignored, since the
    // launchpad's PDA seeds the market, so the demo sends the default key there.
    const sent = {
        fee_bps: DEMO.feeBps,
        wall_split_bps: DEMO.wallSplitBps,
        fee_recipient: payer.address,
        reward_share_bps: DEMO.rewardShareBps,
        rewards_recipient: payer.address,
        cap_floor_bps: DEMO.capFloorBps,
        cap_decay_bps: DEMO.capDecayBps,
        seeder: address('11111111111111111111111111111111'),
    };
    const resolved = await pipeline.resolveInit({
        init: form,
        strategyProgram: programId,
        creator: payer.address,
        args: sent,
        inputs: { seeder, token_mint: token },
        tokenPrograms: { [token]: TOKEN_PROGRAM_ADDRESS, [WSOL]: TOKEN_PROGRAM_ADDRESS },
        rpc,
    });
    const marketState = resolved.marketState;
    const [expectedState] = await findMarketStatePda({ seeder, tokenMint: token, wsolMint: WSOL }, { programAddress: programId });
    if (marketState !== expectedState) fail(`the metadata resolved market state ${marketState}, not the program's PDA ${expectedState}`);
    const [vaultAuthority] = await findVaultAuthorityPda({ marketState }, { programAddress: programId });
    const [tokenVault] = await findTokenVaultPda({ marketState, tokenMint: token }, { programAddress: programId });
    const [solVault] = await findSolVaultPda({ marketState, wsolMint: WSOL }, { programAddress: programId });
    const vaults = [tokenVault, solVault];
    if (resolved.strategyAccounts.map((account) => account.address).join() !== [vaultAuthority, ...vaults].join()) {
        fail("the metadata's seed_liquidity accounts are not the program's PDAs");
    }
    const market = resolved.market;
    const feeAccounts = await Promise.all(mints.map((mint) => pipeline.feeAccountPda(market, mint, TOKEN_PROGRAM_ADDRESS)));
    for (const [label, account] of [
        ['router market', market],
        ['market state', marketState],
        ['token vault', tokenVault],
        ['SOL vault', solVault],
        ['fee account, token', feeAccounts[0]!],
        ['fee account, SOL', feeAccounts[1]!],
    ] as const) {
        if (await accountData(account)) fail(`the ${label} ${account} exists before the graduation`);
        info(`${label.padEnd(20)} ${account}`);
    }

    const seed = [DEMO.tokens, DEMO.lamports];
    const graduate = await graduateInstruction({
        creator: payer.address,
        strategyProgram: programId,
        amounts: seed,
        data: resolved.initData,
        maxPayerLamports: LAUNCH.maxPayerLamports,
        accounts: [
            { address: marketState, role: AccountRole.WRITABLE },
            // A buy wall market issues no LP shares, so the LP recipient is ignored.
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
    const { signature, size } = await send(
        'graduate (pipeline_seed_liquidity) + register_existing_market + init_fee_account x2',
        payer,
        [graduate, ...listing],
    );
    info(`one transaction of ${size} bytes (limit ${TRANSACTION_SIZE_LIMIT})`);
    info(`market ${explorer('address', market)}`);
    record.push(['seeded market', market], ['seeded market state', marketState], ['graduation size', `${size} bytes`]);

    // What the transaction did: the launchpad's return data, and the strategy's cost.
    const transaction = await rpc
        .getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' })
        .send();
    const logs = transaction?.meta?.logMessages ?? fail('the graduation left no logs');
    const graduation = graduationFromLogs(logs) ?? fail("the launchpad's return data is missing");
    const escrowed = [LAUNCH.escrowedTokens, LAUNCH.escrowedLamports];
    const left = await Promise.all(escrows.map(async (escrow, i) => escrowed[i]! - (await tokenBalance(escrow))));
    if (show(graduation.leftEscrows) !== show(seed) || show(left) !== show(seed)) {
        fail(`the escrows lost ${show(left)} (the launchpad measured ${show(graduation.leftEscrows)}), not the seed ${show(seed)}`);
    }
    if (show(graduation.taken) !== show(left) || graduation.lpAmount !== 0n) {
        fail(`SeedResult says taken ${show(graduation.taken)}, lp_amount ${graduation.lpAmount}, but ${show(left)} left the escrows`);
    }
    info(`SeedResult: taken ${show(graduation.taken)}, exactly what left the escrows, lp_amount 0`);
    const consumed = logs
        .map((line) => line.match(new RegExp(`^Program ${programId} consumed (\\d+) of`))?.[1])
        .find((units) => units !== undefined);
    info(`pipeline_seed_liquidity: ${consumed} CU`);
    record.push(['pipeline_seed_liquidity', `${consumed} CU`]);

    const routerMarket = pipeline.decodeMarket((await accountData(market)) ?? new Uint8Array());
    if (!routerMarket) fail(`the router has no market at ${market}`);
    const view = pipeline.marketViewFromMarket(market, routerMarket, tokenPrograms);
    if (view.mints.join() !== mints.join() || view.vaults.join() !== vaults.join() || view.supportsExactOut) {
        fail(`the router recorded mints ${view.mints.join(', ')} and vaults ${view.vaults.join(', ')}`);
    }
    for (const feeAccount of feeAccounts) {
        if (!(await accountData(feeAccount))) fail(`fee account ${feeAccount} was not created`);
    }
    info('router market: recorded in the same transaction, token at index 0, wrapped SOL at index 1, both fee accounts');

    // The market state: the same fixed-size layout as a market created through the router,
    // with the launchpad's PDA as its seeder and every other parameter as sent.
    const raw = (await accountData(marketState)) ?? fail('no market state');
    const { data: state } = await fetchMarketState(rpc, marketState, { commitment: 'confirmed' });
    const discriminator = new TextDecoder().decode(state.discriminator as Uint8Array);
    if (raw.length !== getMarketStateSize() || discriminator !== new TextDecoder().decode(MARKET_STATE_DISCRIMINATOR as Uint8Array) || state.layoutVersion !== 1) {
        fail(`the market state is ${raw.length} bytes, "${discriminator}", layout ${state.layoutVersion}`);
    }
    const params = {
        fee_bps: le(state.feeBps),
        wall_split_bps: le(state.wallSplitBps),
        fee_recipient: state.feeRecipient,
        reward_share_bps: le(state.rewardShareBps),
        rewards_recipient: state.rewardsRecipient,
        cap_floor_bps: le(state.capFloorBps),
        cap_decay_bps: le(state.capDecayBps),
        seeder: state.seeder,
    };
    const wanted = { ...sent, seeder };
    if (JSON.stringify(params, (_, v) => (typeof v === 'bigint' ? Number(v) : v)) !== JSON.stringify(wanted)) {
        fail(`the market state holds ${JSON.stringify(params, (_, v) => (typeof v === 'bigint' ? Number(v) : v))}, not ${JSON.stringify(wanted)}`);
    }
    const expected = expectedOpening(DEMO.tokens, DEMO.lamports);
    const opened = { sqrtPrice: le(state.sqrtPrice), liquidity: le(state.liquidity) };
    if (
        state.status !== STATUS_OPEN ||
        state.marketSigner !== market ||
        opened.sqrtPrice !== expected.sqrtPrice ||
        opened.liquidity !== expected.liquidity ||
        le(state.cap) !== DEMO.tokens ||
        le(state.poolTokens) !== DEMO.tokens ||
        le(state.poolSol) !== DEMO.lamports
    ) {
        fail(`the market state is status ${state.status}, sqrt_price ${opened.sqrtPrice}, liquidity ${opened.liquidity}, cap ${le(state.cap)}`);
    }
    info(`the market state holds the parameters sent with the launchpad's PDA as its seeder; open at sqrt_price ${opened.sqrtPrice}, liquidity ${opened.liquidity}, holding the seed`);

    // It trades like any market: the worked example's buy and sell, each at its quote, the
    // spec's price.
    const payerAccounts = await Promise.all(mints.map((mint) => walletTokenAccount(payer.address, mint)));
    let curve: Curve = opened;
    let bought = 0n;
    for (const [input, output, label] of [
        [1, 0, 'buy'],
        [0, 1, 'sell'],
    ] as const) {
        const amount = input === 1 ? DEMO.buy : bought;
        const trade = {
            mode: pipeline.TradeMode.ExactIn,
            inputIndex: input,
            outputIndex: output,
            amount,
            trader: payer.address,
            extra: new Uint8Array(),
        };
        const simulation = { commitment: 'confirmed' } as const;
        const strategyAccounts = await pipeline.resolveAccounts(rpc, view, trade, payer.address, simulation);
        const { quote } = await pipeline.quoteStrategy(rpc, view, trade, strategyAccounts, payer.address, simulation);
        const spec = input === 1 ? specBuy(curve, amount, BigInt(DEMO.feeBps)) : specSell(curve, amount, BigInt(DEMO.feeBps));
        const worked = input === 1 ? WORKED.buyOut : WORKED.sellOut;
        if (quote.amountOut !== spec.out || spec.out !== worked) {
            fail(`seeded market, ${label} of ${amount}: quoted ${quote.amountOut}; the spec's formulas give ${spec.out}, the worked example ${worked}`);
        }
        const before = await tokenBalance(payerAccounts[output]!);
        await send(`seeded market: ${label} through the router`, payer, [
            await pipeline.swap(
                {
                    trader: payer.address,
                    strategyProgram: programId,
                    marketState,
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
        if (received !== quote.amountOut) fail(`seeded market, ${label}: received ${received}, quoted ${quote.amountOut}`);
        info(`${label} of ${amount}: received ${received}, exactly the quote, the spec's price and the worked example's`);
        if (input === 1) bought = received;
        curve = { sqrtPrice: spec.sqrtPrice, liquidity: curve.liquidity };
    }
    const { data: traded } = await fetchMarketState(rpc, marketState, { commitment: 'confirmed' });
    if (le(traded.sqrtPrice) !== WORKED.sellSqrtPrice || le(traded.swapCount) !== 2n) {
        fail(`the seeded market ended at sqrt_price ${le(traded.sqrtPrice)} after ${le(traded.swapCount)} swaps`);
    }
    info(`the seeded market ended at sqrt_price ${WORKED.sellSqrtPrice}, as the worked example does`);
    record.push(['seeded market, traded', "graduated, recorded, traded at the spec's prices"]);
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
    const seedAction = metadata.actions?.find((action) => action.name === 'seed');
    if (!metadata.init || !seedAction) {
        fail('metadata.json needs `init` and a `seed` action for this demo');
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

    step('4. Creating a test token and wrapping the SOL for the seed and the buy');
    const token = await createTestToken(payer, DEMO.decimals, DEMO.tokens + DEMO.spareTokens);
    await wrapSol(payer, DEMO.lamports + DEMO.buy + DEMO.spareLamports);
    const tokenPrograms = [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS];

    step("5. Creating the market from the metadata's init form, with its fee accounts and the seed, in one transaction");
    // `init` says how to create a market: the market state is a fresh keypair, which signs.
    const marketStateKey = await generateKeyPairSigner();
    const { instruction: createMarket, resolved } = await pipeline.buildCreateMarketFromMetadata({
        init: metadata.init,
        strategyProgram: programId,
        creator: payer.address,
        marketState: marketStateKey.address,
        args: {
            fee_bps: DEMO.feeBps,
            wall_split_bps: DEMO.wallSplitBps,
            fee_recipient: payer.address,
            reward_share_bps: DEMO.rewardShareBps,
            rewards_recipient: payer.address,
            cap_floor_bps: DEMO.capFloorBps,
            cap_decay_bps: DEMO.capDecayBps,
            seeder: payer.address,
        },
        inputs: { token_mint: token },
        tokenPrograms: { [token]: TOKEN_PROGRAM_ADDRESS, [WSOL]: TOKEN_PROGRAM_ADDRESS },
        maxCreatorLamports: MAX_CREATOR_LAMPORTS,
        rpc,
    });
    if (!resolved.marketStateSigns) {
        fail('the metadata\'s init.market_state must be new_keypair');
    }
    // The market does not exist until the transaction lands, so the seed is built from the
    // addresses `init` resolved: everything is computable before `create_market` is sent.
    const initAccount = (name: string) => {
        const index = metadata.init!.accounts?.findIndex((account) => account.name === name) ?? -1;
        const account = resolved.strategyAccounts[index];
        if (!account) fail(`metadata.json's init has no ${name} account`);
        return account.address;
    };
    // The same addresses as the program's own PDAs, through the generated client.
    const [vaultAuthority] = await findVaultAuthorityPda({ marketState: resolved.marketState });
    const [tokenVault] = await findTokenVaultPda({ marketState: resolved.marketState, tokenMint: token });
    const [solVault] = await findSolVaultPda({ marketState: resolved.marketState, wsolMint: WSOL });
    if (
        initAccount('vault_authority') !== vaultAuthority ||
        initAccount('token_vault') !== tokenVault ||
        initAccount('sol_vault') !== solVault
    ) {
        fail("the metadata's init resolved other vaults than the program's PDAs");
    }
    const view: pipeline.MarketView = {
        market: resolved.market,
        strategyProgram: programId,
        marketState: resolved.marketState,
        mints: [token, WSOL],
        vaults: [initAccount('token_vault'), initAccount('sol_vault')],
        tokenPrograms,
        supportsExactOut: false,
    };
    const feeAccounts = await Promise.all(
        view.mints.map((mint, i) =>
            pipeline.initFeeAccount({ payer: payer.address, market: resolved.market, mint, tokenProgram: tokenPrograms[i]! }),
        ),
    );
    const seed = await pipeline.buildActionInstruction({
        action: seedAction,
        market: view,
        wallet: payer.address,
        args: { token_amount: DEMO.tokens, sol_amount: DEMO.lamports },
    });
    const { size } = await send(
        'create_market + init_fee_account x2 + seed',
        payer,
        [createMarket, ...feeAccounts, seed],
        [marketStateKey],
    );
    info(`one transaction of ${size} bytes (limit ${TRANSACTION_SIZE_LIMIT})`);
    info(`market       ${explorer('address', resolved.market)}`);
    info(`market state ${resolved.marketState}`);
    record.push(['market', resolved.market], ['market state', resolved.marketState], ['transaction size', `${size} bytes`]);

    step('6. Reading the market back');
    const marketAccount = pipeline.decodeMarket((await accountData(resolved.market)) ?? new Uint8Array());
    if (!marketAccount) {
        fail(`the router has no market at ${resolved.market}`);
    }
    const recorded = pipeline.marketViewFromMarket(resolved.market, marketAccount, tokenPrograms);
    if (recorded.mints[0] !== token || recorded.mints[1] !== WSOL) {
        fail(`the router recorded mints ${recorded.mints.join(', ')}, not the token then wrapped SOL`);
    }
    if (recorded.vaults[0] !== view.vaults[0] || recorded.vaults[1] !== view.vaults[1]) {
        fail(`the router recorded vaults ${recorded.vaults.join(', ')}, not the ones init resolved`);
    }
    if (recorded.supportsExactOut) fail('the market reports exact-out support');
    info('router: token at index 0, wrapped SOL at index 1, supports_exact_out = false');

    const raw = (await accountData(resolved.marketState)) ?? fail('no market state');
    const { data: state } = await fetchMarketState(rpc, resolved.marketState, { commitment: 'confirmed' });
    const discriminator = new TextDecoder().decode(state.discriminator as Uint8Array);
    if (raw.length !== getMarketStateSize() || raw.length !== 1_024) {
        fail(`the market state is ${raw.length} bytes, not 1,024`);
    }
    if (discriminator !== new TextDecoder().decode(MARKET_STATE_DISCRIMINATOR as Uint8Array) || state.layoutVersion !== 1) {
        fail(`the market state has discriminator "${discriminator}" and layout ${state.layoutVersion}`);
    }
    if (state.status !== STATUS_OPEN) fail(`the market is not open (status ${state.status})`);
    const sqrtPrice = le(state.sqrtPrice);
    const liquidity = le(state.liquidity);
    const cap = le(state.cap);
    const expected = expectedOpening(DEMO.tokens, DEMO.lamports);
    info(`market state: ${raw.length} bytes, "${discriminator}", layout 1, open`);
    info(`sqrt_price ${sqrtPrice}, liquidity ${liquidity}, cap ${cap}`);
    if (sqrtPrice !== expected.sqrtPrice || liquidity !== expected.liquidity || cap !== DEMO.tokens) {
        fail(`expected sqrt_price ${expected.sqrtPrice}, liquidity ${expected.liquidity}, cap ${DEMO.tokens}`);
    }
    const poolTokens = le(state.poolTokens);
    const poolSol = le(state.poolSol);
    const vaultTokens = await tokenBalance(view.vaults[0]!);
    const vaultSol = await tokenBalance(view.vaults[1]!);
    if (poolTokens !== DEMO.tokens || poolSol !== DEMO.lamports || vaultTokens !== DEMO.tokens || vaultSol !== DEMO.lamports) {
        fail(`ledgers ${poolTokens}/${poolSol}, vaults ${vaultTokens}/${vaultSol}`);
    }
    if (state.seeder !== payer.address || state.tokenVault !== tokenVault || state.solVault !== solVault) {
        fail('the market state records another seeder or other vaults');
    }
    info(`the opening matches the spec's maths, and the vaults hold exactly the seed`);
    record.push(['sqrt_price', `${sqrtPrice}`], ['liquidity', `${liquidity}`], ['cap', `${cap}`]);

    step('7. Trading both ways through the router');
    // The spec's own account of the market, from the seed and what each trade does.
    const feeBps = BigInt(DEMO.feeBps);
    const books = {
        curve: { sqrtPrice, liquidity },
        poolTokens: DEMO.tokens,
        poolSol: DEMO.lamports,
        idleSol: 0n,
        feesRecipient: 0n,
        feesDesigner: 0n,
        feesSuite: 0n,
        volume: [0n, 0n],
        feesCollected: 0n,
        swapCount: 0n,
    };
    const payerAccounts = await Promise.all([token, WSOL].map((mint) => walletTokenAccount(payer.address, mint)));
    let bought = 0n;
    for (const [input, output, label] of [
        [1, 0, 'buy'],
        [0, 1, 'sell'],
    ] as const) {
        const amount = input === 1 ? DEMO.buy : bought;
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
        const strategyAccounts = await pipeline.resolveAccounts(rpc, recorded, trade, payer.address, simulation);
        const listed = strategyAccounts.map((account) => account.address).join();
        if (listed !== [view.vaults[output], vaultAuthority].join()) {
            fail(`${label}: account resolution listed ${listed}, not the output vault and the vault authority`);
        }
        const { quote, unitsConsumed } = await pipeline.quoteStrategy(
            rpc,
            recorded,
            trade,
            strategyAccounts,
            payer.address,
            simulation,
        );
        const spec = input === 1 ? specBuy(books.curve, amount, feeBps) : specSell(books.curve, amount, feeBps);
        const worked = input === 1 ? WORKED.buyOut : WORKED.sellOut;
        if (quote.amountIn !== amount || quote.amountOut !== spec.out || spec.out !== worked) {
            fail(`${label} of ${amount}: quoted ${quote.amountOut} for ${quote.amountIn}; the spec's formulas give ${spec.out}, the worked example ${worked}`);
        }
        info(`${label} of ${amount}: quoted ${quote.amountOut}, the spec's price and the worked example's, fee ${spec.fee} lamports (${unitsConsumed} CU)`);
        const before = await tokenBalance(payerAccounts[output]!);
        await send(`${label} through the router`, payer, [
            await pipeline.swap(
                {
                    trader: payer.address,
                    strategyProgram: programId,
                    marketState: resolved.marketState,
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
        if (received !== quote.amountOut) fail(`${label}: received ${received}, quoted ${quote.amountOut}`);
        info(`${label}: received exactly the quote`);
        record.push([label, `${amount} in, ${received} out`]);

        // What the trade does to the books ("After pricing" steps 2, 3 and 7).
        const split = specSplit(spec.fee, BigInt(DEMO.wallSplitBps));
        if (input === 1) {
            books.poolSol += amount - spec.fee;
            books.poolTokens -= spec.out;
            bought = received;
        } else {
            books.poolTokens += amount;
            books.poolSol -= spec.out + spec.fee;
        }
        books.curve = { sqrtPrice: spec.sqrtPrice, liquidity };
        books.idleSol += split.wall;
        books.feesRecipient += split.recipient;
        books.feesDesigner += split.designer;
        books.feesSuite += split.suite;
        books.volume[input]! += amount;
        books.volume[output]! += spec.out;
        books.feesCollected += spec.fee;
        books.swapCount += 1n;
        const workedPrice = input === 1 ? WORKED.buySqrtPrice : WORKED.sellSqrtPrice;
        if (spec.sqrtPrice !== workedPrice) fail(`${label}: the spec's formulas move the price to ${spec.sqrtPrice}, not ${workedPrice}`);
    }

    step("8. Reading the books back against the spec's formulas");
    const { data: traded } = await fetchMarketState(rpc, resolved.marketState, { commitment: 'confirmed' });
    const read = {
        sqrtPrice: [le(traded.sqrtPrice), books.curve.sqrtPrice],
        lastClose: [le(traded.lastClose), books.curve.sqrtPrice],
        liquidity: [le(traded.liquidity), liquidity],
        poolTokens: [le(traded.poolTokens), books.poolTokens],
        poolSol: [le(traded.poolSol), books.poolSol],
        idleSol: [le(traded.idleSol), books.idleSol],
        feesRecipient: [le(traded.feesRecipient), books.feesRecipient],
        feesDesigner: [le(traded.feesDesigner), books.feesDesigner],
        feesSuite: [le(traded.feesSuite), books.feesSuite],
        volume0: [le(traded.volume[0]!), books.volume[0]!],
        volume1: [le(traded.volume[1]!), books.volume[1]!],
        feesCollected: [le(traded.feesCollected), books.feesCollected],
        swapCount: [le(traded.swapCount), books.swapCount],
    };
    for (const [key, [got, wanted]] of Object.entries(read)) {
        if (got !== wanted) fail(`the market state's ${key} is ${got}, but the spec's formulas give ${wanted}`);
        info(`${key.padEnd(14)} ${got}`);
    }
    const [vaultTokensAfter, vaultSolAfter] = await Promise.all(view.vaults.map((vault) => tokenBalance(vault!)));
    const solLedgers = books.poolSol + books.idleSol + books.feesRecipient + books.feesDesigner + books.feesSuite;
    if (vaultTokensAfter !== books.poolTokens || vaultSolAfter !== solLedgers) {
        fail(`the vaults hold ${vaultTokensAfter} and ${vaultSolAfter}, not their ledgers' ${books.poolTokens} and ${solLedgers}`);
    }
    info("the price, ledgers and counters equal the spec's formulas to the unit; each vault holds exactly its ledgers");
    record.push(['market state after trading', "equal to the spec's formulas"]);

    step('9. Graduating a token from a launchpad into a buy wall market');
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
