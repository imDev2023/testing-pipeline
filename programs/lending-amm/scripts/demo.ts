// The lending AMM's demo: lists the strategy on a Pipeline router, creates a WSOL-lent market
// and makes its first deposit in one transaction, trades it both ways through the router, adds
// liquidity again, lends the surplus to Kamino and sells beyond the buffer, step by step,
// building every transaction from metadata.json with Pipeline's TypeScript SDK, as Aviary will,
// and reading the market back with the generated client (client/):
//
//   1. check the program is deployed and the upgrade-authority key is its upgrade authority,
//      and that Kamino Lend runs with the reserve the market lends to: at the address the
//      devnet lending market's file names, in klend's layout, decoded by this script at the
//      spec's offsets (kamino.ts);
//   2. check metadata.json, and the published copy at the metadata URI;
//   3. register the strategy, signed and paid for by the upgrade authority (once), or point
//      it at a new metadata URI;
//   4. create a test token and wrap SOL for the LP and trader;
//   5. compute, before sending anything, the addresses the creation will use: the router's
//      market and fee accounts, and the lending AMM's market state, vaults, cToken account,
//      LP mint, vault authority and the LP's shares account;
//   6. create the market from the metadata's `init` form, with a fee account for each mint
//      and the first deposit from the metadata's `add_liquidity` action, in one transaction;
//   7. check every address computed in step 5 exists as what it should be, and that the
//      market state's reserves and share count are the script's own calculation from the
//      spec's formulas;
//   8. buy the test token with WSOL and sell it back through the router, each quote and swap
//      reading the Kamino reserve (account resolution lists it, read-only), each swap's
//      output equal to its quote, and both equal to the script's calculation with the lent
//      side valued at L = B + V, V being the market's cTokens at the reserve's stored rate as
//      this script decodes it; the reserves equal the script's calculation, to the unit;
//   9. check a swap built without the reserve is refused;
//  10. add liquidity again at the market's ratio, with the shares and the amounts taken
//      equal to the script's calculation;
//  11. call `rebalance`, built from the metadata's action as a keeper builds it: the buffer
//      holds the whole lent side, above its band, so the market lends the surplus to the
//      WSOL reserve by klend's own deposit; the cTokens klend minted, the liquidity it took and
//      the market state all equal the script's calculation from the spec's rule and klend's
//      deposit maths, the market's cToken account holds the cTokens, the buffer is back at its
//      target, and quotes taken just before and just after agree within Kamino's rounding;
//  12. check a second `rebalance` is refused with `WithinBand`, in simulation;
//  13. trade both ways through the router again, now pricing the cTokens at the reserve's
//      stored rate, each swap equal to its quote and to the script's calculation;
//  14. check a sale paying out more WSOL than the buffer holds, built from the accounts
//      resolved for a smaller sale, is refused with `RedeemAccountsMissing`, in simulation;
//  15. make that sale with its own accounts, which list the reserve writable and klend's
//      redeem accounts: the trader receives exactly the quote, the script's calculation, and
//      the swap redeems the shortfall from Kamino inside the swap, its redeem event carrying
//      the shortfall `out - B`, the market's cTokens falling by `ceil(s x S_ctoken / S_total)`
//      at the stored rate as this script decodes it, and anything klend paid above the
//      shortfall staying in the buffer;
//  16. call `rebalance` again: the buffer, drained below its band by the sale, is redeemed back
//      to its target within klend's rounding.
//
// Grown from Pipeline's strategy template
// (scripts/deploy-devnet.ts at 5ad130d). Deploy the program first; docs/toolchain.md says how,
// on a local validator and on devnet.
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
//   --payer              pays fees, creates the token, is the LP and the trader
//   --upgrade-authority  the program's upgrade authority; signs register_strategy and pays
//                        its listing fee (docs/spec/README.md, "Upgrade authority")
//   --metadata-uri       where metadata.json is published (default: this repo's main branch)
//   --program-id         the strategy program (default: the address in declare_id!)
//
// On a local cluster the script airdrops the SOL both keys need; on devnet it never does
// (fund them with devnet-airdrop, docs/toolchain.md). The lending AMM's devnet build lends
// to our own Kamino lending market, whose addresses come from deployments/kamino-devnet.json;
// a local validator runs devnet's klend with that lending market's accounts cloned from devnet
// (programs/lending-amm/scripts/fetch-klend.sh and fetch-accounts.sh, docs/toolchain.md).

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
    getAddressEncoder,
    getBase64EncodedWireTransaction,
    getProgramDerivedAddress,
    getSignatureFromTransaction,
    lamports,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    type AccountMeta,
    type Address,
    type Instruction,
    type KeyPairSigner,
    type ReadonlyUint8Array,
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
    fetchLendingAmmMarket,
    findAuthorityPda,
    findCtokenAccountPda,
    findLpMintPda,
    findLpSharesPda,
    findVault0Pda,
    findVault1Pda,
    getShortfallRedeemedEventDecoder,
    SHORTFALL_REDEEMED_EVENT_DISCRIMINATOR,
} from './client/index.ts';
import { decodeReserve, klendDeposit, lentValue, rate, type ReserveView } from './kamino.ts';

// Written by Pipeline's scripts/new-strategy.sh; the same address as `declare_id!`.
const DEFAULT_PROGRAM_ID = 'Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG';
const DEFAULT_METADATA_URI =
    'https://raw.githubusercontent.com/imDev2023/testing-pipeline/main/programs/lending-amm/metadata.json';
// The native mint of SPL Token, WSOL, the lent mint of the demo market.
const WSOL = address('So11111111111111111111111111111111111111112');

