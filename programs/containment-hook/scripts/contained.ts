// Acts on contained tokens already on a cluster, where `launch.ts` only launches new ones: it
// lists every token the containment hook binds, trades one through its home market, and
// unlocks one once it is due. The hook's hardening (#74) uses it to show on devnet that the
// tokens bound before the hook's redeploy still trade in their home markets through the new
// build and can still be unlocked (docs/toolchain.md, "Containment hook").
//
//   list     every hook config on the cluster (getProgramAccounts on the hook, which the public
//            devnet RPC serves and Alchemy's free tier does not), with its mint, home market,
//            quote mint, goal, the tax its home market has collected, deadline, and whether it
//            is unlocked, or due; it sends nothing
//   trade    a router buy of the contained token, spending `--buy` base units of its quote mint,
//            into the wallet's associated token account, then a sell of half of what arrived
//            back, each through Pipeline's SDK with the hook accounts, stopping unless each
//            delivered its quote and the hook ran on it; prints each signature, the hook's
//            `Execute` compute and what arrived; refuses a token already unlocked. With wrapped
//            SOL as the quote mint it wraps what the buy needs; with any other it needs the
//            wallet's associated account of that mint to hold it
//   unlock   sends the hook's permissionless `unlock` once the token is due (its home market
//            has collected the goal, or the cluster's clock has reached the deadline), prints the
//            logs' "Unlocked by ..." line, and stops unless the mint's transfer hook program and
//            hook authority are both unset and the config records its unlock time and nothing
//            else changed; refuses a token not yet due, saying when it will be
//
// The hook accounts (the config, the hook program and the validation account) are resolved
// from the validation account with Token-2022's own client, `resolveExtraAccountMetasForExecute`
// from @solana-program/token-2022, as `launch.ts` resolves them.
//
// Usage, from this directory after `pnpm install`:
//
//   node contained.ts list --cluster <localnet|devnet|URL> [--record <file.json>]
//   node contained.ts trade --cluster <c> --mint <contained mint> --wallet <keypair.json> \
//     --buy <quote-mint base units> [--record <file.json>]
//   node contained.ts unlock --cluster <c> --mint <contained mint> --payer <keypair.json> \
//     [--record <file.json>]
//
//   --cluster  localnet (http://127.0.0.1:8899), devnet, or an RPC URL of either; the cluster's
//              genesis hash must be devnet's, or the URL a local validator's
//   --record   a JSON file to write what the run read and every signature it sent to, also when
//              it stops part way
//
// On a local cluster `trade` and `unlock` airdrop what the wallet or the payer lacks; on devnet
// they never do (fund it with devnet-airdrop, docs/toolchain.md).

import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { getBase58Decoder, type Address, type Base58EncodedBytes, type Instruction, type KeyPairSigner } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, getSyncNativeInstruction } from '@solana-program/token';
import { resolveExtraAccountMetasForExecute } from '@solana-program/token-2022';
import * as pipeline from '@pipeline-placeholder/sdk';

import { UsageError, WRAPPED_SOL } from './args.ts';
import { connect, fail, hookCompute, info, loadKey, refusedByTheHook, show, sleep, Stopped, TOKEN_2022_PROGRAM_ADDRESS, type ContainedView, type HookAccountsFor } from './chain.ts';
import { parseContainedArgs, USAGE, type ContainedCommand } from './contained-args.ts';
import {
    CONFIG_DISCRIMINATOR,
    CONTAINMENT_HOOK_ERROR__UNLOCK_NOT_DUE,
    CONTAINMENT_HOOK_PROGRAM_ADDRESS,
    fetchMaybeConfig,
    findConfigPda,
    findUnlockPda,
    getConfigDecoder,
    getUnlockInstructionAsync,
    type Config,
} from './client/index.ts';
import { getTaxMarketDecoder, TAX_AMM_PROGRAM_ADDRESS } from '../../tax-amm/scripts/client/index.ts';

