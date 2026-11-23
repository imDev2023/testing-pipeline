// The freeze gate's decisions (HOOK-51; Round 2 findings R2T-07 to R2T-09 and R2-B of #74):
// which contained mints and configs it accepts before and after the freeze, how it reads the BPF
// upgradeable loader's accounts, and which recorded mints must still have their configs.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { address, getAddressEncoder, type Address } from '@solana/kit';

import { findConfigPda, findExtraAccountMetasPda, getConfigDecoder } from './client/index.ts';
import {
    BPF_UPGRADEABLE_LOADER,
    chainFacts,
    configFields,
    deploySlotOf,
    executableHash,
    freezeInstruction,
    judgeConfig,
    judgeMint,
    judgePrograms,
    MAX_UNLOCK_DEADLINE_SECS,
    mintsOfDemoRecord,
    mintsOfGateReport,
    mintsOfSnapshot,
    missingRecorded,
    missingRecordedRefusals,
    orphanValidations,
    programDataAddressOf,
    recordedMints,
    reuseByAddress,
    UNSET,
    upgradeAuthorityOf,
    VALIDATION_DATA,
    type ConfigChain,
    type ConfigFields,
} from './freeze.ts';

const HOOK = 'aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv';
const UNLOCK_PDA = 'CaDvbcDT6Aw8mXwK6ZcFPdh2UJwxJ1GGEawd2cubRL2c';
const WALLET = 'Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe';
// Any program other than the hook: SPL Token.
const OTHER_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const judge = (mintHook: Parameters<typeof judgeMint>[0]['mintHook'], unlockedAt: bigint | null) => judgeMint({ hook: HOOK, unlockPda: UNLOCK_PDA, mintHook, unlockedAt });
const refused = (verdict: ReturnType<typeof judgeMint>, reason: RegExp) => {
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, reason);
};

test('a contained mint whose hook is the hook and authority its unlock PDA passes', () => {
    assert.deepEqual(judge({ programId: HOOK, authority: UNLOCK_PDA }, null), { ok: true, state: 'contained' });
});

test('an unlocked mint with both hook fields unset passes', () => {
    assert.deepEqual(judge({ programId: UNSET, authority: UNSET }, 1_797_000_000n), { ok: true, state: 'unlocked' });
});

test('a contained mint whose hook authority was repointed is refused', () => {
    refused(judge({ programId: HOOK, authority: WALLET }, null), new RegExp(`authority is ${WALLET}, not its unlock PDA`));
});

test('a contained mint whose hook program was repointed is refused', () => {
    refused(judge({ programId: OTHER_PROGRAM, authority: UNLOCK_PDA }, null), new RegExp(`program is ${OTHER_PROGRAM}, not the hook`));
});

test('a mint cleared while its config says contained is refused', () => {
    refused(judge({ programId: UNSET, authority: UNSET }, null), /contained \(unlocked_at none\), but its transfer hook program is unset.*and its transfer hook authority is unset/);
});

test('an unlocked mint with either hook field still set is refused', () => {
    refused(judge({ programId: HOOK, authority: UNSET }, 1n), /unlocked at 1, but its transfer hook program is still/);
    refused(judge({ programId: UNSET, authority: WALLET }, 1n), new RegExp(`authority is still ${WALLET}`));
    refused(judge({ programId: HOOK, authority: UNLOCK_PDA }, 1n), /program is still.*and its transfer hook authority is still/);
});

test('a mint with no transfer hook extension is refused', () => {
    refused(judge(undefined, null), /no transfer hook extension/);
    refused(judge(undefined, 1n), /no transfer hook extension/);
});

const bytes = (value: string) => new Uint8Array(getAddressEncoder().encode(value as Address));

function loaderAccount(tag: number, body: Uint8Array) {
    const data = new Uint8Array(4 + body.length);
    new DataView(data.buffer).setUint32(0, tag, true);
    data.set(body, 4);
    return data;
}

test('the program account names its program data account', () => {
    assert.equal(programDataAddressOf(loaderAccount(2, bytes(WALLET))), WALLET);
    assert.throws(() => programDataAddressOf(loaderAccount(3, bytes(WALLET))), /not an upgradeable loader Program account/);
});

