// Tests for scripts/decisions.mjs. Run with: node --test scripts/decisions.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkTargets, headingAnchor, headingsOf, parseDecisions } from './decisions.mjs';

const script = fileURLToPath(new URL('./decisions.mjs', import.meta.url));
const ISSUE = 'https://github.com/imDev2023/testing-pipeline/issues/19';

function block(overrides = {}, id = 'TAX-01') {
  const fields = {
    Question: 'What is the highest tax?',
    Answer: '10%, the constant `MAX_TAX_BPS`.',
    Alternatives: 'None recorded.',
    'Specified in': '[`docs/spec/tax-amm.md`, Constants](spec/tax-amm.md#constants)',
    'Changes by': 'build-time constant',
    Status: 'default',
    Decided: `2026-11-10 in [Tax AMM rules](${ISSUE})`,
    ...overrides,
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `- ${label}: ${value}`);
  return [`### ${id}: A title`, '', ...lines, ''].join('\n');
}

const register = (...blocks) => ['# Decision register', '', '## Tax AMM (TAX)', '', ...blocks].join('\n');
const messages = (markdown) => parseDecisions(markdown).problems.map((problem) => problem.message);

test('a well-formed block parses into every field', () => {
  const { decisions, problems } = parseDecisions(register(block()));
  assert.deepEqual(problems, []);
  assert.equal(decisions.length, 1);
  const [decision] = decisions;
  assert.equal(decision.id, 'TAX-01');
  assert.equal(decision.product, 'TAX');
  assert.equal(decision.title, 'A title');
  assert.equal(decision.question, 'What is the highest tax?');
  assert.equal(decision.changesBy, 'build-time constant');
  assert.equal(decision.status, 'default');
  assert.equal(decision.statusDate, null);
  assert.deepEqual(decision.specifiedIn, {
    kind: 'file',
    file: 'docs/spec/tax-amm.md',
    section: 'Constants',
    href: 'spec/tax-amm.md#constants',
  });
  assert.deepEqual(decision.decided, { date: '2026-11-10', ticket: 'Tax AMM rules', url: ISSUE });
});

test('a section heading that holds backticks and brackets is kept whole', () => {
  const value = '[`docs/spec/containment-hook.md`, Unlock (`unlock`)](spec/containment-hook.md#unlock-unlock)';
  const { decisions, problems } = parseDecisions(register(block({ 'Specified in': value })));
  assert.deepEqual(problems, []);
  assert.equal(decisions[0].specifiedIn.section, 'Unlock (`unlock`)');
  assert.equal(decisions[0].specifiedIn.href, 'spec/containment-hook.md#unlock-unlock');
});

test('the map and an open ticket are accepted as places', () => {
  const map = '[the map, Notes](https://github.com/imDev2023/testing-pipeline/issues/1)';
  const ticket = '[the ticket, Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45)';
  const parsed = parseDecisions(
    register(block({ 'Specified in': map }), block({ 'Specified in': ticket }, 'TAX-02')),
  );
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(
    parsed.decisions.map((decision) => decision.specifiedIn.kind),
    ['map', 'ticket'],
  );
  assert.equal(parsed.decisions[1].specifiedIn.section, 'Keeper runner');
});

test('"the map" must be the map, and "the ticket" must not be', () => {
  const wrongMap = '[the map, Notes](https://github.com/imDev2023/testing-pipeline/issues/45)';
  const mapAsTicket = '[the ticket, Notes](https://github.com/imDev2023/testing-pipeline/issues/1)';
  assert.match(messages(register(block({ 'Specified in': wrongMap })))[0], /"the map" must link to/);
  assert.match(messages(register(block({ 'Specified in': mapAsTicket })))[0], /"the ticket" must link to/);
});

test('confirmed and changed carry their date, and default carries none', () => {
  const parsed = parseDecisions(
    register(block({ Status: 'confirmed 2026-11-09' }), block({ Status: 'changed 2026-12-01' }, 'TAX-02')),
  );
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(
    parsed.decisions.map((decision) => [decision.status, decision.statusDate]),
    [
      ['confirmed', '2026-11-09'],
      ['changed', '2026-12-01'],
    ],
  );
  assert.match(messages(register(block({ Status: 'changed' })))[0], /needs its date/);
  assert.match(messages(register(block({ Status: 'default 2026-11-10' })))[0], /takes no date/);
  assert.match(messages(register(block({ Status: 'agreed' })))[0], /"Status" must be/);
});

test('a missing field is reported, and the block is left out', () => {
  const parsed = parseDecisions(register(block({ Alternatives: null })));
  assert.equal(parsed.decisions.length, 0);
  assert.ok(parsed.problems.some((problem) => /missing "Alternatives"/.test(problem.message)));
});

test('fields out of order, repeated or unknown are reported', () => {
  const swapped = ['### TAX-01: A title', '', '- Answer: Ten.', '- Question: What?', ''].join('\n');
  assert.ok(messages(register(swapped)).some((message) => /"Answer" is out of order/.test(message)));

  const repeated = block().replace('- Answer: 10%, the constant `MAX_TAX_BPS`.', '- Question: Again?');
  assert.ok(messages(register(repeated)).some((message) => /"Question" appears twice/.test(message)));

  const stray = block().replace('- Status: default', '- Status: default\n- Owner: someone');
  assert.ok(messages(register(stray)).some((message) => /expected one of the seven fields/.test(message)));
});

