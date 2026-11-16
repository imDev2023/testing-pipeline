// Publishes the tax AMM's metadata for a devnet deploy (docs/toolchain.md, "Deploy to devnet";
// docs/spec/README.md, "Metadata, IDL and conformance report"):
//
//   node publish.ts pin [--report-commit <commit>]
//
//     Pins metadata.json to the commit deployments/devnet.json records for the tax AMM: the
//     source and IDL links at that commit, and `source.commit`; with --report-commit, the
//     commit that records the deploy, also `conformance`, naming conformance/devnet.json at
//     that commit with the SHA-256 of the copy committed here, and the README at that commit,
//     which says where the program is. Then checks the result with Pipeline's validator.
//
//   node publish.ts verify --uri <metadata URI> [--market <router market>]
//
//     Checks what is published, as anyone would see it: the URI resolves and passes the
//     validator with zero warnings; `security.audits` is empty; every link in it resolves; the
//     report hashes to its SHA-256; every commit it names is on origin/main; the router on
//     devnet points the strategy at this URI; and Pipeline's hosted devnet API shows the
//     strategy with this metadata, valid, and the market with exactly the trust flags
//     docs/spec/tax-amm.md ("Mint rules") predicts from its mints.
//
// Run from this directory after `pnpm install`.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { address, createSolanaRpc, type Address } from '@solana/kit';
import { getMintDecoder, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import * as pipeline from '@pipeline-placeholder/sdk';

const REPO = 'https://github.com/imDev2023/testing-pipeline';
const RAW = 'https://raw.githubusercontent.com/imDev2023/testing-pipeline';
const DIR = 'programs/tax-amm';
const PROGRAM = 'tax-amm';
const REPORT = 'conformance/devnet.json';
const DEVNET_URL = 'https://api.devnet.solana.com';
const API = 'https://pipeline-devnet.up.railway.app';
const TOKEN_2022_PROGRAM_ADDRESS = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const here = (path: string) => new URL(path, import.meta.url);
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function fail(message: string): never {
    console.error(`\nStopped: ${message}`);
    process.exit(1);
}

function sha256(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('hex');
}

const isCommit = (text: string) => /^[0-9a-f]{40}$/.test(text);

/**
 * The links metadata.json carries into this repo: the source and the IDL at `code` (the
 * deployed commit), the README at `docs` (the commit that records the deploy).
 */
function repoLinks(code: string, docs: string) {
    return {
        source: `${REPO}/tree/${code}/${DIR}`,
        idl: `${RAW}/${code}/${DIR}/idl/tax_amm.json`,
        docs: `${REPO}/blob/${docs}/${DIR}/README.md`,
    };
}

function checkLocally(metadata: unknown) {
    const parsed = pipeline.parseStrategyMetadata(metadata);
    if (!parsed.ok) fail(`metadata.json is invalid:\n   ${parsed.errors.join('\n   ')}`);
    if (parsed.warnings.length > 0) fail(`metadata.json has warnings:\n   ${parsed.warnings.join('\n   ')}`);
}

function pin(reportCommit: string | undefined) {
    const deployments = JSON.parse(readFileSync(`${repoRoot}/deployments/devnet.json`, 'utf8'));
    const commit: string = deployments.programs?.[PROGRAM]?.commit ?? fail(`deployments/devnet.json records no ${PROGRAM}`);
    if (!isCommit(commit)) fail(`deployments/devnet.json's commit ${commit} is not a full commit hash`);
    const path = here('../metadata.json');
    const metadata = JSON.parse(readFileSync(path, 'utf8'));
    metadata.links = { ...metadata.links, ...repoLinks(commit, reportCommit ?? commit) };
    metadata.source = { ...metadata.source, commit };
    if (reportCommit !== undefined) {
        if (!isCommit(reportCommit)) fail(`--report-commit must be a full commit hash, not ${reportCommit}`);
        const report = readFileSync(here(`../${REPORT}`));
        metadata.conformance = { report: `${RAW}/${reportCommit}/${DIR}/${REPORT}`, sha256: sha256(report) };
    } else {
        // An earlier deploy's report does not describe this one.
        delete metadata.conformance;
    }
    metadata.security = { ...metadata.security, audits: [] };
    checkLocally(metadata);
    writeFileSync(path, `${JSON.stringify(metadata, null, 4)}\n`);
    console.log(`metadata.json pinned to ${commit}${reportCommit ? `, its report at ${reportCommit}` : ''}`);
}

async function getOk(url: string): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
        const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'testing-pipeline-publish' } });
        if (response.ok) return new Uint8Array(await response.arrayBuffer());
        if (attempt >= 3 || response.status < 500) fail(`${url} answered HTTP ${response.status}`);
        await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
}

