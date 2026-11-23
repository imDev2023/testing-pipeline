// How the runner reads a failed transaction (src/chain.ts): the custom error code, the
// instruction that failed and the program that raised the code, which for a failure inside a
// cross-program call is the called program (SUITE-62).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resultOf } from '../src/chain.ts';

const LENDING_AMM = 'Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG';
const KLEND = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';

test("a refusal raised by the transaction's own instruction names that program", () => {
    const result = resultOf({ InstructionError: [1, { Custom: 6034 }] }, [
        `Program ${KLEND} invoke [1]`,
        `Program ${KLEND} success`,
        `Program ${LENDING_AMM} invoke [1]`,
        'Program log: AnchorError occurred. Error Code: WithinBand. Error Number: 6034.',
        `Program ${LENDING_AMM} failed: custom program error: 0x1792`,
    ]);
    assert.deepEqual([result.failed, result.customError, result.failedInstruction, result.refusedBy], [true, 6034, 1, LENDING_AMM]);
});

test('a refusal raised inside a cross-program call names the called program, though the transaction error names the caller', () => {
    const result = resultOf({ InstructionError: [1, { Custom: 6034 }] }, [
        `Program ${LENDING_AMM} invoke [1]`,
        `Program ${KLEND} invoke [2]`,
        `Program ${KLEND} failed: custom program error: 0x1792`,
        `Program ${LENDING_AMM} failed: custom program error: 0x1792`,
    ]);
    assert.deepEqual([result.customError, result.failedInstruction, result.refusedBy], [6034, 1, KLEND]);
});

test('a transaction that did not fail names nobody', () => {
    assert.deepEqual([resultOf(null, [`Program ${LENDING_AMM} success`]).refusedBy, resultOf(null, []).failedInstruction], [null, null]);
});
