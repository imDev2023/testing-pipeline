// What the launch script accepts from `pipeline-check` on a home market (bar, "Test layers" 7),
// judged as tests/conformance.rs judges `check_market` in LiteSVM.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { judgeConformance } from './conformance.ts';

// A real report: one of the launch script's own, on a contained token's home market on devnet
// (conformance/devnet/, written with --conformance-out), whichever run wrote them last.
const reports = new URL('../conformance/devnet/', import.meta.url);
const reportFile = readdirSync(reports).filter((name) => name.endsWith('.json')).sort()[0];
assert.ok(reportFile, 'conformance/devnet/ holds no report');
const report = JSON.parse(readFileSync(new URL(reportFile, reports), 'utf8'));
const market = report.market.address as string;

function withCheck(id: string, status: string) {
    return { ...report, checks: report.checks.map((check: { id: string }) => (check.id === id ? { ...check, status, message: `${id} went ${status}` } : check)) };
}

test('a report with every check passed but exact_out_refund skipped passes', () => {
    const passed = report.checks.filter((check: { status: string }) => check.status === 'pass').length;
    assert.ok(passed > 0);
    assert.deepEqual(judgeConformance(report, market), { ok: true, passed, skipped: ['exact_out_refund'] });
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

// While a token is contained, pipeline-check's own traders' accounts lack the immutable owner
// extension every real associated token account has, so the hook refuses their buys and two
// checks fail with its DestinationOwnerCanChange (6023) until Pipeline's checker writes the
// extension (HOOK-47); after the unlock the hook no longer runs and every check must pass.
const refusal = 'InstructionError(1, Custom(6023)): the hook refused the checker\'s account';
function failingDetails(id: string, errors: string[]) {
    return id === 'quote_matches_swap'
        ? { swaps: errors.map((error) => ({ case: 'a buy', matched: false, error })).concat([{ case: 'a sell', matched: true, error: null } as never]) }
        : { trips: errors.map((error) => ({ route: '1→0→1', error })).concat([{ route: '0→1→0', error: null } as never]) };
}
const refusedWith = (errors: Record<string, string[]>) => ({
    ...report,
    checks: report.checks.map((check: { id: string }) =>
        check.id in errors ? { ...check, status: 'fail', message: `${check.id}: ${errors[check.id]![0]}`, details: failingDetails(check.id, errors[check.id]!) } : check,
    ),
});
const bothRefused = refusedWith({ quote_matches_swap: [refusal], round_trip: [refusal] });

test("on a contained market, the checker's two known failures pass when they fail for the hook's refusal", () => {
    const passed = bothRefused.checks.filter((check: { status: string }) => check.status === 'pass').length;
    assert.deepEqual(judgeConformance(bothRefused, market, { contained: true }), {
        ok: true,
        passed,
        skipped: ['exact_out_refund'],
        known: ['quote_matches_swap', 'round_trip'],
    });
});

test('on a contained market, a known check failing for another reason, or passing, is refused', () => {
    // A second swap failing for another reason, behind a first one the hook refused.
    const hidden = refusedWith({ quote_matches_swap: [refusal], round_trip: [refusal, 'InstructionError(0, Custom(6002))'] });
    const verdict = judgeConformance(hidden, market, { contained: true });
    assert.equal(verdict.ok, false);
    assert.match((verdict as { problems: string[] }).problems[0]!, /^round_trip failed for another reason .*Custom\(6002\)/);
    const onlyOne = refusedWith({ quote_matches_swap: [refusal] });
    assert.deepEqual(judgeConformance(onlyOne, market, { contained: true }), {
        ok: false,
        problems: ['round_trip is pass: pipeline-check may now write the immutable owner extension, so HOOK-47\'s known failures can go'],
    });
});

test('after the unlock, the known failures are failures again', () => {
    assert.equal(judgeConformance(bothRefused, market, { contained: false }).ok, false);
});
