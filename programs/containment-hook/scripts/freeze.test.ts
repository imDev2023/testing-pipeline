// The freeze gate's decisions (HOOK-51): which contained mints it accepts before and after the
// freeze, and how it reads the BPF upgradeable loader's accounts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getAddressEncoder, type Address } from '@solana/kit';

import { BPF_UPGRADEABLE_LOADER, freezeInstruction, judgeMint, programDataAddressOf, UNSET, upgradeAuthorityOf } from './freeze.ts';

const HOOK = 'aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv';
const UNLOCK_PDA = 'CaDvbcDT6Aw8mXwK6ZcFPdh2UJwxJ1GGEawd2cubRL2c';
const WALLET = 'Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe';
const OTHER_PROGRAM = 'J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t';

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
