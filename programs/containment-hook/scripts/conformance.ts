// Pipeline's conformance checker, `pipeline-check`, run by the launch script on a contained
// token's home market while it is contained and again after its unlock (bar, "Test layers" 7).

/** The parts of a `pipeline-check-report/1` the launch script reads. */
export type ConformanceReport = {
    market: { address: string };
    checks: { id: string; status: string; message?: string }[];
};

export type ConformanceVerdict = { ok: true; passed: number; skipped: string[]; known?: string[] } | { ok: false; problems: string[] };

/** The one check a home market skips: the tax AMM refuses exact-out by design. */
const SKIPPED = 'exact_out_refund';

/**
 * The checks whose buys go into `pipeline-check`'s own trader accounts, which it writes without
 * the immutable owner extension every real Token-2022 associated token account carries: while a
 * token is contained the hook refuses those buys with `DestinationOwnerCanChange`, its error
 * 6023 (`HOOK-47`), so they fail until Pipeline's checker writes the extension. The tax AMM's
 * own 6023, `AlreadySeeded`, cannot arise in a swap, so `Custom(6023)` in a swap's failure is
 * the hook's refusal.
 */
const KNOWN_WHILE_CONTAINED = ['quote_matches_swap', 'round_trip'];
const HOOK_REFUSAL = 'Custom(6023)';

/**
 * Judges a `pipeline-check --json` report as tests/conformance.rs judges `check_market`: it
 * passes only when it is the report of `market`, `exact_out_refund` was skipped and every other
 * check passed, but for the known failures while the token is contained, which must fail and
 * only for the hook's refusal.
 */
export function judgeConformance(report: ConformanceReport, market: string, { contained = false }: { contained?: boolean } = {}): ConformanceVerdict {
    const problems: string[] = [];
    if (report.market.address !== market) problems.push(`the report is of market ${report.market.address}, not ${market}`);
    const passed = report.checks.filter((check) => check.status === 'pass').length;
    if (passed === 0) problems.push('the report has no passed checks');
    const known = contained ? KNOWN_WHILE_CONTAINED : [];
    for (const check of report.checks) {
        if (known.includes(check.id)) {
            if (check.status === 'pass') {
                problems.push(`${check.id} is pass: pipeline-check may now write the immutable owner extension, so HOOK-47's known failures can go`);
            } else if (!(check.message ?? '').includes(HOOK_REFUSAL)) {
                problems.push(`${check.id} failed for another reason than the hook refusing the checker's own account (HOOK-47): ${check.message ?? ''}`);
            }
        } else if (check.id === SKIPPED ? check.status !== 'skip' && check.status !== 'pass' : check.status !== 'pass') {
            problems.push(`${check.id} is ${check.status}: ${check.message ?? ''}`);
        }
    }
    if (report.checks.find((check) => check.id === SKIPPED)?.status !== 'skip') problems.push(`${SKIPPED} was not skipped`);
    if (problems.length > 0) return { ok: false, problems };
    return contained ? { ok: true, passed, skipped: [SKIPPED], known } : { ok: true, passed, skipped: [SKIPPED] };
}
