// Tests for the custom actions our strategies describe under `aviary_actions`.
// Run with: node --test (from this directory), or `pnpm test`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { AccountRole, address, getAddressEncoder, type Address } from '@solana/kit';
import * as pipeline from '@pipeline-placeholder/sdk';

import { AVIARY_ACTIONS_KEY, actionNamed, buildActionInstruction, findAction, parseAviaryActions } from './index.ts';

const STRATEGIES = ['tax-amm', 'buy-wall-amm', 'lending-amm'];
const metadataOf = (strategy: string) =>
    JSON.parse(readFileSync(new URL(`../../programs/${strategy}/metadata.json`, import.meta.url), 'utf8'));

test("every strategy's metadata describes its actions under aviary_actions, and Pipeline's validator has nothing to say", () => {
    for (const strategy of STRATEGIES) {
        const metadata = metadataOf(strategy);
        assert.equal(metadata.actions, undefined, `${strategy}: Pipeline 0.2 ignores and warns about "actions"`);
        const parsed = parseAviaryActions(metadata);
        assert.ok(parsed.ok, `${strategy}: ${parsed.ok ? '' : parsed.errors.join('; ')}`);
        assert.deepEqual(parsed.warnings, [], strategy);
        assert.ok(parsed.actions.length > 0, strategy);
        const pipelineParse = pipeline.parseStrategyMetadata(metadata);
        assert.ok(pipelineParse.ok, strategy);
        assert.deepEqual(pipelineParse.warnings, [], strategy);
    }
});

const ACTION = {
    name: 'set_taxes',
    label: 'Set taxes',
    kind: 'other',
    args: [
        { name: 'buy_tax_bps', type: 'u16' },
        { name: 'sell_tax_bps', type: 'u16' },
    ],
    accounts: [
        { name: 'market_state', source: 'market_state', writable: true },
        { name: 'tax_authority', source: 'wallet', signer: true },
    ],
};
const withActions = (actions: unknown) => ({ [AVIARY_ACTIONS_KEY]: actions });

test('metadata with no aviary_actions has none', () => {
    const parsed = parseAviaryActions({ name: 'x' });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.actions, []);
});

test('each malformed action is refused with the path of what is wrong', () => {
    const cases: [string, unknown, string][] = [
        ['not a list', { a: 1 }, `${AVIARY_ACTIONS_KEY}: must be an array`],
        ['a name that is not an identifier', [{ ...ACTION, name: 'set taxes' }], `${AVIARY_ACTIONS_KEY}[0].name`],
        ['a duplicate name', [ACTION, ACTION], 'duplicate action "set_taxes"'],
        ['no label', [{ ...ACTION, label: undefined }], `${AVIARY_ACTIONS_KEY}[0].label`],
        ['an unknown argument type', [{ ...ACTION, args: [{ name: 'a', type: 'u128' }] }], `${AVIARY_ACTIONS_KEY}[0].args[0].type`],
        ['a duplicate argument', [{ ...ACTION, args: [{ name: 'a', type: 'u8' }, { name: 'a', type: 'u8' }] }], 'duplicate argument "a"'],
        ['an account source that does not parse', [{ ...ACTION, accounts: [{ name: 'x', source: 'nowhere:1' }] }], `${AVIARY_ACTIONS_KEY}[0].accounts[0].source`],
        ['a PDA seed naming no argument', [{ ...ACTION, accounts: [{ name: 'x', source: 'pda:strategy:arg:missing' }] }], 'unknown argument "missing"'],
        ['a discriminator that is not 16 hex digits', [{ ...ACTION, discriminator: 'abc' }], `${AVIARY_ACTIONS_KEY}[0].discriminator`],
        ['an empty label', [{ ...ACTION, label: '' }], `${AVIARY_ACTIONS_KEY}[0].label: must not be empty`],
        ['an account with an empty name', [{ ...ACTION, accounts: [{ name: '', source: 'wallet' }] }], `${AVIARY_ACTIONS_KEY}[0].accounts[0].name: must not be empty`],
        [
            'more than 32 arguments',
            [{ ...ACTION, args: Array.from({ length: 33 }, (_, i) => ({ name: `a${i}`, type: 'u8' })) }],
            `${AVIARY_ACTIONS_KEY}[0].args: at most 32`,
        ],
        [
            'more than 64 accounts',
            [{ ...ACTION, accounts: Array.from({ length: 65 }, (_, i) => ({ name: `x${i}`, source: 'wallet' })) }],
            `${AVIARY_ACTIONS_KEY}[0].accounts: at most 64`,
        ],
    ];
    for (const [what, actions, expected] of cases) {
        const parsed = parseAviaryActions(withActions(actions));
        assert.ok(!parsed.ok, `${what}: accepted`);
        assert.ok(parsed.errors.some((error) => error.includes(expected)), `${what}: ${parsed.errors.join('; ')}`);
    }
});

