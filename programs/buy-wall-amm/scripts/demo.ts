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
//   7. trade both ways through the router: a buy of 1 SOL, a few seconds after the seed so
//      some cap decay credit has built up, and a sell of what it bought, each quoted and
//      swapped with the SDK, the quote checked against the spec's formulas (recomputed here
//      independently) and the worked example's numbers, and the trader paid exactly the
//      quote; after each, the inventory cap's steps recomputed from the spec: the buy lowers
//      the cap by the credit the seconds since the seed built up, and the sell, leaving the
//      curve above the lowered cap, is trimmed, each swap emitting the event that says so;
//      the wall's guard is recomputed from the spec too, from the slot and time each swap
//      ran at;
//   8. place the buy wall through the metadata's `place_wall` action, from the spec's
//      formulas: refused with WallBelowThreshold while idle SOL is below WALL_THRESHOLD
//      (shown by simulating it), then, after one more buy if its fee is needed, placed in a
//      later slot than the last swap (it is refused in a swap's own slot) at the lower of
//      the price and the guard's floor, brought up to date for that slot, with everything
//      idle, the dust swept
//      and the caller tipped in wrapped SOL exactly as the spec's rule gives, emitting
//      WallPlaced;
//   9. sell into the wall: priced in two steps, the curve alone to the wall's top, then the
//      curve and the wall together, quoted, swapped and checked against the spec's
//      formulas like every trade;
//  10. read the books back: the price, the wall, the guard, the pool, retired and fee
//      ledgers, the cap, the decay credit, the trimmed, bought and tipped totals and the
//      counters equal the spec's formulas to the unit, and each vault holds exactly the sum
//      of its ledgers;
//  11. settle the retired tokens through the metadata's `settle` action: the reward share
//      of the part the cap's fall matched joins the rewards owed and the rest is burned, the
//      token's supply falling by exactly that, as the spec's formula gives, emitting
//      Settled;
//  12. hand both recipient roles to fresh wallets through the metadata's
//      `set_fee_recipient` and `set_rewards_recipient` actions, signed by the payer, the
//      demo market's recipient; then show a handover signed by the old recipient refused
//      with NotRecipient (simulated), and what each role is owed still waiting for it;
//  13. pay everything out through the metadata's `pay_rewards` and `sweep_fees` actions: the
//      rewards to the new rewards recipient and fee slot 0 to the new fee recipient, each
//      into an account the payout creates, which receives exactly what the role was owed;
//      slot 2 to SUITE_TREASURY; slot 1 refused with RecipientUnset while
//      DESIGNER_RECIPIENT is unset (simulated), its SOL waiting in the vault; and a second
//      `pay_rewards` refused with NothingOwed (simulated); then the ledgers, the lifetime
//      totals and both vaults read back against the spec;
//  14. on a local validator only, graduate a second token from the stand-in launchpad
//      (programs/tax-amm/scripts/launchpad.ts): it calls `pipeline_seed_liquidity`, built
//      from the metadata's `seed_liquidity` form with the SDK's `resolveInit`, and the same
//      transaction records the market with `register_existing_market` and both fee
//      accounts; exactly the seed leaves the escrows, `SeedResult.taken` says so with
//      `lp_amount` 0, the market state is open at the seeded PDA with the launchpad's PDA
//      as its seeder and the parameters sent, and the market trades both ways through the
//      router at the spec's prices, which are the worked example's;
//  15. run the release gate (programs/buy-wall-amm/gate) against this cluster: it downloads
//      every market of the program, the demo's among them, and replays each with the
//      program as built here and the cluster's own router, and must pass; then, when the
//      stranding test builds have been built (`cargo run -p buy-wall-gate -- test-builds`),
//      with the build that moves a field, which it must refuse, naming the markets and
//      steps that failed. Its pass records go to a scratch folder, never the repo's. On
//      devnet the gate runs before each deploy instead (scripts/deploy-devnet.sh), so the
//      step is skipped;
//  16. on devnet, ask Pipeline's hosted API for a quote each way and check it equals the
//      program's own quote on the same state (the market state unchanged in between).
//
// After every trade and keeper job the script reads the whole market state back and checks
// the price, the wall, the guard, every ledger, the cap and the counters against its own
// account of the market from the spec's formulas, and prints each transaction's signature.
//
// With --market it runs the trades and the keeper jobs again on a market an earlier run
// created, as after an upgrade: steps 4 to 6 load the market and wrap the SOL for the buys,
// the spec's account starts from the market state as read, step 7 buys and sells back (the
// buy lowering the cap and the sell trimmed, as in the first run), steps 8 to 11 and 13 run
// as before with the market's recipients as they are now, and step 12 (the handovers) and
// step 14 are skipped.
//
// On the pattern of the tax AMM's demo (programs/tax-amm/scripts/demo.ts). Deploy the
// program first; docs/toolchain.md says how, on a local validator and on devnet.
//
// Usage, from this directory after `pnpm install` (docs/toolchain.md, "Local demo run"):
//
//   node demo.ts --cluster <localnet|devnet|URL> \
//     --payer <keypair.json> --upgrade-authority <keypair.json> \
//     [--metadata-uri <URI>] [--program-id <address>] [--register-only]
//     [--metadata-not-yet-public] [--market <market state>] [--record <file>]
//
//   --cluster            localnet (http://127.0.0.1:8899), devnet, or an RPC URL of either;
//                        the cluster's genesis hash must be devnet's, or the URL a local
//                        validator's: devnet only until Pipeline is on mainnet
//   --payer              pays fees, creates the token and the market, and is its seeder
//   --upgrade-authority  the program's upgrade authority; signs register_strategy and pays
//                        its listing fee (docs/spec/README.md, "Upgrade authority")
//   --metadata-uri       where metadata.json is published (default: this repo's main branch)
//   --program-id         the strategy program (default: the address in declare_id!)
//   --register-only      steps 1 to 3 only: register the strategy, or point it at a new
//                        metadata URI, as each later deploy does
//   --metadata-not-yet-public
//                        on devnet, register or point the strategy at a metadata URI of this
//                        repo that cannot resolve yet because the repo is still private; the
//                        URI must be this repo's raw.githubusercontent.com address of this
//                        program's metadata.json, and the committed copy is checked instead
//                        (TAX-54)
//   --market             the market state of a market an earlier run created: trade it and
//                        run its keeper jobs again instead of creating one
//   --record             also write what the run did (addresses and signatures) to a file
//
// On devnet the metadata URI must resolve and pass Pipeline's validator with zero warnings
// before the script registers it or points the strategy at it, unless
// --metadata-not-yet-public says the repo is still private.
//
// On a local cluster the script airdrops the SOL both keys need; on devnet it never does
// (fund them with devnet-airdrop, docs/toolchain.md).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { buildActionInstruction, findAction } from 'strategy-actions';

import { findSeederPda, graduateInstruction, graduationFromLogs, LAUNCHPAD_PROGRAM_ADDRESS } from '../../tax-amm/scripts/launchpad.ts';
import {
    fetchMarketState,
    findMarketStatePda,
    findSolVaultPda,
    findTokenVaultPda,
    findVaultAuthorityPda,
    getMarketStateSize,
    identifyBuyWallAmmEvent,
    parseCapLoweredEvent,
    parseTrimmedEvent,
    parseWallPlacedEvent,
    parseSettledEvent,
    parseRewardsPaidEvent,
    parseFeesSweptEvent,
    parseRecipientChangedEvent,
    BuyWallAmmEvent,
    RecipientRole,
    BUY_WALL_AMM_ERROR__WALL_BELOW_THRESHOLD,
    BUY_WALL_AMM_ERROR__NOT_RECIPIENT,
    BUY_WALL_AMM_ERROR__NOTHING_OWED,
    BUY_WALL_AMM_ERROR__RECIPIENT_UNSET,
    DESIGNER_RECIPIENT,
    SUITE_TREASURY,
    DECAY_CREDIT_WINDOW,
    DESIGNER_SHARE_BPS,
    FLOOR_CRAWL_BPS,
    KEEPER_TIP_CAP,
    MARKET_STATE_DISCRIMINATOR,
    MIN_LIQUIDITY,
    REF_STEP_BPS,
    REF_STEP_WINDOW,
    SUITE_SHARE_BPS,
    WALL_THRESHOLD,
    type CapLoweredEvent,
    type MarketState,
    type TrimmedEvent,
    type WallPlacedEvent,
    type SettledEvent,
    type RewardsPaidEvent,
    type FeesSweptEvent,
    type RecipientChangedEvent,
} from './client/index.ts';