test('the program data account gives the upgrade authority, or null once frozen', () => {
    const slot = new Uint8Array(8).fill(7);
    const upgradeable = loaderAccount(3, new Uint8Array([...slot, 1, ...bytes(WALLET), 0xaa, 0xbb]));
    assert.equal(upgradeAuthorityOf(upgradeable), WALLET);
    const frozen = loaderAccount(3, new Uint8Array([...slot, 0, ...new Uint8Array(32), 0xaa]));
    assert.equal(upgradeAuthorityOf(frozen), null);
    assert.throws(() => upgradeAuthorityOf(loaderAccount(2, bytes(WALLET))), /not an upgradeable loader ProgramData account/);
    assert.throws(() => upgradeAuthorityOf(loaderAccount(3, new Uint8Array([...slot, 2, ...bytes(WALLET)]))), /option has tag 2/);
});

test('the freeze instruction is the loader SetAuthority with no new authority', () => {
    const instruction = freezeInstruction(WALLET as Address, HOOK as Address);
    assert.equal(instruction.programAddress, BPF_UPGRADEABLE_LOADER);
    assert.deepEqual([...instruction.data!], [4, 0, 0, 0]);
    assert.deepEqual(
        instruction.accounts!.map(({ address }) => address),
        [WALLET, HOOK],
    );
});

// R2T-07: what each config says, judged against the chain (judgeConfig), on a real devnet config
// from the release gate's committed fixture and on that config with each field changed.

const here = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE = join(here, '../tests/fixtures/release-gate/devnet');
// The tax AMM's id, written once in the workspace: read from the devnet deploy record.
const TAX_AMM = JSON.parse(readFileSync(join(here, '../../../deployments/devnet.json'), 'utf8')).programs['tax-amm'].programId as string;

function fixtureAccount(address: string): { owner: string; data: Uint8Array } {
    const record = JSON.parse(readFileSync(join(FIXTURE, `${address}.json`), 'utf8'));
    return { owner: record.account.owner, data: new Uint8Array(Buffer.from(record.account.data[0], 'base64')) };
}

/** The fixture's first still-contained config, decoded, with the chain facts the gate reads for it. */
async function fixtureCase(): Promise<{ config: ConfigFields; chain: ConfigChain }> {
    const configs = readdirSync(FIXTURE)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(FIXTURE, name), 'utf8')))
        .filter((record) => record.account?.owner === HOOK && record.account.space === 237)
        .map((record) => new Uint8Array(Buffer.from(record.account.data[0], 'base64')))
        .map((data) => configFields(getConfigDecoder().decode(data)))
        .filter((config) => config.unlockedAt === null);
    const config = configs[0]!;
    const market = fixtureAccount(config.market);
    const state = fixtureAccount(config.marketState);
    const validation = (await findExtraAccountMetasPda({ mint: config.mint as Address }, { programAddress: HOOK as Address }))[0];
    const chain = await chainFacts({
        hook: HOOK as Address,
        taxAmm: TAX_AMM as Address,
        mint: config.mint as Address,
        market: { owner: market.owner, data: market.data },
        marketStateOwner: state.owner,
        validationData: fixtureAccount(validation).data,
    });
    return { config, chain };
}

test('a real devnet config agrees with the chain', async () => {
    const { config, chain } = await fixtureCase();
    assert.deepEqual(judgeConfig(config, chain), []);
});

test('the validation data is the hook VALIDATION_DATA, as devnet holds it', async () => {
    const { chain } = await fixtureCase();
    assert.deepEqual([...chain.validationData!], [...VALIDATION_DATA]);
    assert.equal(VALIDATION_DATA.length, 51);
});

const changed = async (change: (c: ConfigFields, chain: ConfigChain) => void, problem: RegExp) => {
    const { config, chain } = await fixtureCase();
    change(config, chain);
    const problems = judgeConfig(config, chain);
    assert.ok(problems.some((p) => problem.test(p)), `expected ${problem} in ${JSON.stringify(problems)}`);
};