test('a value outside the allowed list is reported', () => {
  assert.match(messages(register(block({ 'Changes by': 'a config file' })))[0], /"Changes by" must be one of/);
  assert.match(messages(register(block({ Question: 'Not a question.' })))[0], /must end with "\?"/);
  assert.match(messages(register(block({ Answer: 'No full stop' })))[0], /"Answer" must be a sentence/);
  assert.match(messages(register(block({ Decided: 'yesterday' })))[0], /"Decided" must be/);
  assert.match(messages(register(block({ 'Specified in': 'docs/spec/tax-amm.md' })))[0], /must be one link/);
});

test('IDs are unique, run in order with no gaps, and sit in their own section', () => {
  assert.ok(messages(register(block(), block())).some((message) => /already used on line/.test(message)));
  assert.ok(messages(register(block(), block({}, 'TAX-03'))).some((message) => /expected TAX-02/.test(message)));
  assert.ok(
    messages(register(block({}, 'HOOK-01'))).some((message) => /belongs in the HOOK section, not TAX/.test(message)),
  );
  const outside = ['# Decision register', '', block()].join('\n');
  assert.ok(messages(outside).some((message) => /outside a product section/.test(message)));
});

test('a "###" heading that is not a decision, and an unknown prefix, are reported', () => {
  assert.ok(messages(register('### Notes', '')).some((message) => /must be a decision/.test(message)));
  const unknown = ['## Mystery (ODD)', '', block({}, 'ODD-01')].join('\n');
  assert.ok(messages(unknown).some((message) => /unknown product prefix "ODD"/.test(message)));
});

test('a block inside a code fence is an example, not a decision', () => {
  const markdown = ['# Decision register', '', '```markdown', block(), '```', '', '## Tax AMM (TAX)', '', block()].join(
    '\n',
  );
  const parsed = parseDecisions(markdown);
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.decisions.length, 1);
});

test('follow-ups are read as one string each, with their continuation lines', () => {
  const markdown = [
    register(block()),
    '## Follow-ups',
    '',
    'Prose before the list is ignored.',
    '',
    '- `TAX-01`: first.',
    '  Second sentence.',
    '- Another.',
    '',
  ].join('\n');
  assert.deepEqual(parseDecisions(markdown).followUps, ['`TAX-01`: first. Second sentence.', 'Another.']);
});

test('headings get the anchors GitHub gives them', () => {
  assert.equal(headingAnchor('Unlock (`unlock`)'), 'unlock-unlock');
  assert.equal(headingAnchor("Kamino's losses fall on LPs"), 'kaminos-losses-fall-on-lps');
  assert.equal(headingAnchor('What counts as "a buyer could not sell back"'), 'what-counts-as-a-buyer-could-not-sell-back');
  assert.equal(headingAnchor('The prompt, version `explainer-v0`'), 'the-prompt-version-explainer-v0');
  assert.equal(headingAnchor('See [the map](https://example.com) first'), 'see-the-map-first');
  const headings = headingsOf(['# Title', '## Accounts', '```', '## Not a heading', '```', '### Accounts'].join('\n'));
  assert.deepEqual(
    headings.map((heading) => heading.anchor),
    ['title', 'accounts', 'accounts-1'],
  );
});

test('targets are checked against the files and sections that exist', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'decision register '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'docs', 'spec'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'spec', 'tax-amm.md'), '# Tax AMM\n\n## Constants\n');
  const registerPath = path.join(root, 'docs', 'decisions.md');
  const check = (value) =>
    checkTargets(parseDecisions(register(block({ 'Specified in': value }))).decisions, registerPath, root).map(
      (problem) => problem.message,
    );

  assert.deepEqual(check('[`docs/spec/tax-amm.md`, Constants](spec/tax-amm.md#constants)'), []);
  assert.match(check('[`docs/spec/tax-amm.md`, Constants](spec/tax-amm.md#rates)')[0], /no section with the anchor "#rates"/);
  assert.match(check('[`docs/spec/tax-amm.md`, Limits](spec/tax-amm.md#constants)')[0], /is the section "Constants"/);
  assert.match(check('[`docs/spec/gone.md`, Constants](spec/gone.md#constants)')[0], /does not exist/);
  assert.match(check('[`docs/spec/other.md`, Constants](spec/tax-amm.md#constants)')[0], /the link text names/);
  assert.match(check('[`secrets.md`, Keys](../../secrets.md#keys)')[0], /points outside the repo/);
});

test('the command line checks a file, prints JSON, and fails on a problem', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'decision register '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const good = path.join(root, 'good.md');
  const bad = path.join(root, 'bad.md');
  const map = '[the map, Notes](https://github.com/imDev2023/testing-pipeline/issues/1)';
  writeFileSync(good, register(block({ 'Specified in': map })));
  writeFileSync(bad, register(block({ 'Specified in': map, Status: 'agreed' })));

  assert.match(execFileSync('node', [script, '--check', good], { encoding: 'utf8' }), /1 decisions .*no problems/);
  const printed = JSON.parse(execFileSync('node', [script, '--json', good], { encoding: 'utf8' }));
  assert.equal(printed.format, 1);
  assert.equal(printed.decisions[0].id, 'TAX-01');
  assert.equal('line' in printed.decisions[0], false);

  for (const mode of ['--check', '--json']) {
    const failed = spawnSync('node', [script, mode, bad], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.match(failed.stderr, /bad\.md:\d+: TAX-01: "Status" must be/);
  }
});

test('the register in this repo passes', () => {
  assert.match(execFileSync('node', [script, '--check'], { encoding: 'utf8' }), /no problems/);
});