// What `trade` may spend in SOL beyond a wrapped SOL buy: two associated token accounts' rent
// and the transactions' fees, checked before anything is sent.
const TRADE_RENT_AND_FEES = 20_000_000n;
// What `unlock`'s payer needs: one transaction's fee, with room.
const UNLOCK_FEES = 1_000_000n;
// What a local run airdrops beyond what it needs, so a few runs need no more.
const LOCAL_HEADROOM = 2_000_000_000n;
// How long `unlock` retries a refusal for not being due once the script has found it due: a
// block can carry a clock a little behind the latest confirmed block's time.
const UNLOCK_CLOCK_RETRIES = 10;
const REFUSAL = 'contained.ts acts on contained tokens only on devnet or a local validator';

let command: ContainedCommand;
try {
    command = parseContainedArgs(process.argv.slice(2));
} catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
}
const recordPath = command.record && resolve(command.record);
if (recordPath && !existsSync(dirname(recordPath))) {
    console.error(`--record: no directory ${dirname(recordPath)} to write ${basename(recordPath)} in\n\n${USAGE}`);
    process.exit(2);
}

const record: [string, string][] = [];
const { rpc, onDevnet, explorer, checkCluster, landedTransaction, send, simulate, fundLocally, account, tokenBalance, clusterTime, trade } = connect(command.cluster, record);

const time = (unix: bigint) => new Date(Number(unix) * 1000).toISOString();

function step(title: string) {
    console.log(`\n== ${title}`);
}

/** Writes what the run did to `--record`, also when it stopped part way. */
function writeRecord(outcome: string) {
    if (!recordPath) return;
    writeFileSync(recordPath, `${JSON.stringify({ cluster: onDevnet ? 'devnet' : command.cluster.url, command: command.command, at: new Date().toISOString(), outcome, record }, null, 2)}\n`);
    console.log(`Record written to ${recordPath}`);
}

/** The tax the home market `marketState` has collected, or undefined when it cannot be read as the tax AMM's. */
async function taxCollected(marketState: Address): Promise<bigint | undefined> {
    const state = await account(marketState);
    if (state?.owner !== TAX_AMM_PROGRAM_ADDRESS) return undefined;
    try {
        return getTaxMarketDecoder().decode(state.data).taxCollected;
    } catch {
        return undefined;
    }
}

/** Whether the unlock is due, as the hook's unlock rule decides it (`terms.rs`, `unlock_due`). */
function dueBy(config: Config, collected: bigint | undefined, now: bigint): 'goal' | 'deadline' | undefined {
    if (collected !== undefined && collected >= config.unlockGoal) return 'goal';
    if (now >= config.unlockDeadline) return 'deadline';
    return undefined;
}

/** The mint's transfer hook program and authority, or a stop when there is no Token-2022 mint at `mint`. */
async function transferHookOf(mint: Address) {
    const mintAccount = await account(mint);
    const decoded = mintAccount && pipeline.decodeMint(mint, TOKEN_2022_PROGRAM_ADDRESS, mintAccount.data);
    if (!decoded) fail(`no Token-2022 mint at ${mint}`);
    return decoded.extensions.transferHook ?? fail(`the mint ${mint} has no transfer hook extension`);
}

/** The hook's config for `mint`, or a stop when the hook binds no such token here. */
async function configOf(mint: Address) {
    const [config] = await findConfigPda({ mint });
    const found = await fetchMaybeConfig(rpc, config, { commitment: 'confirmed' });
    if (!found.exists) fail(`the containment hook has no config for ${mint} (${config}): it is not a contained token on this cluster`);
    return { config, bound: found.data };
}