test('a config whose fee account is not the market fee account is refused', () => changed((c) => (c.feeAccount = WALLET), /fee account .* not the market's fee account/));
test('a config whose vault is not the market vault is refused', () => changed((c) => (c.vault = WALLET), /vault .* not the vault the Market records/));
test('a config whose market state is not the Market one is refused', () => changed((c) => (c.marketState = WALLET), /market state .* not the one the Market records/));
test('a config whose quote mint is not the market other mint is refused', () => changed((c) => (c.quoteMint = WALLET), /quote mint .* not the Market's other mint/));
test('a config whose market does not trade its mint is refused', () => changed((c) => (c.mint = WALLET), /does not trade the mint/));
test('a market not owned by the router is refused', () => changed((_, chain) => (chain.marketOwner = WALLET), /not owned by the router/));
test('a market that is not a router Market is refused', () => changed((_, chain) => (chain.market = null), /not a router Market/));
test('a market off its PDA is refused', () => changed((_, chain) => (chain.marketPda = WALLET), /not at its PDA/));
test('a market on another strategy than the tax AMM is refused (R2T-08)', () => changed((_, chain) => (chain.taxAmm = WALLET), /runs on .* not the tax AMM/));
test('a market state not owned by the tax AMM is refused (R2T-08)', () => changed((_, chain) => (chain.marketStateOwner = WALLET), /market state is owned by .* not the tax AMM/));
test('a zero goal is refused', () => changed((c) => (c.unlockGoal = 0n), /unlock goal is 0/));
test('a deadline past 90 days after the binding is refused', () => changed((c) => (c.unlockDeadline = c.boundAt + MAX_UNLOCK_DEADLINE_SECS + 1n), /deadline .* more than MAX_UNLOCK_DEADLINE_SECS/));
test('a deadline at or before the binding is refused', () => changed((c) => (c.unlockDeadline = c.boundAt), /deadline .* not after the binding/));
test('a deadline exactly 90 days after the binding passes', async () => {
    const { config, chain } = await fixtureCase();
    config.unlockDeadline = config.boundAt + MAX_UNLOCK_DEADLINE_SECS;
    assert.deepEqual(judgeConfig(config, chain), []);
});
test('an unlock time before the binding is refused', () => changed((c) => (c.unlockedAt = c.boundAt - 1n), /unlocked at .* before the binding/));
test('a config of another version is refused', () => changed((c) => (c.version = 2), /version 2/));
test('a non-canonical bump is refused', async () => {
    await changed((c) => (c.configBump = (c.configBump + 1) % 256), /config bump/);
    await changed((c) => (c.extraAccountMetasBump = (c.extraAccountMetasBump + 1) % 256), /validation account bump/);
    await changed((c) => (c.unlockBump = (c.unlockBump + 1) % 256), /unlock bump/);
});
test('a validation account other than the canonical list is refused', async () => {
    await changed((_, chain) => (chain.validationData = Uint8Array.from(VALIDATION_DATA, (b, i) => (i === 50 ? 1 : b))), /validation account's data is not the hook's VALIDATION_DATA/);
    await changed((_, chain) => (chain.validationData = null), /no validation account/);
});

// R2T-08: the executable hash and the deploy slot read from a program data account.

test('the executable hash is the SHA-256 of the program after the header, trailing zeros trimmed', () => {
    const header = loaderAccount(3, new Uint8Array([...new Uint8Array(8).fill(9), 1, ...bytes(WALLET)]));
    assert.equal(header.length, 45);
    const programData = new Uint8Array([...header, ...new TextEncoder().encode('abc'), 0, 0, 0, 0]);
    // printf abc | shasum -a 256
    assert.equal(executableHash(programData), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(deploySlotOf(programData), 0x0909090909090909n);
    assert.throws(() => executableHash(loaderAccount(2, bytes(WALLET))), /not an upgradeable loader ProgramData account/);
});

// R2T-09: the two programs are frozen together or not at all.

test('judgePrograms accepts both upgradeable or both frozen, and refuses a half-frozen pair', () => {
    const programs = (hook: string | null, taxAmm: string | null) => [
        { name: 'containment hook', authority: hook },
        { name: 'tax AMM', authority: taxAmm },
    ];
    assert.deepEqual(judgePrograms(programs(WALLET, WALLET)), { ok: true, frozen: false });
    assert.deepEqual(judgePrograms(programs(null, null)), { ok: true, frozen: true });
    const half = judgePrograms(programs(null, WALLET));
    assert.equal(half.ok, false);
    assert.match((half as { reason: string }).reason, /the containment hook is frozen but the tax AMM is still upgradeable/);
    const otherHalf = judgePrograms(programs(WALLET, null));
    assert.match((otherHalf as { reason: string }).reason, /the tax AMM is frozen but the containment hook is still upgradeable/);
});

// R2-B: every contained mint ever recorded still has its config.

test('recorded mints are gathered from every record and named by where they came from', () => {
    const recorded = recordedMints([
        { source: 'a.json', mints: [WALLET, HOOK] },
        { source: 'b.json', mints: [WALLET] },
    ]);
    assert.deepEqual(recorded.get(WALLET), ['a.json', 'b.json']);
    assert.deepEqual(recorded.get(HOOK), ['a.json']);
});

test('a recorded mint with no config in the census is refused, naming it and its records', () => {
    const recorded = recordedMints([{ source: 'deployments/devnet-demo-containment-hook.json', mints: [WALLET, HOOK] }]);
    assert.deepEqual(missingRecorded(recorded, new Set([HOOK])), [
        { mint: WALLET, message: `mint ${WALLET}, recorded in deployments/devnet-demo-containment-hook.json, has no config in the census` },
    ]);
    assert.deepEqual(missingRecorded(recorded, new Set([HOOK, WALLET])), []);
    // Zero configs while records list contained tokens is a refusal per mint.
    assert.equal(missingRecorded(recorded, new Set()).length, 2);
});

test('a recorded mint with no config gives a refusal naming its config PDA, not a throw', async () => {
    // The refusal's text has a comma after the mint; the gate once took the mint back out of it
    // with split(' ')[1], so findConfigPda threw on "<mint>," and every refusal was lost.
    const recorded = recordedMints([
        { source: 'a.json', mints: [WALLET] },
        { source: 'b.json', mints: [WALLET, 'not-a-mint'] },
    ]);
    const [configPda] = await findConfigPda({ mint: address(WALLET) }, { programAddress: address(HOOK) });
    const asked: Address[] = [];
    const refusals = await missingRecordedRefusals(recorded, new Set(), address(HOOK), async (pda) => {
        asked.push(pda);
        return false;
    });
    assert.deepEqual(asked, [configPda]);
    assert.deepEqual(refusals, [
        `mint ${WALLET}, recorded in a.json and b.json, has no config in the census (its config PDA ${configPda} does not exist)`,
        'mint not-a-mint, recorded in b.json, has no config in the census (and is not an address, so it has no config PDA)',
    ]);
    const found = await missingRecordedRefusals(recordedMints([{ source: 'a.json', mints: [WALLET] }]), new Set(), address(HOOK), async () => true);
    assert.deepEqual(found, [`mint ${WALLET}, recorded in a.json, has no config in the census (its config PDA ${configPda} exists, so the census missed it)`]);
});

test('the records give their mints: the demo record, a release gate report and the fixture', () => {
    assert.deepEqual(mintsOfDemoRecord({ record: [['mint', WALLET], ['market', HOOK], ['token 1', 'x'], ['mint', OTHER_PROGRAM]] }), [WALLET, OTHER_PROGRAM]);
    assert.deepEqual(mintsOfGateReport({ configs: [{ mint: WALLET }, { mint: null }, { mint: HOOK }] }), [WALLET, HOOK]);
    const fixtureMints = mintsOfSnapshot(
        readdirSync(FIXTURE).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(FIXTURE, name), 'utf8'))),
        HOOK,
    );
    assert.equal(fixtureMints.length, 6);
    const demo = mintsOfDemoRecord(JSON.parse(readFileSync(join(here, '../../../deployments/devnet-demo-containment-hook.json'), 'utf8')));
    assert.equal(demo.length, 3);
    for (const mint of demo) assert.ok(fixtureMints.includes(mint), `${mint} is in the fixture`);
});

// The census: a validation account is an orphan only when no config's mint derives it.

test("a refused config's validation account is not also reported as an orphan", () => {
    const [refusedConfigs, accepted, orphan] = ['Va1idation1111111111111111111111111111111111', 'Va1idation2222222222222222222222222222222222', 'Va1idation3333333333333333333333333333333333'];
    // The census holds three validation accounts; the configs' mints derive the first two,
    // one of a config the gate refused early (its version, its address), one it accepted.
    assert.deepEqual(orphanValidations(new Set([orphan, accepted, refusedConfigs]), [refusedConfigs, accepted]), [orphan]);
    assert.deepEqual(orphanValidations(new Set([accepted]), [accepted]), []);
});

// --freeze: the payer may be one of the authorities, and kit refuses two signer objects with
// one address, so the payer reuses the authority's.

test('a payer naming an authority reuses its signer', () => {
    const authority = { address: WALLET, from: '--authority' };
    const other = { address: HOOK, from: '--authority' };
    const samePayer = { address: WALLET, from: '--payer' };
    assert.equal(reuseByAddress(samePayer, [other, authority]), authority);
    const ownPayer = { address: UNLOCK_PDA, from: '--payer' };
    assert.equal(reuseByAddress(ownPayer, [other, authority]), ownPayer);
});