async function getJson(url: string) {
    return JSON.parse(Buffer.from(await getOk(url)).toString('utf8'));
}

function fetchMain() {
    execFileSync('perl', ['-e', 'alarm 120; exec @ARGV', 'git', '-C', repoRoot, 'fetch', '-q', 'origin', 'main']);
}

function onMain(commit: string) {
    try {
        execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', commit, 'origin/main']);
        return true;
    } catch {
        return false;
    }
}

/** What the trust flags of a tax market's mints can be (docs/spec/tax-amm.md, "Mint rules"). */
async function predictedMintFlags(rpc: ReturnType<typeof createSolanaRpc>, mint: Address) {
    const { value } = await rpc.getAccountInfo(mint, { encoding: 'base64' }).send();
    if (!value) fail(`no mint at ${mint}`);
    const data = new Uint8Array(Buffer.from(value.data[0], 'base64'));
    const decoded = getMintDecoder().decode(data.subarray(0, 82));
    const flags: string[] = [];
    if (value.owner === TOKEN_2022_PROGRAM_ADDRESS) flags.push('token-2022');
    else if (value.owner !== TOKEN_PROGRAM_ADDRESS) fail(`${mint} is not a mint`);
    if (decoded.mintAuthority.__option === 'Some') flags.push('mint-authority');
    if (decoded.freezeAuthority.__option === 'Some') flags.push('freeze-authority');
    // A Token-2022 mint with a transfer hook would add `transfer-hook` and its authority; the
    // demo market's mints are SPL Token mints, so this check never needs to read extensions.
    if (value.owner === TOKEN_2022_PROGRAM_ADDRESS) fail(`${mint} is a Token-2022 mint; read its extensions before predicting its flags`);
    return flags;
}