async function list() {
    step(`Every token the containment hook ${CONTAINMENT_HOOK_PROGRAM_ADDRESS} binds`);
    const owned = await rpc
        .getProgramAccounts(CONTAINMENT_HOOK_PROGRAM_ADDRESS, {
            encoding: 'base64',
            commitment: 'confirmed',
            filters: [{ memcmp: { offset: 0n, bytes: getBase58Decoder().decode(CONFIG_DISCRIMINATOR) as Base58EncodedBytes, encoding: 'base58' } }],
        })
        .send();
    const now = await clusterTime();
    info(`${owned.length} config${owned.length === 1 ? '' : 's'}; the cluster's clock is ${time(now)}`);
    const configs = owned
        .map(({ pubkey, account }) => ({ address: pubkey, config: getConfigDecoder().decode(Buffer.from(account.data[0], 'base64')) }))
        .sort((a, b) => Number(a.config.boundAt - b.config.boundAt));
    for (const { address, config } of configs) {
        const collected = await taxCollected(config.marketState);
        const unlocked = config.unlockedAt.__option === 'Some' ? config.unlockedAt.value : undefined;
        const due = dueBy(config, collected, now);
        const left = config.unlockDeadline - now;
        const state =
            unlocked !== undefined
                ? `unlocked at ${time(unlocked)}`
                : due
                  ? `contained, due now by the ${due}`
                  : `contained, due at the deadline, in ${left} s, or sooner once the goal is collected`;
        const collectedText = collected === undefined ? 'unreadable (the market state is not a tax market)' : `${collected}`;
        console.log(`\n   mint          ${config.mint}`);
        info(`config        ${address}`);
        info(`home market   ${config.market} (market state ${config.marketState})`);
        info(`quote mint    ${config.quoteMint}`);
        info(`goal          ${config.unlockGoal}, tax collected ${collectedText}`);
        info(`deadline      ${time(config.unlockDeadline)} (${config.unlockDeadline}), ${left > 0n ? `in ${left} s` : `passed ${-left} s ago`}`);
        info(`bound at      ${time(config.boundAt)}`);
        info(`state         ${state}`);
        record.push([
            config.mint,
            show({
                config: address,
                market: config.market,
                marketState: config.marketState,
                quoteMint: config.quoteMint,
                unlockGoal: config.unlockGoal,
                taxCollected: collected ?? null,
                unlockDeadline: time(config.unlockDeadline),
                boundAt: time(config.boundAt),
                unlockedAt: unlocked === undefined ? null : time(unlocked),
                state,
            }),
        ]);
    }
}