test('an unknown kind is a warning, not an error', () => {
    const parsed = parseAviaryActions(withActions([{ ...ACTION, kind: 'stake' }]));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.warnings, [`${AVIARY_ACTIONS_KEY}[0].kind: unknown kind "stake"`]);
});

test('actionNamed finds an action, and names the one it cannot find', () => {
    assert.equal(actionNamed(withActions([ACTION]), 'set_taxes').label, 'Set taxes');
    assert.throws(() => actionNamed(withActions([ACTION]), 'burn'), /no aviary_actions entry named "burn"/);
    assert.throws(() => actionNamed(withActions([{ ...ACTION, name: '' }]), 'set_taxes'), /aviary_actions is invalid/);
});

test('findAction returns an action or nothing, and refuses invalid aviary_actions', () => {
    assert.equal(findAction(withActions([ACTION]), 'set_taxes')?.name, 'set_taxes');
    assert.equal(findAction(withActions([ACTION]), 'burn'), undefined);
    assert.equal(findAction({}, 'set_taxes'), undefined);
    assert.throws(() => findAction(withActions('x'), 'set_taxes'), /aviary_actions is invalid/);
});

test("an action builds into the strategy's instruction: Anchor's discriminator, the arguments in order, the accounts resolved", async () => {
    const strategyProgram = address('J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t');
    const marketState = address('BePWU3hxpLLPTgyiDbQMjC7wu5tF8Wr21jEV6rKwsew7');
    const wallet = address('9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt');
    const market: pipeline.MarketView = {
        market: address('5xzHgYdkZNxMcBMCJLgJ9ufoBAu8fmA2tEqhw9Nb6LNj'),
        strategyProgram,
        marketState,
        mints: [address('So11111111111111111111111111111111111111112'), address('2fbNTPfhgfrc5NjWUfgronTFNJyssGKrAEF3id233UM6')],
        vaults: [address('11111111111111111111111111111111'), address('11111111111111111111111111111111')],
        tokenPrograms: [address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')],
        supportsExactOut: false,
    };
    const instruction = await buildActionInstruction({
        action: actionNamed(withActions([ACTION]), 'set_taxes'),
        market,
        wallet,
        args: { buy_tax_bps: 600, sell_tax_bps: 900 },
    });
    assert.equal(instruction.programAddress, strategyProgram);
    const expected = new Uint8Array([...(await pipeline.anchorDiscriminator('set_taxes')), 0x58, 0x02, 0x84, 0x03]);
    assert.deepEqual(new Uint8Array(instruction.data!), expected);
    assert.deepEqual(instruction.accounts, [
        { address: marketState, role: AccountRole.WRITABLE },
        { address: wallet, role: AccountRole.READONLY_SIGNER },
    ]);
});

test('a given discriminator is used as is, and a missing argument is refused', async () => {
    const strategyProgram: Address = address('J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t');
    const market = { strategyProgram, marketState: strategyProgram } as unknown as pipeline.MarketView;
    const action = { ...ACTION, kind: 'other' as const, discriminator: '0102030405060708', args: [], accounts: [] };
    const built = await buildActionInstruction({ action, market, wallet: strategyProgram });
    assert.deepEqual(new Uint8Array(built.data!), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    await assert.rejects(buildActionInstruction({ action: ACTION as never, market, wallet: strategyProgram, args: {} }));
    assert.equal(getAddressEncoder().encode(strategyProgram).length, 32);
});