// The program's constants the formulas need, read from its IDL, which the program's config
// module generates; never restated here (docs/spec/lending-pool.md, "Constants").
const IDL = JSON.parse(readFileSync(new URL('../idl/lending_amm.json', import.meta.url), 'utf8')) as {
    constants?: { name: string; value: string }[];
};
function idlConstant(name: string): bigint {
    const value = IDL.constants?.find((constant) => constant.name === name)?.value;
    if (value === undefined) fail(`the IDL has no constant ${name}; rebuild it with \`pnpm idl\``);
    return BigInt(value.replaceAll('_', ''));
}

// The demo market: the demo's own choices, in one place, not the program's policy values.
// The other side is a fresh test token with 6 decimals; WSOL is lent.
const DEMO = {
    lpFeeBps: 30,
    tokenDecimals: 6,
    tokenMinted: 10_000_000_000_000n,
    // What the payer wraps into WSOL for the deposits and the trades.
    wrapLamports: 6_000_000_000n,
    firstDeposit: { token: 2_000_000_000_000n, wsol: 4_000_000_000n },
    buyWithLamports: 250_000_000n,
    sellTokens: 30_000_000_000n,
    secondDeposit: { token: 500_000_000_000n, wsol: 2_000_000_000n },
} as const;
// The most SOL the strategy's setup may spend on rent; the router returns the rest.
const MAX_CREATOR_LAMPORTS = 100_000_000n;
// What a local run airdrops when a key holds less.
const LOCAL_FUNDING = { payer: 20_000_000_000n, upgradeAuthority: 1_000_000_000n };

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
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' }).send();
    await waitFor(label, signature);
    info(`${label}: ${explorer('tx', signature)}`);
    record.push([label, signature]);
    return signature;
}

/** Simulates a transaction at `confirmed`, returning its error and logs; nothing is sent. */
async function simulate(feePayer: KeyPairSigner, instructions: Instruction[]) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const { value } = await rpc
        .simulateTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', commitment: 'confirmed' })
        .send();
    return { err: value.err, logs: value.logs ?? [] };
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

async function accountInfo(account: Address) {
    const { value } = await rpc.getAccountInfo(account, { encoding: 'base64', commitment: 'confirmed' }).send();
    return value && { owner: value.owner, data: new Uint8Array(Buffer.from(value.data[0], 'base64')) };
}

async function accountData(account: Address): Promise<Uint8Array | null> {
    return (await accountInfo(account))?.data ?? null;
}

/** A token account's balance, or 0 when it does not exist. */
async function tokenBalance(account: Address): Promise<bigint> {
    const data = await accountData(account);
    return data ? new DataView(data.buffer, data.byteOffset).getBigUint64(64, true) : 0n;
}

/** A mint's supply. */
async function mintSupply(mint: Address): Promise<bigint> {
    const data = (await accountData(mint)) ?? fail(`no mint at ${mint}`);
    return new DataView(data.buffer, data.byteOffset).getBigUint64(36, true);
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

/** Wraps `amount` lamports into the wallet's WSOL account. */
async function wrapSol(wallet: KeyPairSigner, amount: bigint) {
    const account = await walletTokenAccount(wallet.address, WSOL);
    await send('wrap SOL', wallet, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: wallet, owner: wallet.address, mint: WSOL }),
        getTransferSolInstruction({ source: wallet, destination: account, amount }),
        getSyncNativeInstruction({ account }),
    ]);
    info(`wrapped ${Number(amount) / 1e9} SOL into ${account}`);
}

// The spec's formulas, computed here on their own (docs/spec/lending-pool.md, "Pricing",
// "Shares" and "Adding").
const BPS = 10_000n;
function ceilDiv(n: bigint, d: bigint) {
    return (n + d - 1n) / d;
}
function isqrt(n: bigint) {
    if (n < 2n) return n;
    let x = n;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
    }
    return x;
}
/** `a_net = a - ceil(a x fee / 10,000)`, `out = floor(E_o x a_net / (E_i + a_net))`. */
function exactIn(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeBps: bigint) {
    const net = amountIn - ceilDiv(amountIn * feeBps, BPS);
    return (reserveOut * net) / (reserveIn + net);
}
/** A later deposit: the smaller share count, and what those shares are worth, rounded up. */
function laterDeposit(max: [bigint, bigint], reserves: [bigint, bigint], shareCount: bigint) {
    const byOther = (max[0] * shareCount) / reserves[0];
    const byLent = (max[1] * shareCount) / reserves[1];
    const shares = byOther < byLent ? byOther : byLent;
    return {
        shares,
        taken: [ceilDiv(shares * reserves[0], shareCount), ceilDiv(shares * reserves[1], shareCount)] as [bigint, bigint],
    };
}

/** Kamino's devnet lending market, which the devnet build lends to. */
type KaminoDevnet = {
    klendProgram: string;
    lendingMarket: { address: string };
    reserves: { wsol: { address: string; collateralMint: string; liquiditySupply: string } };
};
const KAMINO = JSON.parse(
    readFileSync(new URL('../../../deployments/kamino-devnet.json', import.meta.url), 'utf8'),
) as KaminoDevnet;

/** The WSOL reserve of our devnet lending market, which the demo market lends to. */
const RESERVE = address(KAMINO.reserves.wsol.address);
/** Kamino Lend, the same address on every cluster. */
const KLEND = address(KAMINO.klendProgram);

