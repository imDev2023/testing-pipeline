// Pipeline's conformance checker, `pipeline-check`, run by the launch script on a contained
// token's home market while it is contained and again after its unlock (bar, "Test layers" 7).

/** The parts of a `pipeline-check-report/1` the launch script reads. */
export type ConformanceReport = {
    market: { address: string };
    checks: { id: string; status: string; message?: string }[];
};

export type ConformanceVerdict = { ok: true; passed: number; skipped: string[] } | { ok: false; problems: string[] };

/** The one check a home market skips: the tax AMM refuses exact-out by design. */
const SKIPPED = 'exact_out_refund';

/**
 * Judges a `pipeline-check --json` report as tests/conformance.rs judges `check_market`: it
 * passes only when it is the report of `market`, `exact_out_refund` was skipped and every other
 * check passed.
 */
export function judgeConformance(report: ConformanceReport, market: string): ConformanceVerdict {
    const problems: string[] = [];
    if (report.market.address !== market) problems.push(`the report is of market ${report.market.address}, not ${market}`);
    const passed = report.checks.filter((check) => check.status === 'pass').length;
    if (passed === 0) problems.push('the report has no passed checks');
    for (const check of report.checks) {
        if (check.id === SKIPPED ? check.status !== 'skip' && check.status !== 'pass' : check.status !== 'pass') {
            problems.push(`${check.id} is ${check.status}: ${check.message ?? ''}`);
        }
    }
    if (report.checks.find((check) => check.id === SKIPPED)?.status !== 'skip') problems.push(`${SKIPPED} was not skipped`);
    return problems.length > 0 ? { ok: false, problems } : { ok: true, passed, skipped: [SKIPPED] };
}