async function tradeToken(mint: Address, wallet: KeyPairSigner, buy: bigint) {
    step(`Reading ${mint}, its config and its home market`);
    const { config, bound } = await configOf(mint);
    if (bound.unlockedAt.__option === 'Some') {
        fail(`${mint} was unlocked at ${time(bound.unlockedAt.value)}: it trades without the hook now, so a trade would show nothing of containment`);
    }
    const hook = await transferHookOf(mint);
    if (hook.programId !== CONTAINMENT_HOOK_PROGRAM_ADDRESS) fail(`the mint's transfer hook program is ${hook.programId}, not the containment hook`);
    const recorded = await account(bound.market);
    const market = recorded && pipeline.decodeMarket(recorded.data);
    if (!market) fail(`the router has no market at ${bound.market}, the config's home market`);
    const mints = pipeline.marketMints(market);
    const tokenPrograms: Address[] = [];
    for (const each of mints) tokenPrograms.push((await account(each))?.owner ?? fail(`no mint at ${each}, one of the home market's mints`));
    const view: ContainedView = { ...pipeline.marketViewFromMarket(bound.market, market, tokenPrograms), containedIndex: mints.indexOf(mint) };
    if (mints.length !== 2 || view.containedIndex < 0) fail(`the home market ${bound.market} trades ${mints.join(', ')}, not the token and one quote mint`);
    if (view.marketState !== bound.marketState) fail(`the home market's state is ${view.marketState}, but the config binds ${bound.marketState}`);
    const quoteIndex = 1 - view.containedIndex;
    const quoteMint = mints[quoteIndex]!;
    const quoteTokenProgram = tokenPrograms[quoteIndex]!;
    if (quoteMint !== bound.quoteMint) fail(`the home market's other mint is ${quoteMint}, but the config's quote mint is ${bound.quoteMint}`);
    const [tokenHolder] = await findAssociatedTokenPda({ owner: wallet.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    const [quoteHolder] = await findAssociatedTokenPda({ owner: wallet.address, mint: quoteMint, tokenProgram: quoteTokenProgram });
    info(`config ${config}; home market ${bound.market} (market state ${bound.marketState}); quote mint ${quoteMint}`);
    info(`the wallet's token account ${tokenHolder}, its quote account ${quoteHolder}`);
    record.push(['mint', mint], ['wallet', wallet.address], ['home market', bound.market], ['quote mint', quoteMint]);

    // Everything the trade spends is checked before anything is sent.
    const buySpend = pipeline.maxTotalSpend(buy, 0) ?? fail(`a buy of ${buy} overflows with Pipeline's fee`);
    const wrapped = quoteMint === WRAPPED_SOL;
    const quoteHeld = (await account(quoteHolder)) ? await tokenBalance(quoteHolder) : 0n;
    const wrap = wrapped && quoteHeld < buySpend ? buySpend - quoteHeld : 0n;
    const solNeeded = wrap + TRADE_RENT_AND_FEES;
    if (command.cluster.local) await fundLocally(wallet.address, solNeeded + LOCAL_HEADROOM, 'the wallet');
    if (!wrapped && quoteHeld < buySpend) fail(`the wallet's ${quoteMint} account ${quoteHolder} holds ${quoteHeld}, but the buy needs ${buySpend} with Pipeline's fee`);
    const { value: solHeld } = await rpc.getBalance(wallet.address, { commitment: 'confirmed' }).send();
    if (solHeld < solNeeded) fail(`the wallet holds ${Number(solHeld) / 1e9} SOL, but the trade needs ${Number(solNeeded) / 1e9}`);

    step("Creating the wallet's token account" + (wrap > 0n ? `, and wrapping ${Number(wrap) / 1e9} SOL for the buy` : ''));
    const setup: Instruction[] = [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: wallet, owner: wallet.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })];
    if (wrapped) {
        setup.push(await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: wallet, owner: wallet.address, mint: quoteMint }));
        if (wrap > 0n) setup.push(getTransferSolInstruction({ source: wallet, destination: quoteHolder, amount: wrap }), getSyncNativeInstruction({ account: quoteHolder }));
    }
    await send(wrap > 0n ? `create the wallet's token accounts and wrap ${wrap} lamports` : "create the wallet's token account", wallet, setup);

    const hookAccounts: HookAccountsFor = (source, destination, owner) =>
        resolveExtraAccountMetasForExecute({ rpc, transferHookProgramAddress: CONTAINMENT_HOOK_PROGRAM_ADDRESS, source, mint, destination, owner, amount: 0n });

    step(`Buying the token with ${buy} of the quote mint through the router, with the hook accounts`);
    const bought = await trade(wallet, view, quoteIndex, view.containedIndex, buy, tokenHolder, quoteHolder, hookAccounts);
    info(`buy: ${explorer('tx', bought.signature)}; Execute ${bought.hookUnits.join(' and ')} CU; ${bought.received} of the token arrived`);
    record.push(['buy', `${buy} of the quote mint bought ${bought.received} of the token, its quote; Pipeline's fee ${bought.pipelineFee} in the ${bought.feeSide}; Execute ${bought.hookUnits.join(' and ')} CU; ${bought.signature}`]);

    step('Selling half of it back the same way');
    const sold = await trade(wallet, view, view.containedIndex, quoteIndex, bought.received / 2n, tokenHolder, quoteHolder, hookAccounts);
    info(`sell: ${explorer('tx', sold.signature)}; Execute ${sold.hookUnits.join(' and ')} CU; ${sold.received} of the quote mint kept`);
    record.push(['sell', `${bought.received / 2n} of the token sold for ${sold.received} of the quote mint, its quote; Pipeline's fee ${sold.pipelineFee} in the ${sold.feeSide}; Execute ${sold.hookUnits.join(' and ')} CU; ${sold.signature}`]);
}