/**
 * Reads the reserve and decodes it at the spec's offsets, stopping unless it is the reserve
 * the demo market lends to: owned by klend, in klend's layout, naming our lending market, WSOL
 * and the cToken mint deployments/kamino-devnet.json lists.
 */
async function readReserve(): Promise<ReserveView> {
    const found = await accountInfo(RESERVE);
    if (!found) fail(`the Kamino reserve ${RESERVE} does not exist on ${cluster.url}${cluster.local ? ': run programs/lending-amm/scripts/fetch-accounts.sh, then restart the validator' : ''}`);
    if (found.owner !== KLEND) fail(`the Kamino reserve ${RESERVE} is owned by ${found.owner}, not Kamino Lend`);
    const view = decodeReserve(found.data);
    if (typeof view === 'string') fail(`the Kamino reserve ${RESERVE}: ${view}`);
    if (
        view.lendingMarket !== KAMINO.lendingMarket.address ||
        view.liquidityMint !== WSOL ||
        view.collateralMint !== KAMINO.reserves.wsol.collateralMint
    ) {
        fail(`the Kamino reserve ${RESERVE} names another lending market or mints`);
    }
    return view;
}

/** The instructions sysvar, which klend's redeem introspects. */
const INSTRUCTIONS_SYSVAR = address('Sysvar1nstructions1111111111111111111111111');

/** klend's lending market authority, the PDA `["lma", lending_market]`. */
async function lendingMarketAuthority(): Promise<Address> {
    const [authority] = await getProgramDerivedAddress({
        programAddress: KLEND,
        seeds: [new TextEncoder().encode('lma'), getAddressEncoder().encode(address(KAMINO.lendingMarket.address))],
    });
    return authority;
}

/** The data of every event with `discriminator` that transaction `signature` logged, without it. */
async function strategyEvents(signature: Signature, discriminator: ReadonlyUint8Array): Promise<Uint8Array[]> {
    const transaction = await rpc
        .getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 })
        .send();
    const logs = transaction?.meta?.logMessages ?? fail(`no logs for ${signature}`);
    return logs
        .filter((line) => line.startsWith('Program data: '))
        .map((line) => new Uint8Array(Buffer.from(line.slice('Program data: '.length), 'base64')))
        .filter((data) => discriminator.every((byte, i) => data[i] === byte));
}

const show = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

