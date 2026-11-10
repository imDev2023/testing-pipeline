// PROTOTYPE check: runs the validator on every sample output, as CI would run it on recorded outputs.
// Usage: node check.mjs   (exit code 1 if a draft meant to pass fails, or a draft meant to fail passes)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(join(here, f), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(read('logic.js').replace(/^export /gm, ''), ctx);
vm.runInContext(read('data.js') + '\n;globalThis.__d = { SAMPLES, PIPELINE_RULES };', ctx);
const { SAMPLES, PIPELINE_RULES } = ctx.__d;
let bad = 0;
for (const s of SAMPLES) {
  for (const [draft, out] of Object.entries(s.outputs)) {
    const r = ctx.validate({ evidence: [...s.evidence, ...PIPELINE_RULES] }, out);
    const expected = draft === 'pass';
    const words = out.summary.concat(out.claims).reduce((n, x) => n + x.text.split(/\s+/).length, 0);
    console.log(`${s.key} [${draft}] ${r.pass ? 'PASS' : 'FAIL'}  claims=${out.claims.length} unknowns=${out.unknowns.length} words=${words} injection=${JSON.stringify(r.injection)}`);
    for (const c of r.checks) for (const e of c.errors) console.log(`    ${e}`);
    if (r.pass !== expected) bad++;
  }
}
if (bad) { console.error(`${bad} draft(s) did not get the expected result`); process.exit(1); }
