// The buy wall AMM's demo: lists the strategy on a Pipeline router, then creates and seeds
// a market in one transaction, step by step, building the market creation and the seed
// from metadata.json with Pipeline's TypeScript SDK, as Aviary will:
//
//   1. check the program is deployed and the upgrade-authority key is its upgrade authority;
//   2. check metadata.json, and the published copy at the metadata URI;
//   3. register the strategy, signed and paid for by the upgrade authority (once), or point
//      it at a new metadata URI;
//   4. create a test token with its mint authority removed (it has no freeze authority),
//      and wrap the SOL for the seed;
//   5. in one transaction: create the market from the metadata's `init` form, add a fee
//      account for each mint, and seed it through the metadata's `seed` action;
//   6. read the market back: the router's record (token at index 0, wrapped SOL at index 1,
//      no exact-out) and the market state, through the generated client (client/), opened at
//      the price and liquidity the spec's maths gives, recomputed here independently;
//   7. check a quote is refused: trading arrives in the next build.
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
    fetchMarketState,
    findSolVaultPda,
    findTokenVaultPda,
    findVaultAuthorityPda,
    getMarketStateSize,
    MARKET_STATE_DISCRIMINATOR,
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
};
// The most SOL the strategy's setup may spend on rent; the router returns the rest.
const MAX_CREATOR_LAMPORTS = 100_000_000n;
// What a local run airdrops when a key holds less: the payer creates the token and the
// market and brings the seed's SOL, and the upgrade authority pays the listing fee and the
// strategy account's rent.
const LOCAL_FUNDING = { payer: 20_000_000_000n, upgradeAuthority: 1_000_000_000n };
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

/** Sends a transaction and waits for confirmation by polling (public RPCs often refuse WebSockets). */
async function send(label: string, feePayer: KeyPairSigner, instructions: Instruction[], extra: KeyPairSigner[] = []) {
    const { signed, size } = await sign(feePayer, instructions, extra);
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
    await send('wrap the seed SOL', wallet, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: wallet, owner: wallet.address, mint: WSOL }),
        getTransferSolInstruction({ source: wallet, destination: account, amount }),
        getSyncNativeInstruction({ account }),
    ]);
    return account;
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

    step('4. Creating a test token and wrapping the seed SOL');
    const token = await createTestToken(payer, DEMO.decimals, DEMO.tokens);
    await wrapSol(payer, DEMO.lamports);
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
    if (size > TRANSACTION_SIZE_LIMIT) fail(`the transaction is over the size limit`);
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

    step('7. Checking a quote is refused (trading arrives in the next build)');
    const trade = {
        mode: pipeline.TradeMode.ExactIn,
        inputIndex: 1,
        outputIndex: 0,
        amount: 1_000_000_000n,
        trader: payer.address,
        extra: new Uint8Array(),
    };
    const simulation = { commitment: 'confirmed' } as const;
    const strategyAccounts = await pipeline.resolveAccounts(rpc, recorded, trade, payer.address, simulation);
    let answered: bigint | undefined;
    try {
        ({
            quote: { amountOut: answered },
        } = await pipeline.quoteStrategy(rpc, recorded, trade, strategyAccounts, payer.address, simulation));
    } catch (error) {
        // The program's own refusal, not any failure: its `TradingNotAvailable` error.
        const logs = error instanceof pipeline.SimulationError ? error.logs : [];
        const refusal = logs.find((line) => line.includes('Error Code: TradingNotAvailable'));
        if (!refusal) fail(`the quote failed for another reason: ${String(error)}\n   ${logs.join('\n   ')}`);
        info(`refused, as this build does: ${refusal.replace(/^Program log: /, '')}`);
    }
    if (answered !== undefined) fail(`the quote was answered: ${answered}`);

    step(`Done on ${cluster.url}`);
    const width = Math.max(...record.map(([label]) => label.length));
    for (const [label, value] of record) info(`${label.padEnd(width)}  ${value}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