async function main() {
    const payer = await loadKey(payerPath);
    const upgradeAuthority = await loadKey(upgradeAuthorityPath);
    const programId = address(options['program-id']);
    const minimumLiquidity = idlConstant('MINIMUM_LIQUIDITY');
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
    const klend = (await rpc.getAccountInfo(KLEND, { encoding: 'base64', commitment: 'confirmed' }).send()).value;
    if (!klend?.executable) {
        fail(`Kamino Lend is not deployed at ${KLEND}${cluster.local ? ': start the validator after programs/lending-amm/scripts/fetch-klend.sh (docs/toolchain.md)' : ''}`);
    }
    info(`Kamino Lend is deployed at ${KLEND}`);
    const reserveView = await readReserve();
    const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
    info(
        `reserve ${RESERVE}: lending market ${reserveView.lendingMarket}, WSOL, cToken mint ${reserveView.collateralMint}; S_total ${reserveView.totalSupplySf >> 60n} (60-bit fixed point), S_ctoken ${reserveView.mintTotalSupply}, stored rate ${rate(reserveView)}, last refreshed ${slot - reserveView.lastUpdateSlot} slots ago`,
    );
    record.push(['Kamino reserve', `${RESERVE}, stored rate ${rate(reserveView)}`]);

    step('2. Checking metadata');
    const local = pipeline.parseStrategyMetadata(
        JSON.parse(readFileSync(new URL('../metadata.json', import.meta.url), 'utf8')),
    );
    if (!local.ok) fail(`metadata.json is invalid:\n   ${local.errors.join('\n   ')}`);
    if (local.warnings.length > 0) fail(`metadata.json must pass with zero warnings:\n   ${local.warnings.join('\n   ')}`);
    info(`metadata.json is valid with zero warnings: "${local.value.name}"`);
    const published = await pipeline.fetchStrategyMetadata(metadataUri);
    if (published.ok) {
        info(`${metadataUri} is valid`);
    } else {
        info(`warning: ${metadataUri} can't be used yet (${published.reason}: ${published.errors.join('; ')})`);
        info('desks will show the strategy without metadata until it can be fetched');
    }
    const metadata = local.value;
    const init = metadata.init ?? fail('metadata.json needs `init` for this demo');
    const addLiquidity =
        metadata.actions?.find((action) => action.name === 'add_liquidity') ?? fail('metadata.json needs the add_liquidity action');
    const rebalanceAction =
        metadata.actions?.find((action) => action.name === 'rebalance') ?? fail('metadata.json needs the rebalance action');

    step('3. Registering the strategy');
    const config = pipeline.decodeConfig((await accountData(await pipeline.configPda())) ?? new Uint8Array());
    if (!config) fail('the Pipeline router has no config on this cluster');
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
            [await pipeline.updateMetadata({ registrar: upgradeAuthority.address, strategyProgram: programId, metadataUri })],
            [upgradeAuthority],
        );
    } else {
        info('already registered with this metadata URI');
    }

    step('4. Creating a test token and wrapping SOL');
    const token = await createTestToken(payer, 'test token', DEMO.tokenDecimals, DEMO.tokenMinted);
    await wrapSol(payer, DEMO.wrapLamports);
    // The init form takes the other mint first and the lent mint second, so mint 0 is the
    // token and mint 1 is WSOL, which makes lent_index 1.
    const mints = [token, WSOL] as const;
    const tokenPrograms = Object.fromEntries(mints.map((mint) => [mint, TOKEN_PROGRAM_ADDRESS]));
    const holdings = await Promise.all(mints.map((mint) => walletTokenAccount(payer.address, mint)));

    step('5. Computing the addresses the creation will use, before sending it');
    const collateralMint = address(KAMINO.reserves.wsol.collateralMint);
    const { instruction: createMarket, resolved } = await pipeline.buildCreateMarketFromMetadata({
        init,
        strategyProgram: programId,
        creator: payer.address,
        args: { lent_index: 1, lp_fee_bps: DEMO.lpFeeBps },
        inputs: { other_mint: token, lent_mint: WSOL, collateral_mint: collateralMint },
        tokenPrograms,
        maxCreatorLamports: MAX_CREATOR_LAMPORTS,
        rpc,
    });
    if (resolved.marketStateSigns) fail('a lending AMM market state is a PDA, which signs nothing');
    const marketState = resolved.marketState;
    const market = await pipeline.marketPda(programId, marketState);
    if (resolved.market !== market) fail('the SDK resolved a different market');
    const pdas = { programAddress: programId };
    const [authority] = await findAuthorityPda({ marketState }, pdas);
    const [vault0] = await findVault0Pda({ marketState, mint0: token }, pdas);
    const [vault1] = await findVault1Pda({ marketState, mint1: WSOL }, pdas);
    const [ctokenAccount] = await findCtokenAccountPda({ marketState }, pdas);
    const [lpMint] = await findLpMintPda({ marketState }, pdas);
    const [lpShares] = await findLpSharesPda({ marketState, lp: payer.address }, pdas);
    const vaults = [vault0, vault1];
    const initAccount = (name: string) => {
        const index = init.accounts?.findIndex((account) => account.name === name) ?? -1;
        return resolved.strategyAccounts[index]?.address ?? fail(`metadata init has no account "${name}"`);
    };
    const expected: [string, Address][] = [
        ['authority', authority],
        ['vault_0', vault0],
        ['vault_1', vault1],
        ['ctoken_account', ctokenAccount],
        ['lp_mint', lpMint],
    ];
    for (const [name, account] of expected) {
        if (initAccount(name) !== account) fail(`the metadata's init account ${name} is not the program's PDA ${account}`);
    }
    const feeAccounts = await Promise.all(mints.map((mint) => pipeline.feeAccountPda(market, mint, TOKEN_PROGRAM_ADDRESS)));
    const computed: [string, Address][] = [
        ['router market', market],
        ['fee account, token', feeAccounts[0]!],
        ['fee account, WSOL', feeAccounts[1]!],
        ['market state', marketState],
        ['vault, token', vault0],
        ['vault, WSOL (buffer)', vault1],
        ['cToken account', ctokenAccount],
        ['LP mint', lpMint],
        ['LP shares account', lpShares],
        // The vault authority only signs, so it never holds an account.
        ['vault authority', authority],
    ];
    for (const [label, account] of computed) {
        if (await accountData(account)) fail(`the ${label} ${account} exists before the creation`);
        info(`${label.padEnd(21)} ${account}`);
    }
    // A desk builds add_liquidity from the metadata once it knows the market's mints and
    // vaults, which are known here before the market exists.
    const view: pipeline.MarketView = {
        market,
        strategyProgram: programId,
        marketState,
        mints,
        vaults,
        tokenPrograms: [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS],
        supportsExactOut: false,
    };
    const deposit = (max: { token: bigint; wsol: bigint }, minLp: bigint) =>
        pipeline.buildActionInstruction({
            action: addLiquidity,
            market: view,
            wallet: payer.address,
            args: { max_0: max.token, max_1: max.wsol, min_lp: minLp },
            inputs: { reserve: RESERVE },
            tokenPrograms,
        });

    step("6. Creating the market from the metadata's init form, with its fee accounts and first deposit");
    const first = DEMO.firstDeposit;
    const firstShares = isqrt(first.token * first.wsol) - minimumLiquidity;
    const initFeeAccounts = await Promise.all(
        mints.map((mint) => pipeline.initFeeAccount({ payer: payer.address, market, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS })),
    );
    await send('create_market + init_fee_account x2 + add_liquidity', payer, [
        createMarket,
        ...initFeeAccounts,
        await deposit(first, firstShares),
    ]);
    info(`market ${explorer('address', market)}`);
    record.push(['market', market], ['market state', marketState]);

    step('7. Checking what exists, and the market state against the formulas');
    const routerMarket = pipeline.decodeMarket((await accountData(market)) ?? new Uint8Array());
    if (!routerMarket) fail(`the router has no market at ${market}`);
    const routerView = pipeline.marketViewFromMarket(market, routerMarket, [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS]);
    if (routerView.mints.join() !== mints.join() || routerView.vaults.join() !== vaults.join()) {
        fail(`the router recorded mints ${routerView.mints.join(', ')} and vaults ${routerView.vaults.join(', ')}`);
    }
    if (routerView.supportsExactOut) fail('the router recorded exact-out support');
    info("router market: the mints in the creator's order, the vaults computed in step 5, exact-in only");
    const tokenAccounts: [string, Address, Address, Address][] = [
        ['fee account, token', feeAccounts[0]!, token, (await pipeline.feeAuthorityPda(market))],
        ['fee account, WSOL', feeAccounts[1]!, WSOL, (await pipeline.feeAuthorityPda(market))],
        ['vault, token', vault0, token, authority],
        ['vault, WSOL (buffer)', vault1, WSOL, authority],
        ['cToken account', ctokenAccount, collateralMint, authority],
        ['LP shares account', lpShares, lpMint, payer.address],
    ];
    for (const [label, account, mint, owner] of tokenAccounts) {
        const found = await accountInfo(account);
        const decoder = getAddressDecoder();
        if (
            found?.owner !== TOKEN_PROGRAM_ADDRESS ||
            decoder.decode(found.data.subarray(0, 32)) !== mint ||
            decoder.decode(found.data.subarray(32, 64)) !== owner
        ) {
            fail(`the ${label} ${account} is not a token account of ${mint} owned by ${owner}`);
        }
    }
    info('fee accounts, vaults, cToken account and LP shares account: token accounts of their mints, with their owners');

    let reserves: [bigint, bigint] = [first.token, first.wsol];
    let shareCount = firstShares + minimumLiquidity;
    // What the market has lent, as the script calculates it: nothing until step 11.
    let lent = { ctokens: 0n, deposited: 0n, redeemed: 0n };
    async function checkMarket(label: string) {
        const { data: state } = await fetchLendingAmmMarket(rpc, marketState, { commitment: 'confirmed' });
        const supply = await mintSupply(lpMint);
        const got = {
            reserves: [state.reserves[0], state.reserves[1]],
            shareCount: supply + minimumLiquidity,
            ctokens: state.ctokens,
            deposited: state.deposited,
            redeemed: state.redeemed,
        };
        const want = { reserves, shareCount, ...lent };
        if (show(got) !== show(want)) fail(`${label}: the market state holds ${show(got)}, but the formulas give ${show(want)}`);
        if ((await tokenBalance(ctokenAccount)) !== lent.ctokens) fail(`${label}: the cToken account holds other than the recorded cTokens`);
        info(
            `${label}: reserves ${reserves[0]} token and ${reserves[1]} WSOL in the buffer, ${lent.ctokens} cTokens, share count ${shareCount}, all as calculated`,
        );
        return state;
    }
    /** The lent side's total, L = B + V, from the market state and the reserve as this script decodes them. */
    async function lentSide() {
        const { data: state } = await fetchLendingAmmMarket(rpc, marketState, { commitment: 'confirmed' });
        const value = lentValue(state.ctokens, await readReserve());
        const buffer = state.reserves[1] ?? fail('the market state has no lent-side reserve');
        return { buffer, ctokens: state.ctokens, value, total: buffer + value };
    }
    const state = await checkMarket('after the first deposit');
    if (state.lentIndex !== 1 || state.lpFeeBps !== DEMO.lpFeeBps || state.marketSigner !== market || state.lpMint !== lpMint) {
        fail('the market state records other parameters');
    }
    if (state.collateralMint !== collateralMint || (await tokenBalance(lpShares)) !== firstShares) {
        fail("the market state's collateral mint or the LP's shares are not as calculated");
    }
    info(`the LP holds ${firstShares} shares; ${minimumLiquidity} more are locked for good, never minted`);
    record.push(['first deposit', `${firstShares} shares, all as calculated`]);

    step('8. Trading both ways through the router');
    const feeBps = BigInt(DEMO.lpFeeBps);
    // Simulated at `confirmed`, as the demo confirms everything (the SDK's default is
    // `finalized`, which a fresh local validator reaches only after about 32 slots).
    const simulation = { commitment: 'confirmed' } as const;
    const tradeOf = (input: 0 | 1, amount: bigint) => ({
        mode: pipeline.TradeMode.ExactIn,
        inputIndex: input,
        outputIndex: 1 - input,
        amount,
        trader: null,
        extra: new Uint8Array(),
    });
    /** What a trade quotes now: the amount out. */
    async function quoteNow(input: 0 | 1, amount: bigint) {
        const trade = tradeOf(input, amount);
        const strategyAccounts = await pipeline.resolveAccounts(rpc, routerView, trade, payer.address, simulation);
        const { quote } = await pipeline.quoteStrategy(rpc, routerView, trade, strategyAccounts, payer.address, simulation);
        return quote.amountOut;
    }
    /** The router's `swap` for `amount` of mint `input`, with the strategy accounts given. */
    const swapInstruction = (input: 0 | 1, amount: bigint, strategyAccounts: AccountMeta[], minAmountOut: bigint) =>
        pipeline.swap(
            {
                trader: payer.address,
                strategyProgram: programId,
                marketState,
                traderInput: holdings[input]!,
                traderOutput: holdings[1 - input]!,
                inputVault: vaults[input]!,
                inputMint: mints[input]!,
                outputMint: mints[1 - input]!,
                inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
                outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
                strategyAccounts,
            },
            {
                mode: pipeline.TradeMode.ExactIn,
                amountIn: amount,
                amountOut: 0n,
                minAmountOut,
                integratorFeeBps: 0,
                extra: new Uint8Array(),
            },
        );
    let lastSwap: { input: 0 | 1; amount: bigint; strategyAccounts: AccountMeta[] } | undefined;
    /** Buys the token with WSOL and sells it back through the router, checking each swap. */
    async function tradeBothWays(when: string) {
        for (const [label, input, amount] of [
            [`buy the token with WSOL${when}`, 1, DEMO.buyWithLamports],
            [`sell the token for WSOL${when}`, 0, DEMO.sellTokens],
        ] as const) {
            const output = 1 - input;
            const trade = tradeOf(input, amount);
            const strategyAccounts = await pipeline.resolveAccounts(rpc, routerView, trade, payer.address, simulation);
            const listed = strategyAccounts[2];
            if (listed?.address !== RESERVE || listed.role !== AccountRole.READONLY) {
                fail(`${label}: account resolution does not list the Kamino reserve ${RESERVE} read-only after the vault and the authority`);
            }
            const { quote, unitsConsumed } = await pipeline.quoteStrategy(
                rpc,
                routerView,
                trade,
                strategyAccounts,
                payer.address,
                simulation,
            );
            // The lent side priced at L = B + V, V decoded by this script from the reserve.
            const lent = await lentSide();
            const effective: [bigint, bigint] = [reserves[0], lent.total];
            const calculated = exactIn(effective[input]!, effective[output]!, amount, feeBps);
            if (quote.amountOut !== calculated || quote.amountIn !== amount) {
                fail(`${label}: the quote is ${quote.amountIn} in, ${quote.amountOut} out; the formula gives ${amount} in, ${calculated} out`);
            }
            info(`${label}: lent side L = B + V = ${lent.buffer} + ${lent.value} (${lent.ctokens} cTokens at the stored rate) = ${lent.total}`);
            info(`${label}: ${amount} in quotes ${quote.amountOut} out (${unitsConsumed} compute units), as calculated`);
            const before = await tokenBalance(holdings[output]!);
            await send(label, payer, [await swapInstruction(input, amount, strategyAccounts, quote.amountOut)]);
            const received = (await tokenBalance(holdings[output]!)) - before;
            if (received !== quote.amountOut) fail(`${label}: received ${received}, quoted ${quote.amountOut}`);
            reserves = input === 1
                ? [reserves[0] - received, reserves[1] + amount]
                : [reserves[0] + amount, reserves[1] - received];
            info(`${label}: received exactly the quote, ${received}`);
            await checkMarket(`after "${label}"`);
            record.push([label, `${amount} in, ${received} out, equal to its quote`]);
            lastSwap = { input, amount, strategyAccounts };
        }
    }
    await tradeBothWays('');

    step('9. Checking a swap built without the Kamino reserve is refused');
    if (!lastSwap) fail('no swap to rebuild');
    const withoutReserve = lastSwap.strategyAccounts.filter((account) => account.address !== RESERVE);
    const refusal = await simulate(payer, [await swapInstruction(lastSwap.input, lastSwap.amount, withoutReserve, 0n)]);
    if (!refusal.err || !refusal.logs.some((line) => line.includes('Error Code: ReserveWrongAddress'))) {
        fail(`a swap without the reserve was not refused with ReserveWrongAddress: ${show(refusal.err)}\n   ${refusal.logs.join('\n   ')}`);
    }
    info('refused by the lending AMM with ReserveWrongAddress, in simulation, so nothing was sent');
    record.push(['swap without the reserve', 'refused: ReserveWrongAddress']);

    step('10. Adding liquidity again, at the ratio');
    const second = DEMO.secondDeposit;
    const lentNow = await lentSide();
    const later = laterDeposit([second.token, second.wsol], [reserves[0], lentNow.total], shareCount);
    const sharesBefore = await tokenBalance(lpShares);
    await send('add_liquidity', payer, [await deposit(second, later.shares)]);
    reserves = [reserves[0] + later.taken[0], reserves[1] + later.taken[1]];
    shareCount += later.shares;
    if ((await tokenBalance(lpShares)) - sharesBefore !== later.shares) fail('the LP received other shares than calculated');
    await checkMarket('after the second deposit');
    info(`minted ${later.shares} shares for ${later.taken[0]} token and ${later.taken[1]} WSOL, as calculated`);
    record.push(['second deposit', `${later.shares} shares, all as calculated`]);

    step('11. Rebalancing: lending the surplus to Kamino');
    const targetBps = idlConstant('BUFFER_TARGET_BPS');
    const maxBps = idlConstant('BUFFER_MAX_BPS');
    const rebalanceInstruction = () =>
        pipeline.buildActionInstruction({
            action: rebalanceAction,
            market: view,
            wallet: payer.address,
            args: {},
            inputs: {
                lent_mint: WSOL,
                reserve: RESERVE,
                lending_market: address(KAMINO.lendingMarket.address),
                reserve_liquidity_supply: address(KAMINO.reserves.wsol.liquiditySupply),
                collateral_mint: collateralMint,
            },
            tokenPrograms,
        });
    const quotes = async () => [await quoteNow(1, DEMO.buyWithLamports), await quoteNow(0, DEMO.sellTokens)];
    const quotesBefore = await quotes();
    const before = await lentSide();
    if (before.buffer * BPS <= before.total * maxBps) fail(`the buffer ${before.buffer} of ${before.total} is not above its band`);
    // The spec's rule: deposit B - floor(L x BUFFER_TARGET_BPS / 10,000).
    const asked = before.buffer - (before.total * targetBps) / BPS;
    const reserveBefore = await readReserve();
    const bufferBefore = await tokenBalance(vault1);
    info(`the buffer holds all ${before.total} of the lent side, above its band: the rule deposits ${asked}`);
    await send('rebalance', payer, [await rebalanceInstruction()]);
    const reserveAfter = await readReserve();
    const minted = await tokenBalance(ctokenAccount);
    const taken = bufferBefore - (await tokenBalance(vault1));
    // klend refreshed the reserve, then added exactly what it took and minted, so the supplies
    // it deposited at are the ones after, less those.
    const supplyAtDeposit = reserveAfter.totalSupplySf - (taken << 60n);
    const ctokensAtDeposit = reserveAfter.mintTotalSupply - minted;
    if (ctokensAtDeposit !== reserveBefore.mintTotalSupply) fail("klend's cToken supply moved by other than what the market received");
    if (reserveAfter.totalAvailableAmount - reserveBefore.totalAvailableAmount !== taken) {
        fail('the reserve received other than what left the buffer');
    }
    const byKlend = klendDeposit(asked, supplyAtDeposit, ctokensAtDeposit);
    if (byKlend.ctokens !== minted || byKlend.taken !== taken) {
        fail(`klend minted ${minted} cTokens for ${taken}; its deposit maths gives ${byKlend.ctokens} for ${byKlend.taken}`);
    }
    info(`klend took ${taken} of the ${asked} WSOL asked and minted ${minted} cTokens into ${ctokenAccount}, as its deposit maths gives`);
    reserves = [reserves[0], reserves[1] - taken];
    lent = { ctokens: minted, deposited: taken, redeemed: 0n };
    await checkMarket('after rebalance');
    const after = await lentSide();
    const target = (after.total * targetBps) / BPS;
    if (after.buffer < target || after.buffer - target > 2n) fail(`the buffer ${after.buffer} is not at its target ${target}`);
    info(`the buffer is ${after.buffer} of a lent side of ${after.total} (V = ${after.value}): its target ${target}, within klend's rounding`);
    const quotesAfter = await quotes();
    // Within Kamino's rounding: the lent side moved by at most a unit, worth at most R / L of
    // the token bought, or a unit of the WSOL a sale pays.
    const bounds = [reserves[0] / after.total + 2n, 1n];
    quotesBefore.forEach((quoted, i) => {
        const now = quotesAfter[i]!;
        if ((quoted > now ? quoted - now : now - quoted) > bounds[i]!) fail(`a quote moved from ${quoted} to ${now} across the rebalance`);
    });
    info(`quotes just before and just after agree within rounding: ${quotesBefore.join(' and ')}, then ${quotesAfter.join(' and ')}`);
    record.push(['rebalance', `lent ${taken} WSOL for ${minted} cTokens; buffer ${after.buffer} of ${after.total}, at its target`]);

    step('12. Checking a second rebalance is refused inside the band');
    const again = await simulate(payer, [await rebalanceInstruction()]);
    if (!again.err || !again.logs.some((line) => line.includes('Error Code: WithinBand'))) {
        fail(`a second rebalance was not refused with WithinBand: ${show(again.err)}\n   ${again.logs.join('\n   ')}`);
    }
    info('refused with WithinBand, in simulation, so nothing was sent and nobody paid');
    record.push(['second rebalance', 'refused: WithinBand']);

    step('13. Trading both ways again, with the cTokens priced at the stored rate');
    await tradeBothWays(', after lending');

    step('14. Selling for more WSOL than the buffer, with accounts resolved for a smaller sale');
    // A sale paying out 1.5 times the buffer, by the formula out = L x a_net / (R + a_net):
    // a_net = ceil(out x R / (L - out)) and one unit more, then the LP fee on top.
    const beforeSale = await lentSide();
    /** The sale of the token that pays out at least `out` WSOL, by the formula, one unit more net. */
    const salePaying = (out: bigint) =>
        ceilDiv((ceilDiv(out * reserves[0], beforeSale.total - out) + 1n) * BPS, BPS - feeBps);
    const saleAmount = salePaying(beforeSale.buffer + beforeSale.buffer / 2n);
    // The smaller sale pays out about half the buffer, which the buffer covers.
    const smallerAmount = salePaying(beforeSale.buffer / 2n);
    const smaller = await pipeline.resolveAccounts(rpc, routerView, tradeOf(0, smallerAmount), payer.address, simulation);
    if (smaller.length !== 3) fail(`a sale the buffer covers resolved ${smaller.length} strategy accounts, not 3`);
    const stale = await simulate(payer, [await swapInstruction(0, saleAmount, smaller, 0n)]);
    if (!stale.err || !stale.logs.some((line) => line.includes('Error Code: RedeemAccountsMissing'))) {
        fail(`a sale built from a smaller sale's accounts was not refused with RedeemAccountsMissing: ${show(stale.err)}\n   ${stale.logs.join('\n   ')}`);
    }
    info(`selling ${saleAmount} with the 3 accounts resolved for selling ${smallerAmount}: refused with RedeemAccountsMissing, in simulation`);
    record.push(['sale with stale accounts', 'refused: RedeemAccountsMissing']);

    step('15. Selling for more WSOL than the buffer: the swap redeems the shortfall from Kamino');
    const sale = tradeOf(0, saleAmount);
    const saleAccounts = await pipeline.resolveAccounts(rpc, routerView, sale, payer.address, simulation);
    // The reserve writable, then klend's redeem accounts, as the spec lists them.
    const expectedRedeem: [Address, AccountRole][] = [
        [RESERVE, AccountRole.WRITABLE],
        [KLEND, AccountRole.READONLY],
        [address(KAMINO.lendingMarket.address), AccountRole.READONLY],
        [(await lendingMarketAuthority()), AccountRole.READONLY],
        [address(KAMINO.reserves.wsol.liquiditySupply), AccountRole.WRITABLE],
        [collateralMint, AccountRole.WRITABLE],
        [ctokenAccount, AccountRole.WRITABLE],
        [TOKEN_PROGRAM_ADDRESS, AccountRole.READONLY],
        [INSTRUCTIONS_SYSVAR, AccountRole.READONLY],
    ];
    expectedRedeem.forEach(([account, role], i) => {
        const listed = saleAccounts[2 + i];
        if (listed?.address !== account || listed.role !== role) {
            fail(`the sale's account resolution lists ${show(listed)} at ${2 + i}, not ${account} with role ${role}`);
        }
    });
    info(`account resolution lists the reserve writable and klend's redeem accounts: ${saleAccounts.length} strategy accounts`);
    const { quote: saleQuote, unitsConsumed: saleUnits } = await pipeline.quoteStrategy(rpc, routerView, sale, saleAccounts, payer.address, simulation);
    const calculatedOut = exactIn(reserves[0], beforeSale.total, saleAmount, feeBps);
    if (saleQuote.amountOut !== calculatedOut) fail(`the sale quotes ${saleQuote.amountOut}; the formula gives ${calculatedOut}`);
    const shortfall = saleQuote.amountOut - beforeSale.buffer;
    if (shortfall <= 0n) fail(`the sale pays out ${saleQuote.amountOut}, within the buffer ${beforeSale.buffer}`);
    // The spec's burn, ceil(s x S_ctoken / S_total) at the stored rate, from this script's decoding.
    const stored = await readReserve();
    const burn = ceilDiv(shortfall * (stored.mintTotalSupply << 60n), stored.totalSupplySf);
    info(`${saleAmount} in quotes ${saleQuote.amountOut} WSOL out (${saleUnits} compute units), as calculated: ${shortfall} beyond the buffer ${beforeSale.buffer}, for ${burn} cTokens`);
    const wsolBefore = await tokenBalance(holdings[1]!);
    const ctokensBefore = await tokenBalance(ctokenAccount);
    const saleSignature = await send('sell beyond the buffer', payer, [await swapInstruction(0, saleAmount, saleAccounts, saleQuote.amountOut)]);
    const saleReceived = (await tokenBalance(holdings[1]!)) - wsolBefore;
    if (saleReceived !== saleQuote.amountOut) fail(`the sale received ${saleReceived}, quoted ${saleQuote.amountOut}`);
    const redeemed = (await strategyEvents(saleSignature, SHORTFALL_REDEEMED_EVENT_DISCRIMINATOR)).map((data) =>
        getShortfallRedeemedEventDecoder().decode(data),
    );
    if (redeemed.length !== 1) fail(`the sale emitted ${redeemed.length} ShortfallRedeemed events, not 1`);
    const event = redeemed[0]!;
    if (event.shortfall !== shortfall) fail(`the redeem event carries the shortfall ${event.shortfall}, not ${shortfall}`);
    if (event.ctokens !== burn || ctokensBefore - (await tokenBalance(ctokenAccount)) !== burn) {
        fail(`the market's cTokens fell by ${ctokensBefore - (await tokenBalance(ctokenAccount))} (event ${event.ctokens}), not the ${burn} calculated`);
    }
    if (event.liquidity < shortfall) fail(`klend paid ${event.liquidity}, less than the shortfall ${shortfall}`);
    reserves = [reserves[0] + saleAmount, reserves[1] + event.liquidity - saleQuote.amountOut];
    lent = { ctokens: lent.ctokens - burn, deposited: lent.deposited, redeemed: lent.redeemed + event.liquidity };
    await checkMarket('after the sale');
    info(`the trader received exactly the quote; klend's redeem paid ${event.liquidity} for ${burn} cTokens, ${event.liquidity - shortfall} above the shortfall, which stays in the buffer`);
    record.push(['sell beyond the buffer', `${saleAmount} in, ${saleReceived} out, ${shortfall} redeemed for ${burn} cTokens`]);

    step('16. Rebalancing: the buffer back to its target');
    const drained = await lentSide();
    if (drained.buffer * BPS >= drained.total * idlConstant('BUFFER_MIN_BPS')) fail(`the buffer ${drained.buffer} of ${drained.total} is not below its band`);
    const ctokensBeforeRebalance = await tokenBalance(ctokenAccount);
    const bufferBeforeRebalance = await tokenBalance(vault1);
    await send('rebalance after the sale', payer, [await rebalanceInstruction()]);
    const burned = ctokensBeforeRebalance - (await tokenBalance(ctokenAccount));
    const paid = (await tokenBalance(vault1)) - bufferBeforeRebalance;
    reserves = [reserves[0], reserves[1] + paid];
    lent = { ctokens: lent.ctokens - burned, deposited: lent.deposited, redeemed: lent.redeemed + paid };
    await checkMarket('after the second rebalance');
    const restored = await lentSide();
    const restoredTarget = (restored.total * targetBps) / BPS;
    // Within Kamino's rounding: a redeem burns the cTokens worth at most the shortfall, so the
    // buffer lands less than one cToken's worth below its target, plus what klend's refresh adds.
    const oneCtoken = ceilDiv(stored.totalSupplySf, stored.mintTotalSupply << 60n);
    const gap = restored.buffer > restoredTarget ? restored.buffer - restoredTarget : restoredTarget - restored.buffer;
    if (gap > oneCtoken + 2n) fail(`the buffer ${restored.buffer} is ${gap} from its target ${restoredTarget}`);
    info(`klend paid ${paid} WSOL for ${burned} cTokens: the buffer is ${restored.buffer} of ${restored.total}, its target ${restoredTarget}, within klend's rounding`);
    record.push(['rebalance after the sale', `redeemed ${paid} WSOL for ${burned} cTokens; buffer ${restored.buffer} of ${restored.total}, at its target`]);

    step(`Done on ${cluster.url}`);
    const width = Math.max(...record.map(([label]) => label.length));
    for (const [label, value] of record) info(`${label.padEnd(width)}  ${value}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
