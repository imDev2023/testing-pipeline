// How the launch script reads each token's terms from its flags: the nth `--goal`, `--deadline`,
// `--unlock` and `--quote-mint` are the nth token's.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTokens, UsageError, WRAPPED_SOL } from './args.ts';

const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

test('one --goal and --deadline launch one token against wrapped SOL, left contained', () => {
    assert.deepEqual(parseTokens({ goal: ['5000000000'], deadline: ['2026-12-12T07:58:31Z'] }), [
        { unlockGoal: 5_000_000_000n, unlockDeadline: 1_797_062_311n, unlockBy: undefined, quoteMint: WRAPPED_SOL },
    ]);
});

test('each token takes its own --unlock and --quote-mint, and "none" leaves a token contained', () => {
    const tokens = parseTokens({
        goal: ['5000000000', '100000000', '50000'],
        deadline: ['1797000000', '1797086400', '1797086400'],
        unlock: ['deadline', 'goal', 'none'],
        quoteMint: [WRAPPED_SOL, WRAPPED_SOL, 'new'],
    });
    assert.deepEqual(
        tokens.map(({ unlockBy, quoteMint }) => [unlockBy, quoteMint]),
        [
            ['deadline', WRAPPED_SOL],
            ['goal', WRAPPED_SOL],
            [undefined, 'new'],
        ],
    );
});

test('one --quote-mint applies to every token', () => {
    const tokens = parseTokens({ goal: ['1', '2'], deadline: ['1797000000', '1797000000'], quoteMint: [USDC_DEVNET] });
    assert.deepEqual(
        tokens.map(({ quoteMint }) => quoteMint),
        [USDC_DEVNET, USDC_DEVNET],
    );
});

test('flags that do not pair up with the tokens are refused', () => {
    const refused = (flags: Parameters<typeof parseTokens>[0], message: RegExp) => assert.throws(() => parseTokens(flags), (error) => error instanceof UsageError && message.test(error.message));
    refused({}, /--goal is required/);
    refused({ goal: ['1'] }, /--deadline is required/);
    refused({ goal: ['1'], deadline: ['1797000000', '1797000000'] }, /one --goal for each --deadline/);
    refused({ goal: ['1', '2'], deadline: ['1797000000', '1797000000'], unlock: ['goal'] }, /--unlock for every token or for none/);
    refused({ goal: ['1'], deadline: ['1797000000'], unlock: ['soon'] }, /--unlock must be goal, deadline or none/);
    refused({ goal: ['1', '2', '3'], deadline: ['1797000000', '1797000000', '1797000000'], quoteMint: ['new', 'new'] }, /--quote-mint once for every token, or once for each/);
    refused({ goal: ['1'], deadline: ['1797000000'], quoteMint: ['not-an-address'] }, /--quote-mint must be an address or "new"/);
    refused({ goal: ['1.5'], deadline: ['1797000000'] }, /--goal must be a whole number/);
    refused({ goal: ['18446744073709551616'], deadline: ['1797000000'] }, /--goal must fit in a u64/);
    refused({ goal: ['1'], deadline: ['2026-12-12T07:58:31'] }, /time zone/);
    refused({ goal: ['1'], deadline: ['99999999999999'] }, /--deadline is too far away to be a time/);
});