// Written by Pipeline's scripts/new-strategy.sh; the same address as `declare_id!`.
const DEFAULT_PROGRAM_ID = 'BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6';
const RAW_REPO = 'https://raw.githubusercontent.com/imDev2023/testing-pipeline';
const DEFAULT_METADATA_URI = `${RAW_REPO}/main/programs/buy-wall-amm/metadata.json`;
const WSOL = address('So11111111111111111111111111111111111111112');
// Pipeline's hosted API on devnet (Pipeline's docs/API.md).
const HOSTED_API = 'https://pipeline-devnet.up.railway.app';
// Pipeline's fee, which the router takes from the trader on top of a swap's input.
const PIPELINE_FEE_BPS = 25n;

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
    // Step 7's buy (and step 8's, if the wall needs more idle SOL), and the tokens and SOL
    // beyond the seed the payer keeps so that each trade can pay Pipeline's fee on top of its
    // input and step 9 can sell into the wall, this run and the later runs with --market,
    // each of which sells `wallSell` more into the wall than it buys.
    buy: 1_000_000_000n,
    spareTokens: 300_000_000_000n,
    spareLamports: 1_200_000_000n,
    // Step 9 sells what step 8 bought, if anything, and this many more units: as many as the
    // worked example sells into its wall.
    wallSell: 20_000_000_000n,
};

// The worked example's two trades, which the demo market must reproduce exactly
// (docs/spec/pool4-for-solana.md, "Worked example").
const WORKED = {
    buyOut: 90_081_892_629n,
    buySqrtPrice: 2_027_297_173_702_505_949n,
    sellOut: 980_099_999n,
    sellSqrtPrice: 1_844_674_407_372_029_099n,
};
// How many seconds after the seed the buy waits at least, so the cap decay credit it finds
// lowers the cap (each second of the demo market's cap decay is 2,314,814 token units).
const DECAY_WAIT_SECONDS = 3n;
// The most SOL the strategy's setup may spend on rent; the router returns the rest.
const MAX_CREATOR_LAMPORTS = 100_000_000n;
// The launch the stand-in launchpad graduates in step 14, on a local validator only: the demo
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
        'register-only': { type: 'boolean', default: false },
        'metadata-not-yet-public': { type: 'boolean', default: false },
        market: { type: 'string' },
        record: { type: 'string' },
    },
    strict: true,
});

