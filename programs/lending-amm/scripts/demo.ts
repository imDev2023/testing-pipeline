// The lending AMM's demo: lists the strategy on a Pipeline router, creates a WSOL-lent market
// and makes its first deposit in one transaction, trades it both ways through the router, adds
// liquidity again, lends the surplus to Kamino and sells beyond the buffer, then brings Kamino
// short into withdraw mode and out of it and through emergency mode, step by step,
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
//      to its target within klend's rounding;
//  17. a second wallet, funded by the payer, adds liquidity from the metadata's `add_liquidity`
//      action, its shares and the amounts taken equal to the script's calculation;
//  18. it removes a third of its shares in cash, from the metadata's `remove_liquidity` action:
//      it receives exactly `R x lp / N` of the token, and in WSOL exactly `B x lp / N` plus
//      what klend's redeem, which ran in the transaction, paid for `c x lp / N` cTokens, by
//      klend's own maths at the rate it refreshed to (`klendRedeem` in kamino.ts);
//  19. it removes another third in kind, from the metadata's `remove_liquidity_in_kind`
//      action, an instruction holding no Kamino account at all: it receives exactly
//      `R x lp / N` of the token, `B x lp / N` of WSOL and `c x lp / N` cTokens, in its
//      associated token account for the cToken mint, which the removal creates, and the
//      running totals give up the cTokens' part of the net amount lent;
//  20. it redeems those cTokens at klend itself, for at least what the market valued them at
//      when it paid them out, and exactly what klend's own maths gives;
//  21. it locks a tenth of its shares into the market's lock account with the metadata's
//      `lock_lp` action, the lock event reporting them and the share count unchanged;
//  22. Kamino runs short: the test borrower of scripts/kamino-devnet borrows the WSOL reserve's
//      free liquidity below WITHDRAW_MODE_ENTER times the market's exposure max(V, T);
//  23. `rebalance` enters withdraw mode, its event carrying the free liquidity and the exposure
//      it measured, and klend redeems every cToken the market holds, as its maths gives;
//  24. a second `rebalance` is refused with `BelowMinRebalance`, in simulation: it neither
//      deposits nor leaves, though V is now 0, since X is still the target lent value T;
//  25. the borrower repays, the reserve is back above WITHDRAW_MODE_EXIT times X, and
//      `rebalance` leaves withdraw mode and lends again by klend's own deposit;
//  26. the lending market's owner turns the WSOL reserve's emergency mode on: a sale within
//      the buffer trades, one beyond it is refused by the quote and by the swap with
//      `BeyondBuffer`, `rebalance` is refused with `KaminoStopped` and a cash removal with
//      `KaminoCannotPay`, and the second wallet removes the rest of its shares in kind;
//  27. emergency mode off, a sale beyond the buffer redeems its shortfall from Kamino again;
//  28. on a local validator only, the stand-in launchpad (../../tax-amm/scripts/launchpad.ts)
//      graduates a new token into a second market: `pipeline_seed_liquidity`, built from the
//      metadata's `seed_liquidity` form with the market's vault authority as the LP recipient,
//      creates it at ["seeded", seeder, other_mint, lent_mint, lp_fee_bps] from the launchpad's
//      escrows, and the same transaction records it with `register_existing_market` and both
//      fee accounts; SeedResult's `taken` is the seed and what left the escrows, its `lp_amount`
//      the spec's isqrt(other x lent) - MINIMUM_LIQUIDITY, and those shares are in the lock
//      account; the market state holds the launchpad's PDA as its seeder;
//  29. the seeded market trades both ways through the router, each swap equal to its quote and
//      to the script's calculation;
//  30. `rebalance` lends its surplus to Kamino by klend's own deposit, as its maths gives, and
//      the lock account still holds every share.
//
// Steps 22 to 27 run the Kamino-side commands of scripts/kamino-devnet (`borrow`, `repay` and
// `emergency on|off`), with the keys in ~/.config/testing-pipeline/devnet/ (KEYS_DIR); on a
// local validator the script airdrops their wallet the SOL it funds the borrower with, and the
// validator needs the Pyth prices and klend's global config fetch-accounts.sh copies.
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

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
    getTransferCheckedInstruction,
    getTransferInstruction,
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
    getLiquidityRemovedEventDecoder,
    getMarketSeededEventDecoder,
    getSharesLockedEventDecoder,
    getShortfallRedeemedEventDecoder,
    getWithdrawModeEnteredEventDecoder,
    getWithdrawModeLeftEventDecoder,
    LIQUIDITY_REMOVED_EVENT_DISCRIMINATOR,
    MARKET_SEEDED_EVENT_DISCRIMINATOR,
    SHARES_LOCKED_EVENT_DISCRIMINATOR,
    SHORTFALL_REDEEMED_EVENT_DISCRIMINATOR,
    WITHDRAW_MODE_ENTERED_EVENT_DISCRIMINATOR,
    WITHDRAW_MODE_LEFT_EVENT_DISCRIMINATOR,
} from './client/index.ts';
import { findSeederPda, graduateInstruction, graduationFromLogs, LAUNCHPAD_PROGRAM_ADDRESS } from '../../tax-amm/scripts/launchpad.ts';
import { decodeReserve, freeLiquidity, klendDeposit, klendRedeem, lentValue, rate, type ReserveView } from './kamino.ts';

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
//
// Sized for our devnet lending market's WSOL reserve, whose freely available liquidity the
// second depositor keeps at about 5 SOL (scripts/kamino-devnet/src/policy.ts): the lent side
// ends at about 0.4 SOL, so the market's exposure max(V, T) stays below 0.5 SOL and the reserve
// stays above WITHDRAW_MODE_EXIT times it, until the test borrower borrows it down.
const DEMO = {
    lpFeeBps: 30,
    tokenDecimals: 6,
    tokenMinted: 10_000_000_000_000n,
    // What the payer wraps into WSOL for the deposits and the trades.
    wrapLamports: 1_000_000_000n,
    firstDeposit: { token: 175_000_000_000n, wsol: 350_000_000n },
    buyWithLamports: 20_000_000n,
    sellTokens: 5_000_000_000n,
    secondDeposit: { token: 100_000_000_000n, wsol: 150_000_000n },
    // The second wallet, an LP who adds, removes in cash and in kind, and locks: what the payer
    // gives it, what it offers to add, and what it removes and locks of the shares it gets.
    secondLp: {
        lamports: 100_000_000n,
        wrapLamports: 100_000_000n,
        tokens: 50_000_000_000n,
        deposit: { token: 50_000_000_000n, wsol: 50_000_000n },
        removeEachThird: 3n,
        lockTenth: 10n,
    },
    // How far below WITHDRAW_MODE_ENTER times the market's exposure the test borrower takes the
    // WSOL reserve's free liquidity.
    borrowBelowEntry: 50_000_000n,
    // What the stand-in launchpad graduates in steps 28 to 30, on a local validator only, and
    // the most SOL it lends the strategy for rent.
    launch: { seed: { token: 175_000_000_000n, wsol: 350_000_000n }, maxPayerLamports: 100_000_000n },
    // What the Kamino-side commands' wallet (scripts/kamino-devnet) is given on a local
    // validator, where it funds the test borrower and the lending market's owner.
    kaminoWalletLamports: 5_000_000_000n,
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
    reserves: { wsol: { address: string; collateralMint: string; liquiditySupply: string; pythPrice: string } };
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

/**
 * klend's `refresh_reserve` for the demo market's reserve, with the Pyth price account its config
 * names and klend's own id in the other three oracle places, as klend 1.28.0 declares them. Once a
 * market holds cTokens, `add_liquidity` needs the reserve refreshed in the same slot, and quotes
 * and swaps one refreshed within `TRADE_MAX_RESERVE_AGE_SLOTS` (docs/spec/lending-pool.md, "The
 * stored rate, everywhere"), so a depositor puts this first in the same transaction.
 */
function refreshReserve(): Instruction {
    return {
        programAddress: KLEND,
        accounts: [
            { address: RESERVE, role: AccountRole.WRITABLE },
            { address: address(KAMINO.lendingMarket.address), role: AccountRole.READONLY },
            { address: address(KAMINO.reserves.wsol.pythPrice), role: AccountRole.READONLY },
            { address: KLEND, role: AccountRole.READONLY },
            { address: KLEND, role: AccountRole.READONLY },
            { address: KLEND, role: AccountRole.READONLY },
        ],
        // Anchor's discriminator of `refresh_reserve`, `sha256("global:refresh_reserve")[..8]`.
        data: new Uint8Array([2, 218, 138, 235, 79, 201, 25, 102]),
    };
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

/** scripts/kamino-devnet, whose commands play Kamino's side: the test borrower and the lending market's owner. */
const KAMINO_DEVNET = fileURLToPath(new URL('../../../scripts/kamino-devnet/', import.meta.url));
/** The key folder those commands read, as they default it: this project's devnet keys, never in the repo. */
const KAMINO_KEYS = process.env.KEYS_DIR ?? join(homedir(), '.config', 'testing-pipeline', 'devnet');

/** Runs one of scripts/kamino-devnet's commands against this cluster, its output shown as it runs. */
function kaminoCommand(...args: string[]) {
    info(`scripts/kamino-devnet: ${args.join(' ')}`);
    execFileSync('npm', ['run', '--silent', '--prefix', KAMINO_DEVNET, 'cli', '--', ...args, '--url', cluster.url], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, KEYS_DIR: KAMINO_KEYS },
    });
}