async function verify(uri: string, market: string | undefined) {
    const deployments = JSON.parse(readFileSync(`${repoRoot}/deployments/devnet.json`, 'utf8'));
    const deployed = deployments.programs?.[PROGRAM] ?? fail(`deployments/devnet.json records no ${PROGRAM}`);
    const programId = address(deployed.programId);
    const published = await pipeline.fetchStrategyMetadata(uri);
    if (!published.ok) fail(`${uri}: ${published.reason}: ${published.errors.join('; ')}`);
    if (published.warnings.length > 0) fail(`${uri} has warnings: ${published.warnings.join('; ')}`);
    console.log(`ok: ${uri} resolves and passes Pipeline's validator with zero warnings`);
    const metadata = JSON.parse(Buffer.from(await getOk(uri)).toString('utf8'));
    if (JSON.stringify(metadata.security?.audits) !== '[]') fail('security.audits is not empty');
    console.log('ok: security.audits is empty');

    const commit: string = metadata.source?.commit ?? fail('the metadata names no source.commit');
    if (commit !== deployed.commit) fail(`the metadata names ${commit}, but the last deploy is of ${deployed.commit}`);
    const reportCommit = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([0-9a-f]{40})\//.exec(metadata.conformance?.report ?? '')?.[1];
    if (!reportCommit) fail(`the conformance report ${metadata.conformance?.report} is not linked at a commit`);
    const want = repoLinks(commit, reportCommit);
    for (const [key, url] of Object.entries(want)) {
        if (metadata.links?.[key] !== url) fail(`links.${key} is ${metadata.links?.[key]}, not ${url}`);
    }
    const links: string[] = [...Object.values(metadata.links ?? {}).map(String), metadata.conformance?.report ?? fail('no conformance report')];
    for (const url of links) {
        await getOk(url);
        console.log(`ok: ${url} resolves`);
    }
    const report = await getOk(metadata.conformance.report);
    if (sha256(report) !== metadata.conformance.sha256) fail(`the report hashes to ${sha256(report)}, not ${metadata.conformance.sha256}`);
    console.log(`ok: the report's SHA-256 is ${metadata.conformance.sha256}, as the metadata says`);
    const uriCommit = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([0-9a-f]{40})\//.exec(uri)?.[1];
    fetchMain();
    for (const [what, c] of [['the deployed commit', commit], ['the report commit', reportCommit], ['the metadata URI commit', uriCommit]] as const) {
        if (!c || !onMain(c)) fail(`${what} (${c ?? 'none'}) is not a commit on origin/main`);
        console.log(`ok: ${what} ${c} is on origin/main`);
    }

    const rpc = createSolanaRpc(DEVNET_URL);
    const strategy = await rpc.getAccountInfo(await pipeline.strategyPda(programId), { encoding: 'base64' }).send();
    const registered = strategy.value && pipeline.decodeStrategy(new Uint8Array(Buffer.from(strategy.value.data[0], 'base64')));
    if (registered?.metadataUri !== uri) fail(`the router on devnet points the strategy at ${registered?.metadataUri ?? 'nothing'}`);
    console.log('ok: the router on devnet points the strategy at this URI');

    const deployedHash: string = deployed.executableHash;
    const apiStrategy = await getJson(`${API}/v1/strategies/${programId}`);
    console.log(
        `Pipeline's API: strategy metadata ${apiStrategy.metadata_status} from ${apiStrategy.metadata_url}, code hash ${apiStrategy.executable_sha256}, flags ${JSON.stringify(apiStrategy.flags)}`,
    );
    if (apiStrategy.metadata_uri !== uri || apiStrategy.metadata_status !== 'valid' || (apiStrategy.metadata_warnings ?? []).length > 0) {
        fail(`Pipeline's API has ${apiStrategy.metadata_uri} as ${apiStrategy.metadata_status} (${JSON.stringify([...(apiStrategy.metadata_errors ?? []), ...(apiStrategy.metadata_warnings ?? [])])}); it refetches metadata within minutes of a change`);
    }
    if (apiStrategy.executable_sha256 !== deployedHash) fail(`Pipeline's API sees code hash ${apiStrategy.executable_sha256}, not the deployed ${deployedHash}`);
    for (const flag of ['upgradeable', 'conformance-report']) {
        if (!(apiStrategy.flags ?? []).includes(flag)) fail(`Pipeline's API does not flag the strategy ${flag}`);
    }
    console.log('ok: the API shows the strategy, its valid metadata, the deployed code hash, and upgradeable with a conformance report');
    if (market) {
        const apiMarket = (await getJson(`${API}/v1/markets/${market}`)).market;
        if (apiMarket?.strategy_program !== programId) fail(`Pipeline's API has no tax AMM market ${market}`);
        // Each mint's flags must be exactly what the mint itself predicts, and the market's
        // must include them all (it adds its strategy's own).
        for (const mint of apiMarket.mints as { mint: string; flags: string[] | null }[]) {
            const predicted = (await predictedMintFlags(rpc, address(mint.mint))).sort();
            const shown = [...(mint.flags ?? [])].sort();
            console.log(`Pipeline's API: mint ${mint.mint} flags ${JSON.stringify(shown)}`);
            if (JSON.stringify(shown) !== JSON.stringify(predicted)) fail(`mint ${mint.mint} shows ${JSON.stringify(shown)}, but predicts ${JSON.stringify(predicted)}`);
            for (const flag of predicted) if (!(apiMarket.flags ?? []).includes(flag)) fail(`the market's flags lack its mint's ${flag}`);
        }
        console.log(`Pipeline's API: market ${market} flags ${JSON.stringify(apiMarket.flags)}`);
        console.log('ok: every mint shows exactly the trust flags the mint rules predict, and the market carries them');
    }
    console.log('\nEverything published checks out.');
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
    args: rest,
    options: { 'report-commit': { type: 'string' }, uri: { type: 'string' }, market: { type: 'string' } },
    strict: true,
});
if (command === 'pin') {
    pin(values['report-commit']);
} else if (command === 'verify') {
    await verify(values.uri ?? fail('verify needs --uri'), values.market);
} else {
    console.error('Usage: node publish.ts pin [--report-commit <commit>] | verify --uri <URI> [--market <address>]');
    process.exit(2);
}