function usage(message: string): never {
    console.error(`${message}\n`);
    console.error(
        'Usage: node demo.ts --cluster <localnet|devnet|URL> --payer <keypair.json> --upgrade-authority <keypair.json> [--metadata-uri <URI>] [--program-id <address>] [--register-only] [--metadata-not-yet-public] [--market <market state>] [--record <file>]',
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
// An earlier run's market, traded again (after an upgrade), or a new one.
const revisit = options.market === undefined ? null : address(options.market);
if (revisit && options['register-only']) usage('--market and --register-only do not go together');

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
 * The spec's pricing (docs/spec/pool4-for-solana.md, "A sell", "A buy" and "The fee"),
 * written out here from the spec rather than taken from the program, so the demo checks the
 * program against the spec: at most two steps, through the curve and the wall together at or
 * below the wall's top and through the curve alone above it. The demo's trades stay far
 * from the price bounds, so the model leaves them out: a trade the program refused at a
 * bound would fail the demo at its quote.
 */
const Q = 1n << 64n;
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;
const ceilBps = (amount: bigint, bps: bigint) => ceilDiv(amount * bps, 10_000n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

type Curve = { sqrtPrice: bigint; liquidity: bigint };
type Wall = { liquidity: bigint; top: bigint };
type Priced = { fee: bigint; out: bigint; sqrtPrice: bigint };
const NO_WALL: Wall = { liquidity: 0n, top: 0n };

function specBuy({ sqrtPrice, liquidity: l }: Curve, wall: Wall, a: bigint, feeBps: bigint): Priced {
    const fee = ceilBps(a, feeBps);
    let [rem, out, s] = [a - fee, 0n, sqrtPrice];
    if (wall.liquidity > 0n && s < wall.top) {
        // Through the curve and the wall toward the top: `need` lamports reach it.
        const liq = l + wall.liquidity;
        const need = ceilDiv(liq * (wall.top - s), Q);
        const next = rem >= need ? wall.top : s + (rem * Q) / liq;
        out += (liq * Q * (next - s)) / (next * s);
        rem -= rem >= need ? need : rem;
        s = next;
    }
    if (rem > 0n) {
        const next = s + (rem * Q) / l;
        out += (l * Q * (next - s)) / (next * s);
        s = next;
    }
    return { fee, out, sqrtPrice: s };
}

function specSell({ sqrtPrice, liquidity: l }: Curve, wall: Wall, a: bigint, feeBps: bigint): Priced {
    let [rem, gross, s] = [a, 0n, sqrtPrice];
    if (wall.liquidity > 0n && s > wall.top) {
        // Through the curve alone toward the top: `need` units reach it.
        const need = ceilDiv(l * Q * (s - wall.top), s * wall.top);
        const next = rem >= need ? wall.top : ceilDiv(l * Q * s, l * Q + rem * s);
        gross += (l * (s - next)) / Q;
        rem -= rem >= need ? need : rem;
        s = next;
    }
    if (rem > 0n) {
        const liq = l + wall.liquidity;
        const next = ceilDiv(liq * Q * s, liq * Q + rem * s);
        gross += (liq * (s - next)) / Q;
        s = next;
    }
    const fee = ceilBps(gross, feeBps);
    return { fee, out: gross - fee, sqrtPrice: s };
}

/** What the wall holds at `s`: `W × min(s, top) / Q` lamports, and the tokens it bought below its top. */
const wallSol = (wall: Wall, s: bigint) => (wall.liquidity * min(s, wall.top)) / Q;
const wallTokens = (wall: Wall, s: bigint) =>
    wall.liquidity > 0n && s < wall.top ? (wall.liquidity * Q * (wall.top - s)) / (wall.top * s) : 0n;

/**
 * The wall's guard (docs/spec/pool4-for-solana.md, "After pricing" steps 1, 3 and 4, and
 * "`place_wall`"), written out from the spec: at a slot's first update (before the books, in
 * a slot later than `lastSlot`), the reference moves toward the last close by at most
 * `REF_STEP_BPS / 2` of itself per `REF_STEP_WINDOW`, then the floor crawls toward the
 * reference by at most `FLOOR_CRAWL_BPS / 2` of itself a day and drops to the last close, the
 * price the slot opened at, if that is lower; in a slot already brought up to date neither
 * moves, and a swap's own price only becomes the last close and lowers the lowest close since
 * the last placement, which no swap raises (any swap takes its close while it is 0) and only
 * `place_wall` resets (`POOL4-50`). `place_wall` brings the floor up to date against the
 * stored reference without marking the slot. Each clock only moves forward.
 */
type Guard = {
    reference: bigint;
    refTime: bigint;
    floor: bigint;
    floorTime: bigint;
    lastSlot: bigint;
    lastClose: bigint;
    lowSincePlacement: bigint;
};

function specOpenFloor(g: Guard, now: bigint): Guard {
    let floor = g.floor;
    if (floor < g.reference) {
        const dt = min(max(now - g.floorTime, 0n), SECONDS_PER_DAY);
        floor = min(floor + (floor * FLOOR_CRAWL_BPS * dt) / (2n * 10_000n * SECONDS_PER_DAY), g.reference);
    }
    return { ...g, floor: min(floor, g.lastClose), floorTime: max(g.floorTime, now) };
}

function specFollow(g: Guard, slot: bigint, now: bigint): Guard {
    if (slot <= g.lastSlot) return g;
    const dt = min(max(now - g.refTime, 0n), REF_STEP_WINDOW);
    const step = (g.reference * REF_STEP_BPS * dt) / (2n * 10_000n * REF_STEP_WINDOW);
    const reference =
        g.lastClose >= g.reference ? min(g.reference + step, g.lastClose) : max(g.reference - step, g.lastClose);
    return specOpenFloor({ ...g, reference, refTime: max(g.refTime, now), lastSlot: slot }, now);
}

function specCloseAt(g: Guard, price: bigint): Guard {
    const lowSincePlacement = g.lowSincePlacement === 0n ? price : min(g.lowSincePlacement, price);
    return { ...g, lastClose: price, lowSincePlacement };
}

/**
 * `place_wall` (docs/spec/pool4-for-solana.md, "`place_wall`"), written out from the spec:
 * refused below `WALL_THRESHOLD`; the old wall closed at the price; the pool's dust beyond
 * the curve's holdings, rounded up, swept to idle SOL and the retired tokens; the tip; and
 * the new wall placed with everything left at `min(price, floor, lowSincePlacement)`, the
 * lowest close since the last placement capping nothing when it is 0, which is then reset to
 * the price (`POOL4-50`).
 */
type WallBooks = { wall: Wall; wallSolPlaced: bigint; poolTokens: bigint; poolSol: bigint; retiredTokens: bigint; idleSol: bigint };
type Placement = { converted: bigint; closedSol: bigint; closedTokens: bigint; dustSol: bigint; dustTokens: bigint; tip: bigint };

function specPlaceWall(
    b: WallBooks,
    curve: Curve,
    guard: Guard,
    feeBps: bigint,
): { books: WallBooks; placement: Placement; guard: Guard } | null {
    const s = curve.sqrtPrice;
    const converted = b.wall.liquidity > 0n ? max(b.wallSolPlaced - wallSol(b.wall, s), 0n) : 0n;
    if (b.idleSol < WALL_THRESHOLD && converted < WALL_THRESHOLD) return null;
    const [closedSol, closedTokens] = b.wall.liquidity > 0n ? [wallSol(b.wall, s), wallTokens(b.wall, s)] : [0n, 0n];
    const curveTokens = ceilDiv(curve.liquidity * Q, s);
    const curveSol = ceilDiv(curve.liquidity * s, Q);
    const dustTokens = b.poolTokens - closedTokens - curveTokens;
    const dustSol = b.poolSol - closedSol - curveSol;
    let idle = b.idleSol + closedSol + dustSol;
    const tip = min(min(KEEPER_TIP_CAP, (max(converted, b.idleSol) * feeBps) / 10_000n), idle);
    idle -= tip;
    const top = guard.lowSincePlacement === 0n ? min(s, guard.floor) : min(min(s, guard.floor), guard.lowSincePlacement);
    const wall = { liquidity: (idle * Q) / top, top };
    return {
        books: {
            wall,
            wallSolPlaced: wallSol(wall, top),
            poolTokens: curveTokens,
            poolSol: curveSol + idle,
            retiredTokens: b.retiredTokens + closedTokens + dustTokens,
            idleSol: 0n,
        },
        placement: { converted, closedSol, closedTokens, dustSol, dustTokens, tip },
        guard: { ...guard, lowSincePlacement: s },
    };
}

/**
 * The inventory cap's steps after a swap (docs/spec/pool4-for-solana.md, "After pricing"
 * steps 5 and 6), written out here from the spec rather than taken from the program: the
 * decay credit builds up to one day's allowance, then a curve holding less than the cap
 * lowers it (the ratchet) and one holding more gives up its excess (the trim). `now` is the
 * Clock's time the swap ran at, which the market state records as its `decay_time` (the
 * later of the two, so the clock never runs backwards).
 */
type Cap = { cap: bigint; decayCredit: bigint; decayTime: bigint; capFloor: bigint; capDecayPerDay: bigint };
type CapMoved =
    | { kind: 'nothing' }
    | { kind: 'lowered'; by: bigint; held: bigint }
    | { kind: 'trimmed'; liquidity: bigint; tokens: bigint; sol: bigint };
const SECONDS_PER_DAY = 86_400n;

function specCap(cap: Cap, curve: Curve, now: bigint): { cap: Cap; moved: CapMoved } {
    const elapsed = now > cap.decayTime ? now - cap.decayTime : 0n;
    const limit = cap.capDecayPerDay * DECAY_CREDIT_WINDOW;
    let credit = cap.decayCredit + cap.capDecayPerDay * elapsed;
    if (credit > limit) credit = limit;
    const next = { ...cap, decayCredit: credit, decayTime: now > cap.decayTime ? now : cap.decayTime };
    const { sqrtPrice: s, liquidity: l } = curve;
    const held = (l * Q) / s;
    if (held < cap.cap) {
        const allowance = credit / SECONDS_PER_DAY;
        const decayed = cap.cap > allowance ? cap.cap - allowance : 0n;
        const lowered = [held, decayed, cap.capFloor].reduce((a, b) => (a > b ? a : b));
        const by = cap.cap - lowered;
        next.cap = lowered;
        next.decayCredit = credit - by * SECONDS_PER_DAY;
        return { cap: next, moved: by > 0n ? { kind: 'lowered', by, held } : { kind: 'nothing' } };
    }
    if (held > cap.cap) {
        const atCap = (cap.cap * s) / Q;
        const newL = atCap > MIN_LIQUIDITY ? atCap : MIN_LIQUIDITY;
        if (newL < l) {
            const tokens = held - ceilDiv(newL * Q, s);
            const sol = (l * s) / Q - ceilDiv(newL * s, Q);
            return {
                cap: next,
                moved: { kind: 'trimmed', liquidity: newL, tokens: tokens > 0n ? tokens : 0n, sol: sol > 0n ? sol : 0n },
            };
        }
    }
    return { cap: next, moved: { kind: 'nothing' } };
}

/** The buy wall AMM's events in a confirmed transaction's logs. */
async function strategyEvents(signature: Signature) {
    // An RPC node can answer null for a transaction it has confirmed but not indexed yet.
    let transaction = null;
    for (let i = 0; transaction === null; i++) {
        transaction = await rpc
            .getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 })
            .send();
        if (transaction === null) {
            if (i > 60) fail(`the RPC node has no transaction ${signature} 30 s after it confirmed`);
            await sleep(500);
        }
    }
    const lowered: CapLoweredEvent[] = [];
    const trimmed: TrimmedEvent[] = [];
    const placed: WallPlacedEvent[] = [];
    const settled: SettledEvent[] = [];
    const rewardsPaid: RewardsPaidEvent[] = [];
    const feesSwept: FeesSweptEvent[] = [];
    const recipientChanged: RecipientChangedEvent[] = [];
    for (const line of transaction.meta?.logMessages ?? []) {
        if (!line.startsWith('Program data: ')) continue;
        const data = new Uint8Array(Buffer.from(line.slice('Program data: '.length), 'base64'));
        let kind: BuyWallAmmEvent;
        try {
            kind = identifyBuyWallAmmEvent(data);
        } catch {
            continue; // the router's own events
        }
        if (kind === BuyWallAmmEvent.CapLowered) lowered.push(parseCapLoweredEvent(data));
        if (kind === BuyWallAmmEvent.Trimmed) trimmed.push(parseTrimmedEvent(data));
        if (kind === BuyWallAmmEvent.WallPlaced) placed.push(parseWallPlacedEvent(data));
        if (kind === BuyWallAmmEvent.Settled) settled.push(parseSettledEvent(data));
        if (kind === BuyWallAmmEvent.RewardsPaid) rewardsPaid.push(parseRewardsPaidEvent(data));
        if (kind === BuyWallAmmEvent.FeesSwept) feesSwept.push(parseFeesSweptEvent(data));
        if (kind === BuyWallAmmEvent.RecipientChanged) recipientChanged.push(parseRecipientChangedEvent(data));
    }
    // The slot it ran in, which the wall's guard reads.
    return { lowered, trimmed, placed, settled, rewardsPaid, feesSwept, recipientChanged, slot: BigInt(transaction.slot) };
}

/**
 * Simulates `instructions` signed by `feePayer` and stops unless the strategy refuses them
 * with error `code` (`name` for messages): how anyone can see a keeper job or a handover is
 * not allowed, without paying for a failed transaction.
 */
async function expectRefused(label: string, feePayer: KeyPairSigner, instructions: Instruction[], code: number, name: string) {
    const { signed } = await sign(feePayer, instructions, []);
    const { value: simulated } = await rpc
        .simulateTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', commitment: 'confirmed' })
        .send();
    // The RPC's custom error code, which Kit decodes as a bigint.
    const custom = (simulated.err as { InstructionError?: [unknown, { Custom?: number | bigint }] } | null)?.InstructionError?.[1]?.Custom;
    if (custom === undefined || Number(custom) !== code) {
        fail(`${label}: expected ${name}, got ${JSON.stringify(simulated.err, (_, v) => (typeof v === 'bigint' ? `${v}` : v))}`);
    }
    record.push([label, `refused (${name})`]);
}

/** Waits until the cluster's clock reads at least `time`, in Unix seconds. */
async function waitForClock(time: bigint) {
    for (let i = 0; ; i++) {
        const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
        const blockTime = await rpc.getBlockTime(slot).send().catch(() => null);
        if (blockTime !== null && BigInt(blockTime) >= time) return;
        if (i > 120) fail(`the cluster's clock did not reach ${time} within 60 s`);
        await sleep(500);
    }
}

/** Waits until the cluster's confirmed slot is later than `slot`. */
async function waitForSlotAfter(slot: bigint) {
    for (let i = 0; ; i++) {
        if ((await rpc.getSlot({ commitment: 'confirmed' }).send()) > slot) return;
        if (i > 120) fail(`the cluster did not pass slot ${slot} within 60 s`);
        await sleep(500);
    }
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
 * Steps 11 to 13: `settle`, both recipients' handovers (on a fresh market), then `pay_rewards`
 * and every `sweep_fees` slot, each built from its metadata action as Aviary's generic forms
 * would, checked against the spec's formulas, its event and the balances it moved, and the
 * whole market state read back after each.
 */
async function payOut(
    payer: KeyPairSigner,
    metadata: pipeline.StrategyMetadata,
    view: pipeline.MarketView,
    token: Address,
    books: Books,
    params: { rewardShareBps: bigint },
    fresh: boolean,
) {
    const actionNamed = (name: string) => findAction(metadata, name) ?? fail(`metadata.json has no ${name} action`);
    const build = (name: string, args: Record<string, pipeline.ArgValue> = {}, inputs: Record<string, Address> = {}) =>
        buildActionInstruction({ action: actionNamed(name), market: view, wallet: payer.address, args, inputs });
    const marketState = view.marketState;
    const state = async () => (await fetchMarketState(rpc, marketState, { commitment: 'confirmed' })).data;
    const supply = async () => BigInt((await rpc.getTokenSupply(token, { commitment: 'confirmed' }).send()).value.amount);
    const balanceOf = async (account: Address) => ((await accountData(account)) === null ? 0n : tokenBalance(account));
    const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? `${v}` : v));

    step('11. Settling the retired tokens');
    const retired = books.retiredTokens;
    if (retired === 0n) fail('nothing is retired to settle');
    // POOL4-49: the reward share is paid only on the part the cap's fall matched.
    const rewardable = books.retiredRewardable;
    const toRewards = (rewardable * params.rewardShareBps) / 10_000n;
    const burned = retired - toRewards;
    const [supplyBefore, vaultBefore] = [await supply(), await tokenBalance(view.vaults[0]!)];
    const { signature: settledSignature } = await send('settle', payer, [await build('settle')]);
    const { settled } = await strategyEvents(settledSignature);
    const supplyFell = supplyBefore - (await supply());
    const vaultFell = vaultBefore - (await tokenBalance(view.vaults[0]!));
    books.rewardsOwed += toRewards;
    books.tokensBurned += burned;
    books.retiredTokens = 0n;
    books.retiredRewardable = 0n;
    const [event] = settled;
    if (
        settled.length !== 1 ||
        event!.retired !== retired ||
        event!.rewardable !== rewardable ||
        event!.burned !== burned ||
        event!.toRewards !== toRewards ||
        event!.rewardsOwed !== books.rewardsOwed ||
        event!.tokensBurned !== books.tokensBurned ||
        supplyFell !== burned ||
        vaultFell !== burned
    ) {
        fail(`settle of ${retired}: expected ${burned} burned and ${toRewards} to the rewards; the supply fell ${supplyFell}, the vault ${vaultFell}, events ${json(settled)}`);
    }
    info(`${retired} retired units, ${rewardable} of them matched by the cap's fall: ${toRewards} (the ${params.rewardShareBps} basis point reward share of those) now owed as rewards, ${burned} burned; the token's supply fell by exactly ${burned}; Settled emitted`);
    record.push(['settle', `${burned} burned, ${toRewards} to the rewards`]);
    await checkBooks('settle', view, books);

    step('12. Handing both recipient roles to new wallets');
    let feeRecipient: Address;
    let rewardsRecipient: Address;
    if (fresh) {
        const [newFee, newRewards] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
        for (const [name, role, wallet] of [
            ['set_fee_recipient', RecipientRole.Fee, newFee.address],
            ['set_rewards_recipient', RecipientRole.Rewards, newRewards.address],
        ] as const) {
            const { signature } = await send(name, payer, [await build(name, { new: wallet })]);
            const { recipientChanged } = await strategyEvents(signature);
            const [changed] = recipientChanged;
            if (recipientChanged.length !== 1 || changed!.role !== role || changed!.old !== payer.address || changed!.new !== wallet) {
                fail(`${name}: expected RecipientChanged from ${payer.address} to ${wallet}, got ${json(recipientChanged)}`);
            }
        }
        const handed = await state();
        if (handed.feeRecipient !== newFee.address || handed.rewardsRecipient !== newRewards.address) {
            fail(`the market's recipients are ${handed.feeRecipient} and ${handed.rewardsRecipient}, not the new wallets`);
        }
        await checkBooks('the handovers', view, books);
        await expectRefused(
            'set_fee_recipient by the old recipient',
            payer,
            [await build('set_fee_recipient', { new: payer.address })],
            BUY_WALL_AMM_ERROR__NOT_RECIPIENT,
            'NotRecipient',
        );
        info(`fee recipient ${newFee.address} and rewards recipient ${newRewards.address}, each handed over by the payer, RecipientChanged emitted; the old recipient can no longer hand the role on (NotRecipient); ${books.rewardsOwed} rewards and ${books.feesRecipient} lamports of fees still owed to the roles`);
        record.push(['fee recipient', newFee.address], ['rewards recipient', newRewards.address]);
        [feeRecipient, rewardsRecipient] = [newFee.address, newRewards.address];
    } else {
        const now = await state();
        [feeRecipient, rewardsRecipient] = [now.feeRecipient, now.rewardsRecipient];
        info(`skipped: the market's recipients stay ${feeRecipient} (fees) and ${rewardsRecipient} (rewards)`);
    }

    step('13. Paying out the rewards and the fees');
    // The rewards, on a fresh market into an account the payout creates for the new recipient.
    const [rewardsAccount] = await findAssociatedTokenPda({ owner: rewardsRecipient, mint: token, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const rewardsHeld = await balanceOf(rewardsAccount);
    if (fresh && (await accountData(rewardsAccount)) !== null) fail('the new rewards recipient already has a token account');
    const owed = books.rewardsOwed;
    if (owed === 0n) fail('no rewards are owed to pay');
    const { signature: paidSignature } = await send('pay_rewards', payer, [await build('pay_rewards', {}, { rewards_recipient: rewardsRecipient })]);
    const { rewardsPaid: paidEvents } = await strategyEvents(paidSignature);
    const received = (await tokenBalance(rewardsAccount)) - rewardsHeld;
    books.rewardsPaid += owed;
    books.rewardsOwed = 0n;
    const [paid] = paidEvents;
    if (
        received !== owed ||
        paidEvents.length !== 1 ||
        paid!.amount !== owed ||
        paid!.recipient !== rewardsRecipient ||
        paid!.tokenAccount !== rewardsAccount ||
        paid!.rewardsPaid !== books.rewardsPaid
    ) {
        fail(`pay_rewards: expected ${owed} paid into ${rewardsAccount}; it received ${received}, events ${json(paidEvents)}`);
    }
    info(`${received} units of the token paid to the rewards recipient${fresh ? ', into the account the payout created' : ''}; RewardsPaid emitted`);
    record.push(['pay_rewards', `${received} units`]);
    await checkBooks('pay_rewards', view, books);
    await expectRefused(
        'pay_rewards with nothing owed',
        payer,
        [await build('pay_rewards', {}, { rewards_recipient: rewardsRecipient })],
        BUY_WALL_AMM_ERROR__NOTHING_OWED,
        'NothingOwed',
    );

    // The fees, slot by slot: each into its wallet's wrapped SOL account.
    const designerUnset = DESIGNER_RECIPIENT === address('11111111111111111111111111111111');
    for (const [slot, wallet, ledger] of [
        [0, feeRecipient, 'feesRecipient'],
        [1, DESIGNER_RECIPIENT, 'feesDesigner'],
        [2, SUITE_TREASURY, 'feesSuite'],
    ] as const) {
        const slotOwed = books[ledger];
        const sweep = await build('sweep_fees', { slot }, { recipient: wallet });
        if (slot === 1 && designerUnset) {
            await expectRefused('sweep_fees slot 1', payer, [sweep], BUY_WALL_AMM_ERROR__RECIPIENT_UNSET, 'RecipientUnset');
            info(`slot 1, the designer share: refused with RecipientUnset while DESIGNER_RECIPIENT is unset; its ${slotOwed} lamports wait in the vault`);
            continue;
        }
        const account = await walletTokenAccount(wallet, WSOL);
        const heldBefore = await balanceOf(account);
        const created = heldBefore === 0n && (await accountData(account)) === null;
        const { signature } = await send(`sweep_fees slot ${slot}`, payer, [sweep]);
        const { feesSwept } = await strategyEvents(signature);
        const gained = (await tokenBalance(account)) - heldBefore;
        const [swept] = feesSwept;
        if (gained !== slotOwed || feesSwept.length !== 1 || swept!.slot !== slot || swept!.amount !== slotOwed || swept!.recipient !== wallet || swept!.tokenAccount !== account) {
            fail(`sweep_fees slot ${slot}: expected ${slotOwed} lamports to ${wallet}; it gained ${gained}, events ${json(feesSwept)}`);
        }
        books[ledger] = 0n;
        info(`slot ${slot}: ${slotOwed} lamports of wrapped SOL to ${wallet}${created ? ', into an account the payout created' : ''}; FeesSwept emitted`);
        record.push([`sweep_fees slot ${slot}`, `${slotOwed} lamports`]);
        await checkBooks(`sweep_fees slot ${slot}`, view, books);
    }
    await checkBooks('the payouts', view, books, true);
    info('the payouts moved only the ledgers they pay, never the price or the counters');
    record.push(['market state after the payouts', "equal to the spec's formulas"]);
}

/**
 * Step 14, on a local validator: the stand-in launchpad graduates a new token into a buy wall
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
    // The escrows are the launchpad's for this creator, so an earlier run on the same cluster
    // can have left something in them: what the graduation takes is measured from here.
    const escrowed = await Promise.all(escrows.map((escrow) => tokenBalance(escrow!)));
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
        .find((units) => units !== undefined) ?? fail('the graduation logged no compute line for the strategy');
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
        const spec =
            input === 1 ? specBuy(curve, NO_WALL, amount, BigInt(DEMO.feeBps)) : specSell(curve, NO_WALL, amount, BigInt(DEMO.feeBps));
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

/** What steps 4 to 6 give the rest of the demo: the market and how to reach it. */
type OpenedMarket = {
    token: Address;
    view: pipeline.MarketView;
    recorded: pipeline.MarketView;
    vaultAuthority: Address;
};

/**
 * Steps 4 to 6 for a new market: a fresh test token, the market created from the metadata's
 * `init` form with both fee accounts and the seed in one transaction, then read back.
 */
async function createMarket(
    payer: KeyPairSigner,
    programId: Address,
    metadata: pipeline.StrategyMetadata,
    seedAction: NonNullable<ReturnType<typeof findAction>>,
    tokenPrograms: Address[],
): Promise<OpenedMarket> {
    step('4. Creating a test token and wrapping the SOL for the seed and the buy');
    const token = await createTestToken(payer, DEMO.decimals, DEMO.tokens + DEMO.spareTokens);
    await wrapSol(payer, DEMO.lamports + DEMO.buy + DEMO.spareLamports);

    step("5. Creating the market from the metadata's init form, with its fee accounts and the seed, in one transaction");
    // `init` says how to create a market: the market state is a fresh keypair, which signs.
    const marketStateKey = await generateKeyPairSigner();
    const { instruction: createMarket, resolved } = await pipeline.buildCreateMarketFromMetadata({
        init: metadata.init!,
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
    const seed = await buildActionInstruction({
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
    return { token, view, recorded, vaultAuthority };
}

/**
 * Steps 4 to 6 for a market an earlier run created (--market): the market state read and
 * checked, the router's record of it, and the SOL for the buys wrapped.
 */
async function loadMarket(payer: KeyPairSigner, marketState: Address, tokenPrograms: Address[]): Promise<OpenedMarket> {
    step('4. Loading the market an earlier run created, and wrapping the SOL for the buys');
    const raw = (await accountData(marketState)) ?? fail(`no account at ${marketState}`);
    const { data: state } = await fetchMarketState(rpc, marketState, { commitment: 'confirmed' });
    const discriminator = new TextDecoder().decode(state.discriminator as Uint8Array);
    if (raw.length !== getMarketStateSize() || discriminator !== new TextDecoder().decode(MARKET_STATE_DISCRIMINATOR as Uint8Array)) {
        fail(`${marketState} is not a buy wall market state (${raw.length} bytes, "${discriminator}")`);
    }
    if (state.status !== STATUS_OPEN) fail(`the market is not open (status ${state.status})`);
    const token = state.tokenMint;
    info(`market state ${marketState}: layout ${state.layoutVersion}, open, token ${token}`);
    await wrapSol(payer, DEMO.buy + DEMO.spareLamports);

    step('5. Skipped: the market exists');

    step('6. Reading the market back');
    const market = state.marketSigner;
    const marketAccount = pipeline.decodeMarket((await accountData(market)) ?? new Uint8Array());
    if (!marketAccount) fail(`the router has no market at ${market}`);
    const recorded = pipeline.marketViewFromMarket(market, marketAccount, tokenPrograms);
    if (
        recorded.marketState !== marketState ||
        recorded.mints.join() !== [token, WSOL].join() ||
        recorded.vaults.join() !== [state.tokenVault, state.solVault].join() ||
        recorded.supportsExactOut
    ) {
        fail(`the router's market ${market} records another market state, other mints or vaults, or exact-out`);
    }
    const [vaultAuthority] = await findVaultAuthorityPda({ marketState });
    info(`router: market ${explorer('address', market)}, token at index 0, wrapped SOL at index 1, supports_exact_out = false`);
    info(`sqrt_price ${le(state.sqrtPrice)}, liquidity ${le(state.liquidity)}, cap ${le(state.cap)}, ${le(state.swapCount)} swaps so far`);
    record.push(['market', market], ['market state', marketState]);
    return { token, view: recorded, recorded, vaultAuthority };
}

/**
 * The spec's own account of a market: everything the market state holds that a step of the
 * demo changes, which the demo brings up to date by the spec's formulas after each step.
 */
type Books = ReturnType<typeof booksFromState>;

function booksFromState(state: MarketState) {
    return {
        curve: { sqrtPrice: le(state.sqrtPrice), liquidity: le(state.liquidity) } as Curve,
        wall: { liquidity: le(state.wallLiquidity), top: le(state.wallTop) } as Wall,
        wallSolPlaced: le(state.wallSolPlaced),
        poolTokens: le(state.poolTokens),
        poolSol: le(state.poolSol),
        idleSol: le(state.idleSol),
        feesRecipient: le(state.feesRecipient),
        feesDesigner: le(state.feesDesigner),
        feesSuite: le(state.feesSuite),
        retiredTokens: le(state.retiredTokens),
        // The reward share's ledgers (POOL4-49): the cap's fall no trim has matched yet, and
        // the part of the retired tokens that earns the reward share.
        capFallUnmatched: le(state.capFallUnmatched),
        retiredRewardable: le(state.retiredRewardable),
        rewardsOwed: le(state.rewardsOwed),
        cap: {
            cap: le(state.cap),
            decayCredit: le(state.decayCredit),
            decayTime: le(state.decayTime),
            capFloor: le(state.capFloor),
            capDecayPerDay: le(state.capDecayPerDay),
        } as Cap,
        guard: {
            reference: le(state.reference),
            refTime: le(state.refTime),
            floor: le(state.floor),
            floorTime: le(state.floorTime),
            lastSlot: le(state.lastSlot),
            lastClose: le(state.lastClose),
            lowSincePlacement: le(state.lowSincePlacement),
        } as Guard,
        tokensTrimmed: le(state.tokensTrimmed),
        solTrimmed: le(state.solTrimmed),
        wallTokensBought: le(state.wallTokensBought),
        tipsPaid: le(state.tipsPaid),
        tokensBurned: le(state.tokensBurned),
        rewardsPaid: le(state.rewardsPaid),
        volume: [le(state.volume[0]!), le(state.volume[1]!)],
        feesCollected: le(state.feesCollected),
        swapCount: le(state.swapCount),
    };
}

/** Every field of `Books`, flattened, for comparing and printing. */
function flatBooks(books: Books): [string, bigint][] {
    const out: [string, bigint][] = [];
    for (const [key, value] of Object.entries(books)) {
        if (typeof value === 'bigint') out.push([key, value]);
        else if (Array.isArray(value)) value.forEach((v, i) => out.push([`${key}${i}`, v as bigint]));
        else for (const [inner, v] of Object.entries(value as Record<string, bigint>)) out.push([`${key}.${inner}`, v]);
    }
    return out;
}

/**
 * Reads the whole market state back after `label` and stops unless every field equals the
 * spec's account of it, and each vault holds exactly the sum of its ledgers; with `print`,
 * lists every field.
 */
async function checkBooks(label: string, view: pipeline.MarketView, books: Books, print = false) {
    const { data } = await fetchMarketState(rpc, view.marketState, { commitment: 'confirmed' });
    const read = new Map(flatBooks(booksFromState(data)));
    for (const [key, wanted] of flatBooks(books)) {
        const got = read.get(key);
        if (got !== wanted) fail(`after ${label} the market state's ${key} is ${got}, but the spec's formulas give ${wanted}`);
        if (print) info(`${key.padEnd(24)} ${got}`);
    }
    const [vaultTokens, vaultSol] = await Promise.all(view.vaults.map((vault) => tokenBalance(vault!)));
    const tokenLedgers = books.poolTokens + books.retiredTokens + books.rewardsOwed;
    const solLedgers = books.poolSol + books.idleSol + books.feesRecipient + books.feesDesigner + books.feesSuite;
    if (vaultTokens !== tokenLedgers || vaultSol !== solLedgers) {
        fail(`after ${label} the vaults hold ${vaultTokens} and ${vaultSol}, not their ledgers' ${tokenLedgers} and ${solLedgers}`);
    }
    info(`after ${label}: the price, the wall, the guard, every ledger, the cap and the counters equal the spec's formulas; each vault holds exactly its ledgers`);
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
    if (published.ok && published.warnings.length === 0) {
        info(`${metadataUri} is valid with zero warnings`);
    } else if (onDevnet && options['metadata-not-yet-public'] && !published.ok) {
        // The router only stores the URI; it resolves once the repo is public (TAX-54).
        if (!metadataUri.startsWith(`${RAW_REPO}/`) || !metadataUri.endsWith('/programs/buy-wall-amm/metadata.json')) {
            fail(`--metadata-not-yet-public takes only this repo's programs/buy-wall-amm/metadata.json on ${RAW_REPO}, not ${metadataUri}`);
        }
        // Only a URI that cannot be fetched; one that resolves with warnings still stops below.
        info(`${metadataUri} does not resolve yet (${published.reason}); registering it anyway with --metadata-not-yet-public`);
        info('the committed metadata.json was checked instead; desks show the strategy without metadata until the repo is public');
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
    const seedAction = findAction(metadata, 'seed');
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

    if (options['register-only']) {
        info('--register-only: no market is created');
        finish();
        return;
    }

    const tokenPrograms = [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS];
    const opened = revisit ? await loadMarket(payer, revisit, tokenPrograms) : await createMarket(payer, programId, metadata, seedAction, tokenPrograms);
    const { token, view, recorded, vaultAuthority } = opened;
    const marketState = view.marketState;
    const { data: state } = await fetchMarketState(rpc, marketState, { commitment: 'confirmed' });
    // The market's own parameters, which a fresh market must hold exactly as sent.
    const params = {
        feeBps: le(state.feeBps),
        wallSplitBps: le(state.wallSplitBps),
        rewardShareBps: le(state.rewardShareBps),
    };
    if (!revisit) {
        const sent: Record<string, [bigint, number]> = {
            feeBps: [params.feeBps, DEMO.feeBps],
            wallSplitBps: [params.wallSplitBps, DEMO.wallSplitBps],
            rewardShareBps: [params.rewardShareBps, DEMO.rewardShareBps],
            capFloorBps: [le(state.capFloorBps), DEMO.capFloorBps],
            capDecayBps: [le(state.capDecayBps), DEMO.capDecayBps],
        };
        for (const [key, [got, wanted]] of Object.entries(sent)) {
            if (got !== BigInt(wanted)) fail(`the market state's ${key} is ${got}, not the ${wanted} sent`);
        }
        if (state.feeRecipient !== payer.address || state.rewardsRecipient !== payer.address) fail('the market state records other recipients than the payer');
        info('the market state holds every creation parameter as sent');
    }

    step('7. Trading both ways through the router');
    // The spec's own account of the market: from the market state as read, then from what each
    // step does by the spec's formulas.
    const feeBps = params.feeBps;
    const books = booksFromState(state);
    if (!revisit) {
        // A fresh market holds only the seed: nothing traded, retired, owed or placed yet.
        const zero = Object.entries(books).filter(([key, value]) => typeof value === 'bigint' && !['poolTokens', 'poolSol'].includes(key) && value !== 0n);
        if (zero.length > 0) fail(`a fresh market's ${zero.map(([key]) => key).join(', ')} are not 0`);
        const sqrtPrice = books.curve.sqrtPrice;
        if (
            books.guard.reference !== sqrtPrice ||
            books.guard.floor !== sqrtPrice ||
            books.guard.lastClose !== sqrtPrice ||
            books.guard.lowSincePlacement !== sqrtPrice
        ) {
            fail('the seed did not start the wall\'s guard at the opening price');
        }
    }
    await checkBooks(revisit ? 'the market as found' : 'the market as seeded', view, books);
    const payerAccounts = await Promise.all([token, WSOL].map((mint) => walletTokenAccount(payer.address, mint)));

    /**
     * One trade through the router, as a terminal would make it: resolved, quoted and
     * swapped with the SDK, the quote checked against the spec's pricing and the trader paid
     * exactly the quote; then the books, the guard and the cap brought up to date by the
     * spec's formulas, and the swap's events checked against them. Returns what it paid,
     * the spec's price, and what the cap's step did.
     */
    async function trade(label: string, input: 0 | 1, amount: bigint, worked?: bigint) {
        const output = input === 1 ? 0 : 1;
        const request = {
            mode: pipeline.TradeMode.ExactIn,
            inputIndex: input,
            outputIndex: output,
            amount,
            trader: payer.address,
            extra: new Uint8Array(),
        };
        // At the commitment the demo confirms at, so the quote sees the swap before it.
        const simulation = { commitment: 'confirmed' } as const;
        const strategyAccounts = await pipeline.resolveAccounts(rpc, recorded, request, payer.address, simulation);
        const listed = strategyAccounts.map((account) => account.address).join();
        if (listed !== [view.vaults[output], vaultAuthority].join()) {
            fail(`${label}: account resolution listed ${listed}, not the output vault and the vault authority`);
        }
        const { quote, unitsConsumed } = await pipeline.quoteStrategy(
            rpc,
            recorded,
            request,
            strategyAccounts,
            payer.address,
            simulation,
        );
        const spec =
            input === 1 ? specBuy(books.curve, books.wall, amount, feeBps) : specSell(books.curve, books.wall, amount, feeBps);
        if (quote.amountIn !== amount || quote.amountOut !== spec.out || (worked !== undefined && spec.out !== worked)) {
            fail(`${label} of ${amount}: quoted ${quote.amountOut} for ${quote.amountIn}; the spec's formulas give ${spec.out}${worked === undefined ? '' : `, the worked example ${worked}`}`);
        }
        const crossing = books.wall.liquidity > 0n && (books.curve.sqrtPrice > books.wall.top) !== (spec.sqrtPrice > books.wall.top);
        info(`${label} of ${amount}: quoted ${quote.amountOut}, the spec's price${worked === undefined ? '' : " and the worked example's"}${crossing ? ', in two steps across the wall\'s top' : ''}, fee ${spec.fee} lamports (${unitsConsumed} CU)`);
        const before = await tokenBalance(payerAccounts[output]!);
        const { signature } = await send(`${label} through the router`, payer, [
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
        if (received !== quote.amountOut) fail(`${label}: received ${received}, quoted ${quote.amountOut}`);
        info(`${label}: received exactly the quote`);
        record.push([label, `${amount} in, ${received} out`]);

        // "After pricing", in its order. The market state records the time the swap ran as
        // its decay_time, and the transaction its slot: the only values the demo takes from
        // the program here.
        const { data: afterSwap } = await fetchMarketState(rpc, marketState, { commitment: 'confirmed' });
        const ranAt = le(afterSwap.decayTime);
        const events = await strategyEvents(signature);
        // Steps 1 and 4 at the slot's first update, the reference and the floor; steps 2 and
        // 3, the books, the price, the last close and the lowest close since the placement.
        books.guard = specFollow(books.guard, events.slot, ranAt);
        const split = specSplit(spec.fee, params.wallSplitBps);
        if (input === 1) {
            books.poolSol += amount - spec.fee;
            books.poolTokens -= spec.out;
        } else {
            books.poolTokens += amount;
            books.poolSol -= spec.out + spec.fee;
        }
        books.curve = { sqrtPrice: spec.sqrtPrice, liquidity: books.curve.liquidity };
        books.guard = specCloseAt(books.guard, spec.sqrtPrice);
        books.idleSol += split.wall;
        books.feesRecipient += split.recipient;
        books.feesDesigner += split.designer;
        books.feesSuite += split.suite;
        books.volume[input]! += amount;
        books.volume[output]! += spec.out;
        books.feesCollected += spec.fee;
        books.swapCount += 1n;

        // Steps 5 and 6, the cap.
        const { cap: nextCap, moved } = specCap(books.cap, books.curve, ranAt);
        books.cap = nextCap;
        if (moved.kind === 'trimmed') {
            books.curve = { sqrtPrice: spec.sqrtPrice, liquidity: moved.liquidity };
            books.poolTokens -= moved.tokens;
            books.retiredTokens += moved.tokens;
            const matched = moved.tokens < books.capFallUnmatched ? moved.tokens : books.capFallUnmatched;
            books.capFallUnmatched -= matched;
            books.retiredRewardable += matched;
            books.poolSol -= moved.sol;
            books.idleSol += moved.sol;
            books.tokensTrimmed += moved.tokens;
            books.solTrimmed += moved.sol;
        }
        if (moved.kind === 'lowered') {
            // Never more than one day's allowance, as the program keeps it (review finding
            // R2-01): what a fall adds beyond that is never rewarded.
            const unmatched = books.capFallUnmatched + moved.by;
            books.capFallUnmatched = unmatched < books.cap.capDecayPerDay ? unmatched : books.cap.capDecayPerDay;
            const [event] = events.lowered;
            if (
                events.lowered.length !== 1 ||
                events.trimmed.length !== 0 ||
                event!.cap !== books.cap.cap ||
                event!.loweredBy !== moved.by ||
                event!.held !== moved.held ||
                event!.decayCredit !== books.cap.decayCredit
            ) {
                fail(`${label}: expected one CapLowered event (cap ${books.cap.cap}, by ${moved.by}), got ${JSON.stringify(events, (_, v) => (typeof v === 'bigint' ? `${v}` : v))}`);
            }
            info(`${label}: the cap fell by ${moved.by} to ${books.cap.cap}, as the spec's ratchet gives for the credit built up; CapLowered emitted`);
            record.push([`${label}: cap lowered`, `by ${moved.by} to ${books.cap.cap}`]);
        } else if (moved.kind === 'trimmed') {
            const [event] = events.trimmed;
            if (
                events.trimmed.length !== 1 ||
                events.lowered.length !== 0 ||
                event!.tokens !== moved.tokens ||
                event!.sol !== moved.sol ||
                event!.liquidity !== moved.liquidity ||
                event!.cap !== books.cap.cap
            ) {
                fail(`${label}: expected one Trimmed event (${moved.tokens} units, ${moved.sol} lamports), got ${JSON.stringify(events, (_, v) => (typeof v === 'bigint' ? `${v}` : v))}`);
            }
            info(`${label}: trimmed ${moved.tokens} units to the retired tokens and ${moved.sol} lamports to idle SOL, liquidity now ${moved.liquidity}, the price unchanged; Trimmed emitted`);
            record.push([`${label}: trimmed`, `${moved.tokens} units, ${moved.sol} lamports`]);
        } else if (events.lowered.length + events.trimmed.length !== 0) {
            fail(`${label}: the cap did not move, but the swap emitted ${events.lowered.length + events.trimmed.length} cap events`);
        }
        await checkBooks(label, view, books);
        return { received, spec, moved, crossing };
    }

    // A buy that finds no decay credit leaves the cap alone, and its sell-back then finds the
    // curve within the cap; waiting a few seconds lets the demo show both of the cap's steps.
    await waitForClock(books.cap.decayTime + DECAY_WAIT_SECONDS);
    info(`waited until ${DECAY_WAIT_SECONDS} seconds after the last swap or the seed, so the buy finds cap decay credit`);
    // A fresh market is the worked example, whose two trades the demo reproduces exactly.
    const bought = await trade('buy', 1, DEMO.buy, revisit ? undefined : WORKED.buyOut);
    if (!revisit && bought.spec.sqrtPrice !== WORKED.buySqrtPrice) fail(`buy: the spec's formulas move the price to ${bought.spec.sqrtPrice}, not ${WORKED.buySqrtPrice}`);
    if (bought.moved.kind !== 'lowered') fail(`buy: the spec's formulas give "${bought.moved.kind}" for the cap, not "lowered"`);
    const sold = await trade('sell', 0, bought.received, revisit ? undefined : WORKED.sellOut);
    if (!revisit && sold.spec.sqrtPrice !== WORKED.sellSqrtPrice) fail(`sell: the spec's formulas move the price to ${sold.spec.sqrtPrice}, not ${WORKED.sellSqrtPrice}`);
    if (sold.moved.kind !== 'trimmed') fail(`sell: the spec's formulas give "${sold.moved.kind}" for the cap, not "trimmed"`);
    info(`the guard: reference ${books.guard.reference}, floor ${books.guard.floor}, as the spec's steps give for these trades`);

    step('8. Placing the buy wall');
    const placeWallAction = findAction(metadata, 'place_wall') ?? fail('metadata.json has no place_wall action');
    const placeWall = async () =>
        buildActionInstruction({ action: placeWallAction, market: view, wallet: payer.address, args: {} });
    const wallBooks = (): WallBooks => ({
        wall: books.wall,
        wallSolPlaced: books.wallSolPlaced,
        poolTokens: books.poolTokens,
        poolSol: books.poolSol,
        retiredTokens: books.retiredTokens,
        idleSol: books.idleSol,
    });
    let topUp = 0n;
    if (specPlaceWall(wallBooks(), books.curve, books.guard, feeBps) === null) {
        // Below WALL_THRESHOLD, `place_wall` is refused; anyone may simulate it to see so, in
        // a slot after the last swap, since in that slot it is refused first for the swap
        // (`POOL4-50`).
        await waitForSlotAfter(books.guard.lastSlot);
        await expectRefused('place_wall below the threshold', payer, [await placeWall()], BUY_WALL_AMM_ERROR__WALL_BELOW_THRESHOLD, 'WallBelowThreshold');
        info(`place_wall with ${books.idleSol} lamports idle, below WALL_THRESHOLD (${WALL_THRESHOLD}): refused with WallBelowThreshold, as the spec says`);
        // One more buy's fee takes idle SOL past the threshold.
        topUp = (await trade('buy for the wall', 1, DEMO.buy)).received;
    }
    if (specPlaceWall(wallBooks(), books.curve, books.guard, feeBps) === null) fail(`idle SOL ${books.idleSol} is still below WALL_THRESHOLD`);
    // `place_wall` is refused in a slot a swap already ran in (`POOL4-50`), so it goes in a
    // later slot than the last swap, as the keeper runner sends it.
    await waitForSlotAfter(books.guard.lastSlot);
    const tipsBefore = await tokenBalance(payerAccounts[1]!);
    const { signature: placedSignature } = await send('place_wall', payer, [await placeWall()]);
    const tip = (await tokenBalance(payerAccounts[1]!)) - tipsBefore;
    const placedEvents = await strategyEvents(placedSignature);
    if (placedEvents.slot <= books.guard.lastSlot) fail(`place_wall ran in slot ${placedEvents.slot}, not after the last swap's ${books.guard.lastSlot}`);
    // It brings the floor up to date for its slot first, at the time it ran, which it records
    // as the floor's clock (the clock never moves backwards, so that is its time or later).
    const { data: afterPlacing } = await fetchMarketState(rpc, marketState, { commitment: 'confirmed' });
    books.guard = specOpenFloor(books.guard, le(afterPlacing.floorTime));
    const expectedPlacement = specPlaceWall(wallBooks(), books.curve, books.guard, feeBps) ?? fail(`idle SOL ${books.idleSol} is still below WALL_THRESHOLD`);
    const { books: placedBooks, placement, guard: placedGuard } = expectedPlacement;
    const work = max(placement.converted, books.idleSol);
    const [placedEvent] = placedEvents.placed;
    if (
        placedEvents.placed.length !== 1 ||
        tip !== placement.tip ||
        placedEvent!.tip !== placement.tip ||
        placedEvent!.converted !== placement.converted ||
        placedEvent!.closedSol !== placement.closedSol ||
        placedEvent!.closedTokens !== placement.closedTokens ||
        placedEvent!.dustSol !== placement.dustSol ||
        placedEvent!.dustTokens !== placement.dustTokens ||
        placedEvent!.wallTop !== placedBooks.wall.top ||
        placedEvent!.wallLiquidity !== placedBooks.wall.liquidity ||
        placedEvent!.wallSolPlaced !== placedBooks.wallSolPlaced ||
        placedEvent!.caller !== payer.address ||
        placedEvent!.tipAccount !== payerAccounts[1]
    ) {
        fail(`place_wall: expected tip ${placement.tip} and a wall of ${placedBooks.wall.liquidity} at ${placedBooks.wall.top}; received ${tip}, events ${JSON.stringify(placedEvents.placed, (_, v) => (typeof v === 'bigint' ? `${v}` : v))}`);
    }
    Object.assign(books, placedBooks);
    books.tipsPaid += placement.tip;
    books.wallTokensBought += placement.closedTokens;
    if (books.wall.top > books.guard.floor || books.wall.top > books.curve.sqrtPrice) fail('the wall was placed above its floor or the price');
    const lowAtPlacement = books.guard.lowSincePlacement;
    if (lowAtPlacement !== 0n && books.wall.top > lowAtPlacement) {
        fail(`the wall was placed at ${books.wall.top}, above the lowest close since the last placement ${lowAtPlacement}`);
    }
    // The low is reset to the price at placement.
    books.guard = placedGuard;
    info(`tipped ${tip} lamports of wrapped SOL to the caller's account: the least of KEEPER_TIP_CAP (${KEEPER_TIP_CAP}) and the fee earned on ${work} lamports of work`);
    info(`the wall: ${books.wallSolPlaced} lamports at sqrt_price ${books.wall.top} (liquidity ${books.wall.liquidity}), at the lowest of the price, the floor and the lowest close since the last placement (${lowAtPlacement}); ${placement.dustTokens} units and ${placement.dustSol} lamports of dust swept; WallPlaced emitted`);
    record.push(['place_wall', `tip ${tip}, wall ${books.wallSolPlaced} lamports at ${books.wall.top}`]);
    await checkBooks('place_wall', view, books);

    step('9. Selling into the wall');
    const top = books.wall.top;
    // It sells what step 8 bought, if anything, and as much again as the worked example sells
    // into its wall, from the stock of tokens the first run kept (`DEMO.spareTokens`), with
    // Pipeline's fee on top (PIPELINE_FEE_BPS, rounded up).
    const intoWallAmount = topUp + DEMO.wallSell;
    const held = await tokenBalance(payerAccounts[0]!);
    if (held < intoWallAmount + ceilBps(intoWallAmount, PIPELINE_FEE_BPS)) {
        fail(`the payer holds ${held} units of the token, too few to sell ${intoWallAmount} into the wall with Pipeline's fee on top`);
    }
    const intoWall = await trade('sell into the wall', 0, intoWallAmount);
    if (intoWall.spec.sqrtPrice >= top) fail(`the sell left the price at ${intoWall.spec.sqrtPrice}, not below the wall's top ${top}`);
    const spent = books.wallSolPlaced - wallSol(books.wall, books.curve.sqrtPrice);
    const boughtByWall = wallTokens(books.wall, books.curve.sqrtPrice);
    info(`the wall has spent ${spent} lamports on ${boughtByWall} units, as the spec's formulas give`);
    record.push(['the wall bought', `${boughtByWall} units for ${spent} lamports`]);

    step("10. Reading the books back against the spec's formulas");
    await checkBooks('trading', view, books, true);
    record.push(['market state after trading', "equal to the spec's formulas"]);

    await payOut(payer, metadata, view, token, books, params, revisit === null);

    step('14. Graduating a token from a launchpad into a buy wall market');
    if (revisit) {
        info('skipped: only a new run graduates a token');
    } else if (cluster.local) {
        await graduateFromLaunchpad(payer, programId, metadata);
    } else {
        info('skipped: the stand-in launchpad is a test program, never deployed to devnet');
    }

    step('15. The release gate on this cluster');
    if (cluster.local) {
        runReleaseGate();
    } else {
        info('skipped: on devnet the gate runs before each deploy (scripts/deploy-devnet.sh, programs/buy-wall-amm/scripts/pre-deploy.sh)');
    }

    step("16. Pipeline's hosted API quoting the market");
    if (onDevnet) {
        await compareHostedQuotes(payer, recorded, view, vaultAuthority);
    } else {
        info("skipped: Pipeline's hosted API reads devnet only");
    }

    finish();
}

/** Prints what the run did and, with --record, writes it to a file. */
function finish() {
    step(`Done on ${cluster.url}`);
    const width = Math.max(...record.map(([label]) => label.length));
    for (const [label, value] of record) info(`${label.padEnd(width)}  ${value}`);
    if (options.record) {
        const run = { cluster: cluster.local ? cluster.url : 'devnet', at: new Date().toISOString(), record: Object.fromEntries(record.map(([label, value], i) => [`${String(i).padStart(2, '0')} ${label}`, value])) };
        writeFileSync(options.record, `${JSON.stringify(run, null, 2)}\n`);
        info(`written to ${options.record}`);
    }
}

/**
 * Step 16: Pipeline's hosted devnet API quotes the market both ways, and each quote equals
 * the program's own, simulated through the router on the same state: the market state and both
 * vaults read the same before and after, or the comparison runs again.
 */
async function compareHostedQuotes(payer: KeyPairSigner, recorded: pipeline.MarketView, view: pipeline.MarketView, vaultAuthority: Address) {
    const snapshot = async () =>
        JSON.stringify(await Promise.all([view.marketState, ...view.vaults].map(async (account) => Buffer.from((await accountData(account!)) ?? []).toString('base64'))));
    const { data: state } = await fetchMarketState(rpc, view.marketState, { commitment: 'confirmed' });
    // A hundredth of the curve's SOL, then of its tokens.
    for (const [label, input, amount] of [['buy', 1, le(state.poolSol) / 100n], ['sell', 0, le(state.poolTokens) / 100n]] as const) {
        const output = input === 1 ? 0 : 1;
        for (let attempt = 0; ; attempt++) {
            const before = await snapshot();
            const hosted = await hostedQuote(view, input, output, amount);
            const request = { mode: pipeline.TradeMode.ExactIn, inputIndex: input, outputIndex: output, amount, trader: payer.address, extra: new Uint8Array() };
            const simulation = { commitment: 'confirmed' } as const;
            const accounts = await pipeline.resolveAccounts(rpc, recorded, request, payer.address, simulation);
            const { quote } = await pipeline.quoteStrategy(rpc, recorded, request, accounts, payer.address, simulation);
            if ((await snapshot()) !== before) {
                if (attempt >= 5) fail('the market kept changing while its quotes were compared');
                info('the market changed while its quotes were compared; again');
                continue;
            }
            const listed = hosted.strategyAccounts.join();
            if (listed !== [view.vaults[output], vaultAuthority].join()) fail(`the hosted API resolved ${listed} for the ${label}, not the output vault and the vault authority`);
            if (hosted.amountOut !== quote.amountOut) {
                // The hosted API reads the cluster through its own RPC, which can trail ours by a
                // few slots after the demo's last write; it must catch up within the retries.
                if (attempt >= 5) fail(`${label} of ${amount}: the hosted API quoted ${hosted.amountOut} at slot ${hosted.slot}, the program ${quote.amountOut}, on the same state`);
                info(`the hosted API quoted ${hosted.amountOut} at slot ${hosted.slot}, not yet the program's ${quote.amountOut}; again`);
                await sleep(3_000);
                continue;
            }
            info(`${label} of ${amount}: the hosted API quoted ${hosted.amountOut} at slot ${hosted.slot}, exactly the program's quote on the same state`);
            record.push([`hosted API quote, ${label}`, `${amount} in, ${hosted.amountOut} out, equal to the program's`]);
            break;
        }
    }
}

/** A quote from Pipeline's hosted devnet API (its docs/API.md, "Quotes"), retried while it is busy. */
async function hostedQuote(view: pipeline.MarketView, input: 0 | 1, output: 0 | 1, amount: bigint) {
    const url = `${HOSTED_API}/v1/quote?market=${view.market}&input_mint=${view.mints[input]}&output_mint=${view.mints[output]}&amount=${amount}&mode=exact_in`;
    for (let attempt = 0; ; attempt++) {
        const response = await fetch(url, { headers: { 'user-agent': 'testing-pipeline-demo' } });
        if (response.ok) {
            const body = (await response.json()) as { amount_in: string; amount_out: string; slot: number; strategy_accounts: { address: string }[] };
            if (BigInt(body.amount_in) !== amount) fail(`the hosted API quoted ${body.amount_in} in, not ${amount}`);
            return { amountOut: BigInt(body.amount_out), slot: body.slot, strategyAccounts: body.strategy_accounts.map((account) => account.address) };
        }
        if (attempt >= 5 || (response.status !== 429 && response.status < 500)) fail(`the hosted API answered HTTP ${response.status}: ${await response.text()}`);
        await sleep(2_000 * (attempt + 1));
    }
}

// The release gate (docs/spec/pool4-for-solana.md, "A release gate"), run as its command
// is: against this cluster, with the build in programs/target/deploy it must pass, and with
// the stranding test build that moves a field, when built, it must refuse.
function runReleaseGate() {
    const programs = fileURLToPath(new URL('../../', import.meta.url));
    const records = mkdtempSync(join(tmpdir(), 'buy-wall-gate-records-'));
    const gate = (candidate: string) => {
        const run = spawnSync(
            'cargo',
            ['run', '--quiet', '-p', 'buy-wall-gate', '--', 'run', '--cluster', cluster.url, '--candidate', candidate, '--records', records],
            { cwd: programs, encoding: 'utf8' },
        );
        if (run.error) fail(`could not run the release gate: ${run.error.message}`);
        for (const line of run.stdout.trimEnd().split('\n')) info(line);
        if (run.status === 2) fail(`the release gate could not run: ${run.stderr.trim()}`);
        return { passed: run.status === 0, output: run.stdout };
    };
    const built = join(programs, 'target/deploy/buy_wall_amm.so');
    const unchanged = gate(built);
    if (!unchanged.passed) fail('the release gate refused the program as built here');
    record.push(['release gate, this build', 'passed on every market']);
    const moved = join(programs, 'target/gate-test-builds/moved-field/buy_wall_amm.so');
    if (!existsSync(moved)) {
        info('the moved-field test build is not built (cargo run -p buy-wall-gate -- test-builds); skipped');
        return;
    }
    const refused = gate(moved);
    if (refused.passed || !refused.output.includes('REFUSED')) fail('the release gate passed the build that moves a field');
    record.push(['release gate, moved-field build', 'refused']);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
