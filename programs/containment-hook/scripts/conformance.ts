// Pipeline's conformance checker, `pipeline-check`, run by the launch script on a contained
// token's home market while it is contained and again after its unlock (bar, "Test layers" 7).

/** The parts of a `pipeline-check-report/1` the launch script reads. */
export type ConformanceReport = {
    market: { address: string };
    checks: { id: string; status: string; message?: string; details?: Record<string, unknown> }[];
};

export type ConformanceVerdict = { ok: true; passed: number; skipped: string[]; known?: string[] } | { ok: false; problems: string[] };

/** The one check a home market skips: the tax AMM refuses exact-out by design. */
const SKIPPED = 'exact_out_refund';

/**
 * The checks whose buys go into `pipeline-check`'s own trader accounts, which it writes without
 * the immutable owner extension every real Token-2022 associated token account carries: while a
 * token is contained the hook refuses those buys with `DestinationOwnerCanChange`, its error
 * 6023 (`HOOK-47`), so they fail until Pipeline's checker writes the extension. The checker's
 * failure text names the error number, not the program that raised it, and 6023 is also the
 * router's `SetupPayerMisused` and the buy wall AMM's `ExactOutNotSupported`; so `Custom(6023)`
 * counts as the hook's refusal only with the launch script's own evidence, as Canary requires
 * (R2T-10): a simulated router buy of the token into an account written as the checker writes
 * its own, which the logs show the containment hook failing with `DestinationOwnerCanChange`.
 */
const KNOWN_WHILE_CONTAINED = ['quote_matches_swap', 'round_trip'];
const HOOK_REFUSAL = 'Custom(6023)';

/** What the launch script knows of the market it judges a report of. */
export type ConformanceContext = {
    /** The token is contained, so its hook runs on every transfer of it. */
    contained?: boolean;
    /**
     * The launch script's own simulated buy into an account without the immutable owner extension
     * showed the containment hook itself failing with `DestinationOwnerCanChange` on this market.
     */
    hookRefusalShown?: boolean;
};

/**
 * Judges a `pipeline-check --json` report as tests/conformance.rs judges `check_market`: it
 * passes only when it is the report of `market`, `exact_out_refund` was skipped and every other
 * check passed, but for the known failures while the token is contained, which must fail, only
 * with error 6023, and only once the hook was shown raising it (`hookRefusalShown`).
 */
export function judgeConformance(report: ConformanceReport, market: string, { contained = false, hookRefusalShown = false }: ConformanceContext = {}): ConformanceVerdict {
    const problems: string[] = [];
    if (report.market.address !== market) problems.push(`the report is of market ${report.market.address}, not ${market}`);
    const passed = report.checks.filter((check) => check.status === 'pass').length;
    if (passed === 0) problems.push('the report has no passed checks');
    const known = contained ? KNOWN_WHILE_CONTAINED : [];
    for (const check of report.checks) {
        if (known.includes(check.id)) {
            if (check.status === 'pass') {
                problems.push(`${check.id} is pass: pipeline-check may now write the immutable owner extension, so HOOK-47's known failures can go`);
            } else {
                const other = otherFailure(check);
                if (other !== undefined) problems.push(`${check.id} failed for another reason than the hook refusing the checker's own account (HOOK-47): ${other}`);
                else if (!hookRefusalShown) {
                    problems.push(
                        `${check.id} failed with ${HOOK_REFUSAL}, but the containment hook was not shown raising it on this market: 6023 is also the router's SetupPayerMisused and the buy wall AMM's ExactOutNotSupported (HOOK-47)`,
                    );
                }
            }
        } else if (check.id === SKIPPED ? check.status !== 'skip' && check.status !== 'pass' : check.status !== 'pass') {
            problems.push(`${check.id} is ${check.status}: ${check.message ?? ''}`);
        }
    }
    if (report.checks.find((check) => check.id === SKIPPED)?.status !== 'skip') problems.push(`${SKIPPED} was not skipped`);
    if (problems.length > 0) return { ok: false, problems };
    return contained ? { ok: true, passed, skipped: [SKIPPED], known } : { ok: true, passed, skipped: [SKIPPED] };
}

/**
 * The first failure of a known check that is not the hook's refusal, or `undefined` when every
 * swap of `quote_matches_swap` that did not match, and every trip of `round_trip` that errored,
 * failed with it: its message names only the first, so a real mismatch could hide behind it.
 */
function otherFailure(check: ConformanceReport['checks'][number]): string | undefined {
    const [rows, failed] =
        check.id === 'quote_matches_swap'
            ? (['swaps', (row: { matched?: boolean }) => row.matched === false] as const)
            : (['trips', (row: { error?: unknown }) => row.error != null] as const);
    const list = check.details?.[rows];
    if (!Array.isArray(list)) return `no ${rows} in its details`;
    const failures = (list as { matched?: boolean; error?: unknown }[]).filter(failed);
    if (failures.length === 0) return 'no failed swap in its details';
    const other = failures.find((row) => !String(row.error ?? '').includes(HOOK_REFUSAL));
    return other === undefined ? undefined : JSON.stringify(other);
}