/** Lamports as whole SOL with nine decimals, as scripts/kamino-devnet takes amounts. */
const wholeSol = (amount: bigint) => `${amount / 1_000_000_000n}.${(amount % 1_000_000_000n).toString().padStart(9, '0')}`;

const show = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

/**
 * Steps 28 to 30, on a local validator only: the stand-in launchpad graduates a new token into a
 * lending AMM market through `pipeline_seed_liquidity`, built from the metadata's
 * `seed_liquidity` form, with the market's vault authority as the LP recipient, and the same
 * transaction records it with `register_existing_market` and both fee accounts; the market then
 * trades both ways through the router and lends to Kamino with `rebalance`, while the first
 * deposit's shares stay in the lock account.
 */
async function seedFromLaunchpad(input: {
    payer: KeyPairSigner;
    programId: Address;
    metadata: pipeline.StrategyMetadata;
    rebalanceAction: pipeline.MetadataAction;
    minimumLiquidity: bigint;
}) {
    const { payer, programId, metadata, minimumLiquidity } = input;
    const launchpad = await pipeline.inspectProgram(rpc, LAUNCHPAD_PROGRAM_ADDRESS, { hashExecutable: false });
    if (!launchpad.deployed) {
        fail(`the stand-in launchpad is not at ${LAUNCHPAD_PROGRAM_ADDRESS}: start the validator with scripts/local-validator.sh`);
    }
    const form = metadata.seed_liquidity as pipeline.MetadataInit | undefined;
    if (!form?.market_state || !form.args || !form.accounts) fail('metadata.json needs its seed_liquidity form');

    step('28. Graduating a token from the stand-in launchpad into a lending AMM market, its shares locked');
    const seed = DEMO.launch.seed;
    const token = await createTestToken(payer, 'launched token', DEMO.tokenDecimals, seed.token);
    await wrapSol(payer, seed.wsol);
    // The form takes the other mint first and the lent mint second, so lent_index is 1.
    const mints = [token, WSOL] as const;
    const tokenPrograms = [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS] as const;
    const amounts = [seed.token, seed.wsol];
    const decimals = [DEMO.tokenDecimals, 9];
    const seeder = await findSeederPda(payer.address);
    const escrows = await Promise.all(mints.map((mint) => walletTokenAccount(seeder, mint)));
    const payerAccounts = await Promise.all(mints.map((mint) => walletTokenAccount(payer.address, mint)));
    await send('fill the launch escrows', payer, [
        ...(await Promise.all(mints.map((mint) => getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: seeder, mint })))),
        ...mints.map((mint, i) =>
            getTransferCheckedInstruction({
                source: payerAccounts[i]!,
                mint,
                destination: escrows[i]!,
                authority: payer,
                amount: amounts[i]!,
                decimals: decimals[i]!,
            }),
        ),
    ]);
    info(`seeder ${seeder}, the launchpad's PDA for this creator; escrows ${escrows.join(', ')}`);

    // The seeded market state, ["seeded", seeder, other_mint, lent_mint, lp_fee_bps], and the
    // lock account, the vault authority's associated token account for the LP mint, which the
    // form takes as the input lp_recipient_shares, computed before anything is sent.
    const fee = new Uint8Array(2);
    new DataView(fee.buffer).setUint16(0, DEMO.lpFeeBps, true);
    const [marketState] = await getProgramDerivedAddress({
        programAddress: programId,
        seeds: [new TextEncoder().encode('seeded'), ...[seeder, token, WSOL].map((key) => getAddressEncoder().encode(key)), fee],
    });
    const pdas = { programAddress: programId };
    const [authority] = await findAuthorityPda({ marketState }, pdas);
    const [lpMint] = await findLpMintPda({ marketState }, pdas);
    const [ctokenAccount] = await findCtokenAccountPda({ marketState }, pdas);
    const [vault0] = await findVault0Pda({ marketState, mint0: token }, pdas);
    const [vault1] = await findVault1Pda({ marketState, mint1: WSOL }, pdas);
    const vaults = [vault0, vault1];
    const lock = await walletTokenAccount(authority, lpMint);
    const collateralMint = address(KAMINO.reserves.wsol.collateralMint);
    const resolved = await pipeline.resolveInit({
        init: form,
        strategyProgram: programId,
        creator: payer.address,
        args: { lent_index: 1, lp_fee_bps: DEMO.lpFeeBps },
        inputs: {
            seeder,
            other_mint: token,
            lent_mint: WSOL,
            collateral_mint: collateralMint,
            lp_recipient_shares: lock,
            reserve: RESERVE,
        },
        tokenPrograms: Object.fromEntries(mints.map((mint) => [mint, TOKEN_PROGRAM_ADDRESS])),
        rpc,
    });
    if (resolved.marketState !== marketState) fail(`the metadata resolved market state ${resolved.marketState}, not the program's PDA ${marketState}`);
    const expected = [authority, vault0, vault1, collateralMint, ctokenAccount, lpMint, TOKEN_PROGRAM_ADDRESS, lock];
    if (resolved.strategyAccounts.slice(0, expected.length).map((account) => account.address).join() !== expected.join()) {
        fail("the metadata's seed_liquidity accounts are not the program's");
    }
    const market = resolved.market;
    const feeAccounts = await Promise.all(mints.map((mint) => pipeline.feeAccountPda(market, mint, TOKEN_PROGRAM_ADDRESS)));
    for (const [label, account] of [
        ['router market', market],
        ['market state', marketState],
        ['vault, launched token', vault0],
        ['vault, WSOL (buffer)', vault1],
        ['cToken account', ctokenAccount],
        ['LP mint', lpMint],
        ['lock account', lock],
        ['fee account, launched', feeAccounts[0]!],
        ['fee account, WSOL', feeAccounts[1]!],
    ] as const) {
        if (await accountData(account)) fail(`the ${label} ${account} exists before the graduation`);
        info(`${label.padEnd(22)} ${account}`);
    }

    const graduate = await graduateInstruction({
        creator: payer.address,
        strategyProgram: programId,
        amounts,
        data: resolved.initData,
        maxPayerLamports: DEMO.launch.maxPayerLamports,
        accounts: [
            { address: marketState, role: AccountRole.WRITABLE },
            // The LP recipient: the market's vault authority, so the shares go to the lock account.
            { address: authority, role: AccountRole.READONLY },
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
    // What the escrows hold just before, so what left them is measured, whatever they held.
    const escrowed = await Promise.all(escrows.map(tokenBalance));
    const signature = await send('graduate (pipeline_seed_liquidity) + register_existing_market + init_fee_account x2', payer, [
        graduate,
        ...listing,
    ]);
    info(`market ${explorer('address', market)}`);
    record.push(['seeded market', market], ['seeded market state', marketState]);

    const transaction = await rpc
        .getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' })
        .send();
    const logs = transaction?.meta?.logMessages ?? fail('the graduation left no logs');
    const graduation = graduationFromLogs(logs) ?? fail("the launchpad's return data is missing");
    const shares = isqrt(seed.token * seed.wsol) - minimumLiquidity;
    const left = await Promise.all(escrows.map(async (escrow, i) => escrowed[i]! - (await tokenBalance(escrow))));
    if (show(graduation.leftEscrows) !== show(amounts) || show(left) !== show(amounts) || show(graduation.taken) !== show(amounts)) {
        fail(`SeedResult says taken ${show(graduation.taken)}; the escrows lost ${show(left)} (the launchpad measured ${show(graduation.leftEscrows)}), not the seed ${show(amounts)}`);
    }
    if (graduation.lpAmount !== shares) fail(`SeedResult says lp_amount ${graduation.lpAmount}; the formula gives ${shares}`);
    info(`SeedResult: taken ${show(graduation.taken)}, exactly what left the escrows; lp_amount ${shares}, isqrt(${seed.token} x ${seed.wsol}) - ${minimumLiquidity}`);
    const consumed = logs
        .map((line) => line.match(new RegExp(`^Program ${programId} consumed (\\d+) of`))?.[1])
        .find((units) => units !== undefined);
    info(`pipeline_seed_liquidity: ${consumed} CU`);
    const seeded = (await strategyEvents(signature, MARKET_SEEDED_EVENT_DISCRIMINATOR)).map((data) => getMarketSeededEventDecoder().decode(data));
    if (seeded.length !== 1 || seeded[0]!.seeder !== seeder || seeded[0]!.sharesAccount !== lock || seeded[0]!.shares !== shares) {
        fail(`the graduation emitted ${show(seeded)}, not one MarketSeeded by ${seeder} into ${lock}`);
    }
    if ((await tokenBalance(lock)) !== shares) fail(`the lock account ${lock} holds ${await tokenBalance(lock)}, not the ${shares} shares`);
    const lockInfo = (await accountInfo(lock)) ?? fail('no lock account');
    if (getAddressDecoder().decode(lockInfo.data.subarray(32, 64)) !== authority) fail('the lock account is not the vault authority\'s');
    info(`the ${shares} shares are in the lock account ${lock}, owned by the vault authority, which nothing can move them out of`);

    const routerMarket = pipeline.decodeMarket((await accountData(market)) ?? new Uint8Array());
    if (!routerMarket) fail(`the router has no market at ${market}`);
    const view = pipeline.marketViewFromMarket(market, routerMarket, [...tokenPrograms]);
    if (view.mints.join() !== mints.join() || view.vaults.join() !== vaults.join()) {
        fail(`the router recorded mints ${view.mints.join(', ')} and vaults ${view.vaults.join(', ')}`);
    }
    for (const feeAccount of feeAccounts) {
        if (!(await accountData(feeAccount))) fail(`fee account ${feeAccount} was not created`);
    }
    info('router market: recorded in the same transaction, with both fee accounts');
    const { data: state } = await fetchLendingAmmMarket(rpc, marketState, { commitment: 'confirmed' });
    if (
        state.seeder !== seeder ||
        state.marketSigner !== market ||
        state.lentIndex !== 1 ||
        state.lpFeeBps !== DEMO.lpFeeBps ||
        show(state.reserves) !== show(amounts) ||
        (await mintSupply(lpMint)) !== shares
    ) {
        fail(`the seeded market state holds ${show({ seeder: state.seeder, reserves: state.reserves, marketSigner: state.marketSigner })}`);
    }
    info("the market state holds the launchpad's PDA as its seeder, the router's market signer, and the seed as its reserves");
    record.push(['graduation', `seeded ${show(amounts)}, ${shares} shares locked`]);

    step('29. Trading the seeded market both ways through the router');
    const simulation = { commitment: 'confirmed' } as const;
    const feeBps = BigInt(DEMO.lpFeeBps);
    let reserves: [bigint, bigint] = [seed.token, seed.wsol];
    const holdings = payerAccounts;
    for (const [label, side, amount] of [
        ['buy the launched token with WSOL', 1, DEMO.buyWithLamports],
        ['sell the launched token for WSOL', 0, DEMO.sellTokens],
    ] as const) {
        const output = 1 - side;
        const trade = {
            mode: pipeline.TradeMode.ExactIn,
            inputIndex: side,
            outputIndex: output,
            amount,
            trader: null,
            extra: new Uint8Array(),
        };
        const strategyAccounts = await pipeline.resolveAccounts(rpc, view, trade, payer.address, simulation);
        const { quote } = await pipeline.quoteStrategy(rpc, view, trade, strategyAccounts, payer.address, simulation);
        // Nothing is lent yet, so L is the buffer alone.
        const calculated = exactIn(reserves[side]!, reserves[output]!, amount, feeBps);
        if (quote.amountOut !== calculated) fail(`${label}: the quote is ${quote.amountOut}; the formula gives ${calculated}`);
        const before = await tokenBalance(holdings[output]!);
        await send(label, payer, [
            await pipeline.swap(
                {
                    trader: payer.address,
                    strategyProgram: programId,
                    marketState,
                    traderInput: holdings[side]!,
                    traderOutput: holdings[output]!,
                    inputVault: vaults[side]!,
                    inputMint: mints[side]!,
                    outputMint: mints[output]!,
                    inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
                    outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
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
        const received = (await tokenBalance(holdings[output]!)) - before;
        if (received !== quote.amountOut) fail(`${label}: received ${received}, quoted ${quote.amountOut}`);
        reserves = side === 1 ? [reserves[0] - received, reserves[1] + amount] : [reserves[0] + amount, reserves[1] - received];
        const { data: after } = await fetchLendingAmmMarket(rpc, marketState, { commitment: 'confirmed' });
        if (show(after.reserves) !== show(reserves)) fail(`${label}: the market state holds ${show(after.reserves)}, the formulas give ${show(reserves)}`);
        info(`${label}: ${amount} in, ${received} out, equal to its quote and the formula`);
        record.push([`seeded market: ${label}`, `${amount} in, ${received} out`]);
    }

    step('30. Rebalancing the seeded market: lending its surplus to Kamino, the locked shares untouched');
    const targetBps = idlConstant('BUFFER_TARGET_BPS');
    const asked = reserves[1] - (reserves[1] * targetBps) / BPS;
    const reserveBefore = await readReserve();
    await send('rebalance the seeded market', payer, [
        await pipeline.buildActionInstruction({
            action: input.rebalanceAction,
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
            tokenPrograms: Object.fromEntries(mints.map((mint) => [mint, TOKEN_PROGRAM_ADDRESS])),
        }),
    ]);
    const reserveAfter = await readReserve();
    const minted = await tokenBalance(ctokenAccount);
    const taken = reserves[1] - (await tokenBalance(vault1));
    const byKlend = klendDeposit(asked, reserveAfter.totalSupplySf - (taken << 60n), reserveAfter.mintTotalSupply - minted);
    if (reserveAfter.mintTotalSupply - minted !== reserveBefore.mintTotalSupply || minted === 0n || byKlend.ctokens !== minted || byKlend.taken !== taken) {
        fail(`klend minted ${minted} cTokens for ${taken}; its deposit maths gives ${byKlend.ctokens} for ${byKlend.taken} of the ${asked} asked`);
    }
    const { data: lentState } = await fetchLendingAmmMarket(rpc, marketState, { commitment: 'confirmed' });
    if (lentState.ctokens !== minted || lentState.deposited !== taken || lentState.reserves[1] !== reserves[1] - taken) {
        fail(`the seeded market recorded ${lentState.ctokens} cTokens and ${lentState.deposited} deposited, not ${minted} and ${taken}`);
    }
    if ((await tokenBalance(lock)) !== shares) fail('the lock account gave shares up');
    info(`klend took ${taken} of the ${asked} WSOL asked and minted ${minted} cTokens, as its deposit maths gives; the lock account still holds ${shares}`);
    record.push(['seeded market rebalanced', `lent ${taken} WSOL for ${minted} cTokens; ${shares} shares still locked`]);
}

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
    const removeAction = (name: string) =>
        metadata.actions?.find((action) => action.name === name) ?? fail(`metadata.json needs the ${name} action`);

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

    step('17. A second wallet adds liquidity');
    const lp2 = await generateKeyPairSigner();
    const lp2Plan = DEMO.secondLp;
    const lp2Holdings = await Promise.all(mints.map((mint) => walletTokenAccount(lp2.address, mint)));
    // The payer funds it: SOL for its fees and rent, the test token, and wrapped SOL.
    await send('fund the second wallet', payer, [
        getTransferSolInstruction({ source: payer, destination: lp2.address, amount: lp2Plan.lamports + lp2Plan.wrapLamports }),
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: lp2.address, mint: token }),
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: lp2.address, mint: WSOL }),
        getTransferInstruction({ source: holdings[0]!, destination: lp2Holdings[0]!, authority: payer, amount: lp2Plan.tokens }),
    ]);
    await send('the second wallet wraps SOL', lp2, [
        getTransferSolInstruction({ source: lp2, destination: lp2Holdings[1]!, amount: lp2Plan.wrapLamports }),
        getSyncNativeInstruction({ account: lp2Holdings[1]! }),
    ]);
    info(`second wallet ${lp2.address}: ${lp2Plan.tokens} token, ${lp2Plan.wrapLamports} WSOL`);
    const [lp2Shares] = await findLpSharesPda({ marketState, lp: lp2.address }, pdas);
    const beforeLp2 = await lentSide();
    const atStoredRate = laterDeposit([lp2Plan.deposit.token, lp2Plan.deposit.wsol], [reserves[0], beforeLp2.total], shareCount);
    // The market holds cTokens, so the deposit needs the reserve refreshed in the same slot, which
    // raises its rate by the interest since its last refresh: the shares are fewer than at the
    // stored rate, so the wallet allows 1% less, then checks the spec's formula at the rate klend
    // refreshed to, which nothing else in the transaction changes.
    const lp2Add = await pipeline.buildActionInstruction({
        action: addLiquidity,
        market: view,
        wallet: lp2.address,
        args: { max_0: lp2Plan.deposit.token, max_1: lp2Plan.deposit.wsol, min_lp: (atStoredRate.shares * 99n) / 100n },
        inputs: { reserve: RESERVE },
        tokenPrograms,
    });
    const unrefreshed = await simulate(lp2, [lp2Add]);
    if (!unrefreshed.err || !unrefreshed.logs.some((line) => line.includes('Error Code: ReserveStale'))) {
        fail(`a deposit without klend's refresh was not refused with ReserveStale: ${show(unrefreshed.err)}\n   ${unrefreshed.logs.join('\n   ')}`);
    }
    info(`without klend's refresh first, the deposit is refused with ReserveStale (the reserve was last refreshed ${(await rpc.getSlot({ commitment: 'confirmed' }).send()) - (await readReserve()).lastUpdateSlot} slots before), in simulation`);
    record.push(['deposit without a refresh', 'refused: ReserveStale']);
    await send('refresh_reserve + add_liquidity by the second wallet', lp2, [refreshReserve(), lp2Add]);
    const refreshedTotal = beforeLp2.buffer + lentValue(beforeLp2.ctokens, await readReserve());
    const lp2Deposit = laterDeposit([lp2Plan.deposit.token, lp2Plan.deposit.wsol], [reserves[0], refreshedTotal], shareCount);
    info(`klend's refresh raised the lent side from ${beforeLp2.total} to ${refreshedTotal}: ${lp2Deposit.shares} shares, not the ${atStoredRate.shares} the stored rate gave`);
    reserves = [reserves[0] + lp2Deposit.taken[0], reserves[1] + lp2Deposit.taken[1]];
    shareCount += lp2Deposit.shares;
    if ((await tokenBalance(lp2Shares)) !== lp2Deposit.shares) fail('the second wallet received other shares than calculated');
    await checkMarket("after the second wallet's deposit");
    info(`minted ${lp2Deposit.shares} shares for ${lp2Deposit.taken[0]} token and ${lp2Deposit.taken[1]} WSOL, as calculated`);
    record.push(["second wallet's deposit", `${lp2Deposit.shares} shares, all as calculated`]);

    /** The spec's removal parts for `lp` shares: `[R, B, c] x lp / N`, each rounded down. */
    const removalParts = (lp: bigint) => ({
        token: (reserves[0] * lp) / shareCount,
        buffer: (reserves[1] * lp) / shareCount,
        ctokens: (lent.ctokens * lp) / shareCount,
    });
    const removeInputs = {
        collateral_mint: collateralMint,
        reserve: RESERVE,
        lending_market: address(KAMINO.lendingMarket.address),
        reserve_liquidity_supply: address(KAMINO.reserves.wsol.liquiditySupply),
    };
    const removeTokenPrograms = { ...tokenPrograms, [collateralMint]: TOKEN_PROGRAM_ADDRESS };
    const removeInstruction = (form: string, lp: bigint, min: [bigint, bigint], inKind: boolean) =>
        pipeline.buildActionInstruction({
            action: removeAction(form),
            market: view,
            wallet: lp2.address,
            args: { lp, min_other: min[0], min_lent: min[1], in_kind: inKind },
            inputs: inKind ? { collateral_mint: collateralMint } : removeInputs,
            tokenPrograms: removeTokenPrograms,
        });
    /** The one LiquidityRemoved event transaction `signature` emitted. */
    async function removedEvent(signature: Signature) {
        const events = (await strategyEvents(signature, LIQUIDITY_REMOVED_EVENT_DISCRIMINATOR)).map((data) =>
            getLiquidityRemovedEventDecoder().decode(data),
        );
        if (events.length !== 1) fail(`the removal emitted ${events.length} LiquidityRemoved events, not 1`);
        return events[0]!;
    }
    const lp2Ctoken = await walletTokenAccount(lp2.address, collateralMint);
    const third = lp2Deposit.shares / lp2Plan.removeEachThird;

    step('18. The second wallet removes a third of its shares in cash');
    const cashParts = removalParts(third);
    if (cashParts.token === 0n || cashParts.buffer === 0n || cashParts.ctokens === 0n) fail(`a third of the shares pays ${show(cashParts)}`);
    const storedAtCash = await readReserve();
    const cashWorth = lentValue(cashParts.ctokens, storedAtCash);
    const heldBeforeCash = await Promise.all(lp2Holdings.map(tokenBalance));
    const cashSignature = await send('remove_liquidity in cash', lp2, [
        await removeInstruction('remove_liquidity', third, [cashParts.token, cashParts.buffer + cashWorth], false),
    ]);
    const cashLogs = (await rpc.getTransaction(cashSignature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 }).send())?.meta?.logMessages ?? [];
    if (!cashLogs.some((line) => line.startsWith(`Program ${KLEND} invoke`)) || !cashLogs.some((line) => line.includes('Instruction: RedeemReserveCollateral'))) {
        fail("the cash removal's transaction has no klend redeem");
    }
    const reserveAfterCash = await readReserve();
    const cashReceived = await Promise.all(lp2Holdings.map(async (account, i) => (await tokenBalance(account)) - heldBeforeCash[i]!));
    const paidByKlend = cashReceived[1]! - cashParts.buffer;
    // klend refreshed the reserve, then paid out the liquidity and burned the cTokens, so the
    // supplies it redeemed at are the ones after, plus those.
    const supplyAtRedeem = reserveAfterCash.totalSupplySf + (paidByKlend << 60n);
    const ctokensAtRedeem = reserveAfterCash.mintTotalSupply + cashParts.ctokens;
    if (ctokensAtRedeem !== storedAtCash.mintTotalSupply) fail("klend's cToken supply moved by other than the cTokens' part");
    const byKlendRedeem = klendRedeem(cashParts.ctokens, supplyAtRedeem, ctokensAtRedeem);
    if (cashReceived[0] !== cashParts.token || paidByKlend !== byKlendRedeem) {
        fail(`the cash removal paid ${show(cashReceived)}; the formulas give ${cashParts.token} token and ${cashParts.buffer} + ${byKlendRedeem} WSOL`);
    }
    if (paidByKlend < cashWorth) fail(`klend paid ${paidByKlend}, less than the market valued the cTokens at, ${cashWorth}`);
    const cashEvent = await removedEvent(cashSignature);
    if (cashEvent.inKind || cashEvent.shares !== third || cashEvent.ctokens !== cashParts.ctokens || cashEvent.redeemed !== paidByKlend) {
        fail(`the removal event carries ${show(cashEvent)}`);
    }
    if ((await tokenBalance(lp2Ctoken)) !== 0n) fail('the cash removal paid cTokens');
    reserves = [reserves[0] - cashParts.token, reserves[1] - cashParts.buffer];
    shareCount -= third;
    lent = { ctokens: lent.ctokens - cashParts.ctokens, deposited: lent.deposited, redeemed: lent.redeemed + paidByKlend };
    await checkMarket('after the cash removal');
    info(`burned ${third} shares for ${cashParts.token} token and ${cashParts.buffer} + ${paidByKlend} WSOL: klend redeemed ${cashParts.ctokens} cTokens in the transaction, as its maths gives, ${paidByKlend - cashWorth} above their value at the stored rate`);
    record.push(['remove in cash', `${third} shares for ${cashParts.token} token and ${cashReceived[1]} WSOL, ${cashParts.ctokens} cTokens redeemed by klend`]);

    step('19. The second wallet removes another third in kind, with no Kamino account');
    const kindParts = removalParts(third);
    const storedAtKind = await readReserve();
    const kindWorth = lentValue(kindParts.ctokens, storedAtKind);
    const inKind = await removeInstruction('remove_liquidity_in_kind', third, [kindParts.token, kindParts.buffer], true);
    for (const account of inKind.accounts ?? []) {
        if (account.address === KLEND || (await accountInfo(account.address))?.owner === KLEND) {
            fail(`the in-kind removal holds the Kamino account ${account.address}`);
        }
    }
    info(`the in-kind removal's ${inKind.accounts?.length ?? 0} accounts include nothing Kamino Lend owns, nor Kamino Lend itself`);
    if (await accountInfo(lp2Ctoken)) fail(`the second wallet's cToken account ${lp2Ctoken} exists before the removal`);
    const heldBeforeKind = await Promise.all(lp2Holdings.map(tokenBalance));
    const kindSignature = await send('remove_liquidity in kind', lp2, [inKind]);
    const kindReceived = await Promise.all(lp2Holdings.map(async (account, i) => (await tokenBalance(account)) - heldBeforeKind[i]!));
    if (kindReceived[0] !== kindParts.token || kindReceived[1] !== kindParts.buffer || (await tokenBalance(lp2Ctoken)) !== kindParts.ctokens) {
        fail(`the in-kind removal paid ${show(kindReceived)} and ${await tokenBalance(lp2Ctoken)} cTokens; the formulas give ${show(kindParts)}`);
    }
    const kindEvent = await removedEvent(kindSignature);
    if (!kindEvent.inKind || kindEvent.ctokens !== kindParts.ctokens || kindEvent.redeemed !== 0n) fail(`the removal event carries ${show(kindEvent)}`);
    reserves = [reserves[0] - kindParts.token, reserves[1] - kindParts.buffer];
    shareCount -= third;
    // The cTokens take their part of the net amount lent, rounded towards zero, off whichever
    // running total is the larger, so the yield V + redeemed - deposited stays right.
    const net = lent.deposited - lent.redeemed;
    const take = ((net < 0n ? -net : net) * kindParts.ctokens) / lent.ctokens;
    lent = {
        ctokens: lent.ctokens - kindParts.ctokens,
        deposited: net >= 0n ? lent.deposited - take : lent.deposited,
        redeemed: net >= 0n ? lent.redeemed : lent.redeemed - take,
    };
    await checkMarket('after the in-kind removal');
    info(`burned ${third} shares for ${kindParts.token} token, ${kindParts.buffer} WSOL and ${kindParts.ctokens} cTokens in ${lp2Ctoken}, as calculated`);
    record.push(['remove in kind', `${third} shares for ${kindParts.token} token, ${kindParts.buffer} WSOL and ${kindParts.ctokens} cTokens`]);

    step('20. The second wallet redeems those cTokens at klend itself');
    const lp2WsolBefore = await tokenBalance(lp2Holdings[1]!);
    const lmAuthority = await lendingMarketAuthority();
    const redeemData = new Uint8Array([...(await pipeline.anchorDiscriminator('redeem_reserve_collateral')), ...new Uint8Array(new BigUint64Array([kindParts.ctokens]).buffer)]);
    // klend 1.28.0's `redeem_reserve_collateral` accounts, in its order.
    const redeemAt: Instruction = {
        programAddress: KLEND,
        accounts: [
            { address: lp2.address, role: AccountRole.READONLY_SIGNER, signer: lp2 } as AccountMeta,
            { address: address(KAMINO.lendingMarket.address), role: AccountRole.READONLY },
            { address: RESERVE, role: AccountRole.WRITABLE },
            { address: lmAuthority, role: AccountRole.READONLY },
            { address: WSOL, role: AccountRole.READONLY },
            { address: collateralMint, role: AccountRole.WRITABLE },
            { address: address(KAMINO.reserves.wsol.liquiditySupply), role: AccountRole.WRITABLE },
            { address: lp2Ctoken, role: AccountRole.WRITABLE },
            { address: lp2Holdings[1]!, role: AccountRole.WRITABLE },
            { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
            { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
            { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
        ],
        data: redeemData,
    };
    await send("redeem the cTokens at klend", lp2, [redeemAt]);
    const reserveAfterRedeem = await readReserve();
    const redeemedAtKlend = (await tokenBalance(lp2Holdings[1]!)) - lp2WsolBefore;
    const ownRedeem = klendRedeem(
        kindParts.ctokens,
        reserveAfterRedeem.totalSupplySf + (redeemedAtKlend << 60n),
        reserveAfterRedeem.mintTotalSupply + kindParts.ctokens,
    );
    if (redeemedAtKlend !== ownRedeem) fail(`klend paid ${redeemedAtKlend} for the cTokens; its maths gives ${ownRedeem}`);
    if (redeemedAtKlend < kindWorth) fail(`klend paid ${redeemedAtKlend}, less than the market valued the cTokens at, ${kindWorth}`);
    if ((await tokenBalance(lp2Ctoken)) !== 0n) fail('the cTokens were not all redeemed');
    info(`klend paid ${redeemedAtKlend} WSOL for ${kindParts.ctokens} cTokens the market valued at ${kindWorth} when it paid them out, as klend's maths gives`);
    record.push(['redeem at klend', `${kindParts.ctokens} cTokens for ${redeemedAtKlend} WSOL, valued by the market at ${kindWorth}`]);

    step('21. The second wallet locks a tenth of its shares');
    const lockAmount = lp2Deposit.shares / lp2Plan.lockTenth;
    const [lockAccount] = await findAssociatedTokenPda({ owner: authority, mint: lpMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const lp2SharesBefore = await tokenBalance(lp2Shares);
    const lockSignature = await send('lock_lp', lp2, [
        await pipeline.buildActionInstruction({
            action: removeAction('lock_lp'),
            market: view,
            wallet: lp2.address,
            args: { amount: lockAmount },
            inputs: { lock_account: lockAccount },
            tokenPrograms,
        }),
    ]);
    const locked = (await strategyEvents(lockSignature, SHARES_LOCKED_EVENT_DISCRIMINATOR)).map((data) =>
        getSharesLockedEventDecoder().decode(data),
    );
    if (locked.length !== 1 || locked[0]!.amount !== lockAmount || locked[0]!.locked !== lockAmount || locked[0]!.shareCount !== shareCount) {
        fail(`the lock event carries ${show(locked)}`);
    }
    if ((await tokenBalance(lockAccount)) !== lockAmount || (await tokenBalance(lp2Shares)) !== lp2SharesBefore - lockAmount) {
        fail(`the lock account ${lockAccount} holds ${await tokenBalance(lockAccount)}, not ${lockAmount}`);
    }
    await checkMarket('after the lock');
    info(`${lockAmount} shares moved into the lock account ${lockAccount} for good; the share count ${shareCount} is unchanged`);
    record.push(['lock', `${lockAmount} shares in ${lockAccount}`]);

    // Withdraw mode and Kamino's other states (docs/spec/lending-pool.md, "Withdraw mode" and
    // "When Kamino can't pay"), with the Kamino-side commands of scripts/kamino-devnet.
    const enterMultiple = idlConstant('WITHDRAW_MODE_ENTER');
    const exitMultiple = idlConstant('WITHDRAW_MODE_EXIT');
    /** The market's exposure X = max(V, T), T = L - floor(L x BUFFER_TARGET_BPS / 10,000), and Kamino's free liquidity. */
    async function exposure() {
        const side = await lentSide();
        const targetLent = side.total - (side.total * targetBps) / BPS;
        return { ...side, x: side.value > targetLent ? side.value : targetLent, free: freeLiquidity(await readReserve()) };
    }
    const withdrawMode = async () => (await fetchLendingAmmMarket(rpc, marketState, { commitment: 'confirmed' })).data.withdrawMode;
    /** Sends `rebalance` and measures what moved at the buffer vault and the cToken account. */
    async function rebalanceMeasured(label: string) {
        const ctokensBefore = await tokenBalance(ctokenAccount);
        const bufferBefore = await tokenBalance(vault1);
        const signature = await send(label, payer, [await rebalanceInstruction()]);
        const ctokensAfter = await tokenBalance(ctokenAccount);
        const bufferAfter = await tokenBalance(vault1);
        return { signature, ctokensBefore, ctokensAfter, bufferBefore, bufferAfter };
    }
    /** Simulates `instructions` by `feePayer` and stops unless the lending AMM refuses them with `error`. */
    async function refusedWith(label: string, feePayer: KeyPairSigner, instructions: Instruction[], error: string) {
        const result = await simulate(feePayer, instructions);
        if (!result.err || !result.logs.some((line) => line.includes(`Error Code: ${error}`))) {
            fail(`${label} was not refused with ${error}: ${show(result.err)}\n   ${result.logs.join('\n   ')}`);
        }
        info(`${label}: refused with ${error}, in simulation, so nothing was sent`);
        record.push([label, `refused: ${error}`]);
    }
    /** The sale of the token that pays out at least `out` WSOL on the market as it is, by the formula. */
    async function saleNow(out: bigint) {
        const side = await lentSide();
        return ceilDiv((ceilDiv(out * reserves[0], side.total - out) + 1n) * BPS, BPS - feeBps);
    }
    /**
     * Sells `amount` of the token through the router with its own resolved accounts: the trader
     * receives exactly the quote, the formula's output, and a sale beyond the buffer redeems its
     * shortfall from Kamino inside the swap, anything klend paid above it staying in the buffer.
     */
    async function sellToken(label: string, amount: bigint) {
        const trade = tradeOf(0, amount);
        const accounts = await pipeline.resolveAccounts(rpc, routerView, trade, payer.address, simulation);
        const { quote } = await pipeline.quoteStrategy(rpc, routerView, trade, accounts, payer.address, simulation);
        const side = await lentSide();
        const calculated = exactIn(reserves[0], side.total, amount, feeBps);
        if (quote.amountOut !== calculated) fail(`${label}: the quote is ${quote.amountOut}; the formula gives ${calculated}`);
        const before = await tokenBalance(holdings[1]!);
        const signature = await send(label, payer, [await swapInstruction(0, amount, accounts, quote.amountOut)]);
        const received = (await tokenBalance(holdings[1]!)) - before;
        if (received !== quote.amountOut) fail(`${label}: received ${received}, quoted ${quote.amountOut}`);
        const events = (await strategyEvents(signature, SHORTFALL_REDEEMED_EVENT_DISCRIMINATOR)).map((data) =>
            getShortfallRedeemedEventDecoder().decode(data),
        );
        const beyond = quote.amountOut > side.buffer;
        if (events.length !== (beyond ? 1 : 0)) fail(`${label}: ${events.length} ShortfallRedeemed events for a sale ${beyond ? 'beyond' : 'within'} the buffer`);
        const redeem = events[0];
        if (redeem) {
            if (redeem.shortfall !== quote.amountOut - side.buffer || redeem.liquidity < redeem.shortfall) fail(`${label}: the redeem event carries ${show(redeem)}`);
            reserves = [reserves[0] + amount, reserves[1] + redeem.liquidity - quote.amountOut];
            lent = { ctokens: lent.ctokens - redeem.ctokens, deposited: lent.deposited, redeemed: lent.redeemed + redeem.liquidity };
        } else {
            reserves = [reserves[0] + amount, reserves[1] - quote.amountOut];
        }
        await checkMarket(`after "${label}"`);
        info(`${label}: ${amount} in, ${received} WSOL out, equal to its quote and the formula${redeem ? `; klend redeemed ${redeem.liquidity} for ${redeem.ctokens} cTokens inside the swap` : ', from the buffer alone'}`);
        record.push([label, `${amount} in, ${received} out${redeem ? `, ${redeem.shortfall} redeemed` : ''}`]);
        return { amount, received, redeem };
    }

    step('22. Kamino runs short: the test borrower borrows the WSOL reserve below WITHDRAW_MODE_ENTER times max(V, T)');
    if (cluster.local) {
        const wallet = await loadKey(join(KAMINO_KEYS, 'wallet.json'));
        await fundLocally("Kamino-side commands' wallet", wallet.address, DEMO.kaminoWalletLamports);
    }
    const beforeBorrow = await exposure();
    if (beforeBorrow.free <= exitMultiple * beforeBorrow.x) {
        fail(`the reserve's free liquidity ${beforeBorrow.free} is not above ${exitMultiple} x ${beforeBorrow.x}: the demo market is too large for it`);
    }
    if (await withdrawMode()) fail('the market is in withdraw mode before Kamino runs short');
    const borrowAmount = beforeBorrow.free - enterMultiple * beforeBorrow.x + DEMO.borrowBelowEntry;
    info(`Kamino has ${beforeBorrow.free} WSOL free against the market's X = max(V, T) = max(${beforeBorrow.value}, ${beforeBorrow.total - (beforeBorrow.total * targetBps) / BPS}) = ${beforeBorrow.x}: the borrower takes ${borrowAmount}`);
    kaminoCommand('borrow', '--amount', wholeSol(borrowAmount));
    const short = await exposure();
    if (short.free >= enterMultiple * short.x) fail(`after the borrow Kamino has ${short.free} free, not below ${enterMultiple} x ${short.x}`);
    info(`Kamino now has ${short.free} WSOL free, below ${enterMultiple} x ${short.x} = ${enterMultiple * short.x}`);

    step('23. Rebalancing: the market enters withdraw mode and redeems everything Kamino can pay');
    const reserveBeforeExit = await readReserve();
    const entering = await rebalanceMeasured('rebalance into withdraw mode');
    const entered = (await strategyEvents(entering.signature, WITHDRAW_MODE_ENTERED_EVENT_DISCRIMINATOR)).map((data) =>
        getWithdrawModeEnteredEventDecoder().decode(data),
    );
    // klend refreshes the reserve inside the redeem, so the free liquidity the program measured
    // is the stored one, before the call.
    if (entered.length !== 1 || entered[0]!.freeLiquidity !== freeLiquidity(reserveBeforeExit) || entered[0]!.exposure !== short.x) {
        fail(`the rebalance emitted ${show(entered)}, not one WithdrawModeEntered at ${freeLiquidity(reserveBeforeExit)} free and X ${short.x}`);
    }
    if (!(await withdrawMode())) fail('the market is not in withdraw mode after the rebalance');
    const burnedAll = entering.ctokensBefore - entering.ctokensAfter;
    const paidAll = entering.bufferAfter - entering.bufferBefore;
    if (entering.ctokensAfter !== 0n || burnedAll !== lent.ctokens) fail(`the rebalance burned ${burnedAll} of ${lent.ctokens} cTokens, not all of them`);
    const reserveAfterExit = await readReserve();
    const paidByKlendAll = klendRedeem(burnedAll, reserveAfterExit.totalSupplySf + (paidAll << 60n), reserveAfterExit.mintTotalSupply + burnedAll);
    if (paidAll !== paidByKlendAll || paidAll < short.value) {
        fail(`klend paid ${paidAll} for ${burnedAll} cTokens; its maths gives ${paidByKlendAll}, and the market valued them at ${short.value}`);
    }
    reserves = [reserves[0], reserves[1] + paidAll];
    lent = { ctokens: 0n, deposited: lent.deposited, redeemed: lent.redeemed + paidAll };
    await checkMarket('after entering withdraw mode');
    info(`WithdrawModeEntered at ${entered[0]!.freeLiquidity} free and X ${entered[0]!.exposure}; klend redeemed every one of the market's ${burnedAll} cTokens for ${paidAll} WSOL, as its maths gives`);
    record.push(['withdraw mode entered', `redeemed ${burnedAll} cTokens for ${paidAll} WSOL`]);

    step('24. Checking a second rebalance neither deposits nor leaves withdraw mode');
    const stillShort = await exposure();
    if (stillShort.free > exitMultiple * stillShort.x) fail(`Kamino has ${stillShort.free} free, above the exit threshold ${exitMultiple * stillShort.x}`);
    await refusedWith('a second rebalance in withdraw mode', payer, [await rebalanceInstruction()], 'BelowMinRebalance');
    if (!(await withdrawMode()) || (await tokenBalance(ctokenAccount)) !== 0n) fail('the market left withdraw mode or lent again');
    info(`everything is redeemed, V = 0, but X is still T = ${stillShort.x}: Kamino's ${stillShort.free} free is at or below ${exitMultiple} x ${stillShort.x}, so it stays`);

    step('25. The borrower repays, and rebalance leaves withdraw mode and lends again');
    kaminoCommand('repay');
    const repaid = await exposure();
    if (repaid.free <= exitMultiple * repaid.x) fail(`after the repay Kamino has ${repaid.free} free, not above ${exitMultiple} x ${repaid.x}`);
    info(`Kamino has ${repaid.free} WSOL free again, above ${exitMultiple} x ${repaid.x} = ${exitMultiple * repaid.x}`);
    const reserveBeforeReturn = await readReserve();
    const asked2 = repaid.buffer - (repaid.total * targetBps) / BPS;
    const leaving = await rebalanceMeasured('rebalance out of withdraw mode');
    const left = (await strategyEvents(leaving.signature, WITHDRAW_MODE_LEFT_EVENT_DISCRIMINATOR)).map((data) =>
        getWithdrawModeLeftEventDecoder().decode(data),
    );
    if (left.length !== 1 || left[0]!.freeLiquidity !== freeLiquidity(reserveBeforeReturn) || left[0]!.exposure !== repaid.x) {
        fail(`the rebalance emitted ${show(left)}, not one WithdrawModeLeft at ${freeLiquidity(reserveBeforeReturn)} free and X ${repaid.x}`);
    }
    if (await withdrawMode()) fail('the market is still in withdraw mode');
    const minted2 = leaving.ctokensAfter - leaving.ctokensBefore;
    const taken2 = leaving.bufferBefore - leaving.bufferAfter;
    const reserveAfterReturn = await readReserve();
    const byKlend2 = klendDeposit(asked2, reserveAfterReturn.totalSupplySf - (taken2 << 60n), reserveAfterReturn.mintTotalSupply - minted2);
    if (minted2 === 0n || byKlend2.ctokens !== minted2 || byKlend2.taken !== taken2) {
        fail(`klend minted ${minted2} cTokens for ${taken2}; its deposit maths gives ${byKlend2.ctokens} for ${byKlend2.taken} of the ${asked2} asked`);
    }
    reserves = [reserves[0], reserves[1] - taken2];
    lent = { ctokens: minted2, deposited: lent.deposited + taken2, redeemed: lent.redeemed };
    await checkMarket('after leaving withdraw mode');
    info(`WithdrawModeLeft at ${left[0]!.freeLiquidity} free; the band applies again and klend took ${taken2} WSOL for ${minted2} cTokens, as its deposit maths gives`);
    record.push(['withdraw mode left', `lent ${taken2} WSOL for ${minted2} cTokens`]);

    step("26. The WSOL reserve's emergency mode on: buffer only, rebalance refuses, LPs leave in kind");
    kaminoCommand('emergency', 'on');
    const inEmergency = await lentSide();
    await sellToken('sell within the buffer in emergency mode', await saleNow(inEmergency.buffer / 2n));
    const afterWithin = await lentSide();
    const beyondAmount = await saleNow(afterWithin.buffer + afterWithin.buffer / 2n);
    const beyondTrade = tradeOf(0, beyondAmount);
    const beyondAccounts = await pipeline.resolveAccounts(rpc, routerView, beyondTrade, payer.address, simulation);
    if (beyondAccounts.length !== 3) fail(`a sale Kamino cannot pay resolved ${beyondAccounts.length} strategy accounts, not 3 without redeem accounts`);
    try {
        await pipeline.quoteStrategy(rpc, routerView, beyondTrade, beyondAccounts, payer.address, simulation);
        fail('a sale beyond the buffer was quoted in emergency mode');
    } catch (error) {
        const logs = error instanceof pipeline.SimulationError ? error.logs : [];
        if (!logs.some((line) => line.includes('Error Code: BeyondBuffer'))) throw error;
        info(`a sale of ${beyondAmount}, beyond the buffer: the quote is refused with BeyondBuffer`);
        record.push(['quote beyond the buffer in emergency mode', 'refused: BeyondBuffer']);
    }
    await refusedWith('a swap beyond the buffer in emergency mode', payer, [await swapInstruction(0, beyondAmount, beyondAccounts, 0n)], 'BeyondBuffer');
    await refusedWith('rebalance in emergency mode', payer, [await rebalanceInstruction()], 'KaminoStopped');
    const lp2Left = await tokenBalance(lp2Shares);
    const leftParts = removalParts(lp2Left);
    await refusedWith(
        "the second wallet's removal in cash in emergency mode",
        lp2,
        [await removeInstruction('remove_liquidity', lp2Left, [0n, 0n], false)],
        'KaminoCannotPay',
    );
    const lp2CtokensBefore = await tokenBalance(lp2Ctoken);
    const lp2HeldBefore = await Promise.all(lp2Holdings.map(tokenBalance));
    await send('the second wallet removes the rest in kind in emergency mode', lp2, [
        await removeInstruction('remove_liquidity_in_kind', lp2Left, [leftParts.token, leftParts.buffer], true),
    ]);
    const lp2Got = await Promise.all(lp2Holdings.map(async (account, i) => (await tokenBalance(account)) - lp2HeldBefore[i]!));
    if (lp2Got[0] !== leftParts.token || lp2Got[1] !== leftParts.buffer || (await tokenBalance(lp2Ctoken)) - lp2CtokensBefore !== leftParts.ctokens) {
        fail(`the in-kind removal paid ${show(lp2Got)}; the formulas give ${show(leftParts)}`);
    }
    reserves = [reserves[0] - leftParts.token, reserves[1] - leftParts.buffer];
    shareCount -= lp2Left;
    const netLent = lent.deposited - lent.redeemed;
    const takeLeft = ((netLent < 0n ? -netLent : netLent) * leftParts.ctokens) / lent.ctokens;
    lent = {
        ctokens: lent.ctokens - leftParts.ctokens,
        deposited: netLent >= 0n ? lent.deposited - takeLeft : lent.deposited,
        redeemed: netLent >= 0n ? lent.redeemed : lent.redeemed - takeLeft,
    };
    await checkMarket('after the in-kind removal in emergency mode');
    info(`the second wallet burned its last ${lp2Left} shares for ${leftParts.token} token, ${leftParts.buffer} WSOL and ${leftParts.ctokens} cTokens`);

    step("27. Emergency mode off: a sale beyond the buffer redeems from Kamino again");
    kaminoCommand('emergency', 'off');
    const sideNow = await lentSide();
    const afterEmergency = await sellToken('sell beyond the buffer after emergency mode', await saleNow(sideNow.buffer + sideNow.buffer / 2n));
    if (!afterEmergency.redeem) fail('the sale beyond the buffer did not redeem');

    if (cluster.local) {
        await seedFromLaunchpad({ payer, programId, metadata, rebalanceAction, minimumLiquidity });
    } else {
        step('28 to 30. Graduating a token from a launchpad');
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