async function unlockToken(mint: Address, payer: KeyPairSigner) {
    step(`Reading ${mint} and its config`);
    const { config, bound } = await configOf(mint);
    if (bound.unlockedAt.__option === 'Some') fail(`${mint} is already unlocked, at ${time(bound.unlockedAt.value)}`);
    const [unlockPda] = await findUnlockPda({ mint });
    const hook = await transferHookOf(mint);
    if (hook.programId !== CONTAINMENT_HOOK_PROGRAM_ADDRESS || hook.authority !== unlockPda) {
        fail(`the mint's transfer hook is ${show(hook)}, not the containment hook with its unlock PDA ${unlockPda} as authority`);
    }
    const collected = await taxCollected(bound.marketState);
    const now = await clusterTime();
    const collectedText = collected === undefined ? 'its market state unreadable as a tax market' : `${collected} of the goal ${bound.unlockGoal} collected`;
    info(`config ${config}; ${collectedText}; deadline ${time(bound.unlockDeadline)}; the cluster's clock ${time(now)}`);
    const due = dueBy(bound, collected, now);
    if (!due) {
        fail(
            `${mint} is not due for unlock: ${collectedText}, and its deadline ${time(bound.unlockDeadline)} is ${bound.unlockDeadline - now} s away by the cluster's clock; it falls due then, or sooner once its home market has collected the goal`,
        );
    }
    record.push(['mint', mint], ['config', config], ['due', `by the ${due}: ${collectedText}, deadline ${time(bound.unlockDeadline)}, cluster time ${time(now)}`]);

    step(`Unlocking by the ${due}, from ${payer.address}`);
    if (command.cluster.local) await fundLocally(payer.address, UNLOCK_FEES + LOCAL_HEADROOM, 'the payer');
    const { value: solHeld } = await rpc.getBalance(payer.address, { commitment: 'confirmed' }).send();
    if (solHeld < UNLOCK_FEES) fail(`the payer holds ${Number(solHeld) / 1e9} SOL, but unlock needs ${Number(UNLOCK_FEES) / 1e9} for its fee`);
    const unlockInstruction = await getUnlockInstructionAsync({ mint, marketState: bound.marketState });
    for (let attempt = 0; ; attempt++) {
        const { err, logs } = await simulate(payer, unlockInstruction);
        if (!err) break;
        if (attempt >= UNLOCK_CLOCK_RETRIES || !refusedByTheHook(logs, 'UnlockNotDue', CONTAINMENT_HOOK_ERROR__UNLOCK_NOT_DUE)) fail(`unlock fails in simulation: ${show(err)}\n${logs.join('\n')}`);
        await sleep(1_000);
    }
    const signature = await send('unlock', payer, [unlockInstruction]);
    const logs = (await landedTransaction('unlock', signature)).meta?.logMessages ?? [];
    const prefix = 'Program log: Unlocked by ';
    const line = logs.find((each) => each.startsWith(prefix));
    if (!line) fail(`the unlock's logs say nothing "Unlocked by":\n${logs.join('\n')}`);
    const [units] = hookCompute(logs);
    info(`${line.slice('Program log: '.length)}; unlock took ${units} CU`);
    record.push(['unlocked', `${line.slice('Program log: '.length)}; ${units} CU; ${signature}`]);

    step('Checking the mint and the config after the unlock');
    const freed = await transferHookOf(mint);
    if (freed.programId !== null || freed.authority !== null) fail(`after the unlock the mint's transfer hook is ${show(freed)}`);
    info('mint: the transfer hook extension stays, with its program and its authority both unset');
    const after = await fetchMaybeConfig(rpc, config, { commitment: 'confirmed' });
    if (!after.exists || after.data.unlockedAt.__option !== 'Some') fail('the config does not record the unlock');
    if (show({ ...after.data, unlockedAt: bound.unlockedAt }) !== show(bound)) fail(`the unlock changed more of the config than its unlock time: ${show(after.data)}`);
    info(`config: unlocked at ${time(after.data.unlockedAt.value)}, and nothing else in it changed`);
    record.push(['after the unlock', `transfer hook program and hook authority both unset; config unlocked at ${time(after.data.unlockedAt.value)}, nothing else changed`]);
}

async function main() {
    console.log(`Containment hook ${CONTAINMENT_HOOK_PROGRAM_ADDRESS}, tax AMM ${TAX_AMM_PROGRAM_ADDRESS}, Pipeline router ${pipeline.PIPELINE_PROGRAM_ADDRESS} on ${command.cluster.url}`);
    await checkCluster(REFUSAL);
    if (command.command === 'list') {
        await list();
    } else if (command.command === 'trade') {
        const wallet = await loadKey(command.wallet);
        console.log(`Wallet ${wallet.address}`);
        await tradeToken(command.mint as Address, wallet, command.buy);
    } else {
        const payer = await loadKey(command.payer);
        console.log(`Payer ${payer.address}`);
        await unlockToken(command.mint as Address, payer);
    }
    step(`Done on ${command.cluster.url}`);
    writeRecord('done');
}

main().catch((error) => {
    console.error(error instanceof Stopped ? `\nStopped: ${error.message}` : error);
    try {
        writeRecord(`stopped: ${error instanceof Error ? error.message : String(error)}`);
    } catch (writeError) {
        console.error(`The record could not be written to ${recordPath}: ${writeError}`);
    }
    process.exit(1);
});
