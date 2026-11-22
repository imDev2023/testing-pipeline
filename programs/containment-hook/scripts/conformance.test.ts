// What the launch script accepts from `pipeline-check` on a home market (bar, "Test layers" 7),
// judged as tests/conformance.rs judges `check_market` in LiteSVM.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { judgeConformance } from './conformance.ts';

// A real report: the tax AMM's demo market on devnet, checked on 2026-11-20.
const report = JSON.parse(readFileSync(new URL('../../tax-amm/conformance/devnet.json', import.meta.url), 'utf8'));
const market = report.market.address as string;

function withCheck(id: string, status: string) {
    return { ...report, checks: report.checks.map((check: { id: string }) => (check.id === id ? { ...check, status, message: `${id} went ${status}` } : check)) };
}

test('a report with every check passed but exact_out_refund skipped passes', () => {
    assert.deepEqual(judgeConformance(report, market), { ok: true, passed: 13, skipped: ['exact_out_refund'] });
});

test('a warn or a fail is refused, naming the check and its message', () => {
    assert.deepEqual(judgeConformance(withCheck('round_trip', 'warn'), market), {
        ok: false,
        problems: ['round_trip is warn: round_trip went warn'],
    });
    assert.deepEqual(judgeConformance(withCheck('mint_extensions', 'fail'), market), {
        ok: false,
        problems: ['mint_extensions is fail: mint_extensions went fail'],
    });
});

test("another market's report is refused", () => {
    const other = 'FJ1PJovxT4Njfn3fkufxcKeCF8XtsPRAFLKadZZYXgDB';
    assert.deepEqual(judgeConformance(report, other), {
        ok: false,
        problems: [`the report is of market ${market}, not ${other}`],
    });
});

test('a report with no checks, or with exact_out_refund run, is refused', () => {
    assert.deepEqual(judgeConformance({ ...report, checks: [] }, market), {
        ok: false,
        problems: ['the report has no passed checks', 'exact_out_refund was not skipped'],
    });
    assert.deepEqual(judgeConformance(withCheck('exact_out_refund', 'pass'), market), {
        ok: false,
        problems: ['exact_out_refund was not skipped'],
    });
});
