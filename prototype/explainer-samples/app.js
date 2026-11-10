// PROTOTYPE page code: renders each sample in three presentation variants beside the code-built facts panel.
const VARIANTS = [
  { key: 'a', name: 'Short first' },
  { key: 'b', name: 'Sections' },
  { key: 'c', name: 'Ledger' }
];
const TOPICS = [
  ['does', 'What it does'],
  ['control', 'Who can change it'],
  ['canary', 'What Canary saw'],
  ['protection', 'What protects your trade'],
  ['author', 'What its author says']
];
const GROUPS = [
  ['Program', 'Program'],
  ['Market', 'Representative market'],
  ['Observed', 'Observed on devnet'],
  ['Source', 'Verified source'],
  ['Canary', 'Canary results'],
  ['Pipeline', 'Pipeline rules'],
  ['Author', 'Author text']
];
const state = { s: 0, v: 0, d: 'pass' };
const $ = id => document.getElementById(id);
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}
function sample() { return SAMPLES[state.s]; }
function evidenceOf(s) { return [...s.evidence, ...PIPELINE_RULES]; }
function output(s) { return s.outputs[state.d] || s.outputs.pass; }

function chips(ids, s) {
  const known = new Set(evidenceOf(s).map(e => e.id));
  return el('span', { class: 'cite' }, (ids || []).map(id => el('button', {
    type: 'button', class: 'chip' + (known.has(id) ? '' : ' missing'), 'data-k': id[0], text: id,
    title: known.has(id) ? 'Show this fact' : 'Not in the input', onclick: () => flash(id)
  })));
}
function flash(id) {
  document.querySelectorAll('.fact.hit').forEach(n => n.classList.remove('hit'));
  const row = document.querySelector(`.fact[data-id="${id}"]`);
  if (!row) return;
  row.classList.add('hit');
  row.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  setTimeout(() => row.classList.remove('hit'), 2400);
}
function withAddresses(text) {
  const parts = String(text).split(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  return parts.map((p, i) => i % 2 ? el('span', { class: 'addr', text: p }) : p);
}
function sentence(item, s) {
  const m = item.text.match(/^(.*\s)?(\S+)$/s);
  const head = m && m[1] ? m[1] : '';
  const last = m ? m[2] : item.text;
  return [head, el('span', { class: 'tail' }, last, chips(item.evidence, s))];
}

function claimsByTopic(out, s) {
  const frag = [];
  for (const [topic, title] of TOPICS) {
    const cs = out.claims.filter(c => c.topic === topic);
    if (!cs.length) continue;
    frag.push(el('h2', { class: 'sec', text: title }));
    frag.push(el('ul', { class: 'claims' }, cs.map(c => el('li', { class: c.basis }, sentence(c, s)))));
  }
  return frag;
}
function unknownBox(out, s, title) {
  if (!out.unknowns.length) return null;
  return el('div', { class: 'unknowns' }, el('b', { text: title }),
    out.unknowns.map(u => el('div', {}, sentence(u, s))));
}

function variantA(out, s) {
  return [
    el('p', { class: 'lede' }, out.summary.map(x => [sentence(x, s), ' '])),
    unknownBox(out, s, 'What the evidence does not settle'),
    el('details', { class: 'more' }, el('summary', { text: `Read the full explanation (${out.claims.length} points)` }), ...claimsByTopic(out, s))
  ];
}
function variantB(out, s) {
  return [...claimsByTopic(out, s), unknownBox(out, s, 'What the evidence does not settle')];
}
function variantC(out, s) {
  const ev = new Map(evidenceOf(s).map(e => [e.id, e]));
  const basisName = { confirmed: 'Confirmed', inferred: 'Inferred', author: 'Author says' };
  const row = (n, text, basis, ids) => el('tr', {},
    el('td', { class: 'n', text: n }),
    el('td', { class: 'st', text }),
    el('td', {}, basis ? el('span', { class: 'basis ' + basis, text: basisName[basis] }) : el('span', { class: 'basis inferred', text: 'Unknown' })),
    el('td', {}, el('div', { class: 'ev' }, (ids || []).map(id => el('div', {}, chips([id], s), ' ', el('span', { text: ev.has(id) ? `${ev.get(id).label}: ${ev.get(id).value}` : 'not in the input' }))))));
  return [
    el('p', { class: 'lede' }, out.summary.map(x => x.text).join(' ')),
    el('div', { class: 'ledger-wrap' }, el('table', { class: 'ledger' },
      el('thead', {}, el('tr', {}, ['#', 'Statement', 'Basis', 'Evidence'].map(h => el('th', { text: h })))),
      el('tbody', {},
        out.claims.map((c, i) => row(i + 1, c.text, c.basis, c.evidence)),
        out.unknowns.map((u, i) => row('?' + (i + 1), u.text, null, u.evidence)))))
  ];
}

function aiLabel(s) {
  const from = s.hasSource ? 'on-chain data, its verified source and Canary results' : 'on-chain data and Canary results';
  return el('div', { class: 'ai-label' },
    el('strong', { text: 'Written by an AI' }),
    ` on ${s.generated} from ${from} for this strategy version (deployed in slot ${s.version.slot}). It can be wrong. It is not an audit, a safety rating or advice.`);
}

function renderTabs() {
  $('tabs').replaceChildren(...SAMPLES.map((s, i) => el('button', {
    type: 'button', role: 'tab', 'aria-selected': String(i === state.s), text: s.tab,
    onclick: () => { state.s = i; state.d = 'pass'; go(); }
  })));
}
function renderHead(s) {
  $('head').replaceChildren(
    el('h1', { text: s.title }),
    el('div', { class: 'sub' },
      el('span', {}, 'Program ', el('span', { class: 'mono', text: s.program })),
      el('span', { text: `Version: deployed in slot ${s.version.slot}` }),
      el('span', { text: s.known })));
}
function renderExplainer(s, verdict) {
  const out = output(s);
  const kids = [];
  if (s.outputs.fooled) {
    kids.push(el('div', { class: 'drafts' }, 'Model output:',
      ['pass', 'fooled'].map(d => el('button', {
        type: 'button', 'aria-pressed': String(state.d === d),
        text: d === 'pass' ? 'Draft that follows the rules' : 'Draft from a model the metadata fooled',
        onclick: () => { state.d = d; go(); }
      }))));
  }
  if (verdict.injection.shown) {
    kids.push(el('div', { class: 'notice' }, el('b', { text: 'Note from Pipescope: ' }),
      "this strategy's metadata contains text addressed to AI tools." + (verdict.pass ? ' The explanation below does not follow it.' : '')));
  }
  if (!verdict.pass) {
    kids.push(el('div', { class: 'fallback' },
      el('b', { text: 'No explanation for this version.' }),
      el('span', { text: "The AI's draft failed Pipescope's checks twice, so only the facts are shown. The checks it failed are listed below the page (prototype only)." })));
  } else {
    kids.push(aiLabel(s));
    const body = [variantA, variantB, variantC][state.v](out, s);
    kids.push(...body.filter(Boolean));
  }
  kids.push(el('div', { class: 'feedback' }, el('button', { type: 'button', text: 'This is wrong' }), el('span', { text: 'Tell us what is wrong; a person reads every report.' })));
  $('explainer').replaceChildren(...kids);
}
function renderFacts(s) {
  const all = evidenceOf(s);
  const cited = new Set(output(s).claims.concat(output(s).summary, output(s).unknowns).flatMap(x => x.evidence || []));
  const groups = GROUPS.map(([g, title]) => {
    const rows = all.filter(e => e.group === g);
    if (!rows.length) return null;
    const h = el('h3', {}, title);
    if (g === 'Canary') h.append(el('span', { class: 'tag canary', text: s.canaryNote || 'illustrative' }));
    if (g === 'Author') h.append(el('span', { class: 'tag author', text: 'written by the author, unverified' }));
    return el('div', { class: 'group' }, h, rows.map(e => el('div', { class: 'fact' + (cited.has(e.id) ? '' : ' cited-none'), 'data-id': e.id },
      el('span', { class: 'id', text: e.id }),
      el('div', {}, el('div', { class: 'lab' }, withAddresses(e.label)), el('div', { class: 'val' }, withAddresses(e.value)),
        e.raw ? el('div', { class: 'src', text: 'As received: ' + e.raw }) : null,
        e.source ? el('div', { class: 'src', text: e.source }) : null))));
  });
  $('facts').replaceChildren(
    el('h2', { text: 'Facts' }),
    el('p', { class: 'why', text: 'Built by Pipescope from the chain and its own Canary runs, never by the AI. Ids match the chips in the explanation; faded ids are not cited.' }),
    ...groups.filter(Boolean));
}
function renderChecks(s, verdict) {
  $('checks').replaceChildren(
    el('h2', {}, 'Validator', el('span', { class: 'verdict ' + (verdict.pass ? 'pass' : 'fail'), text: verdict.pass ? 'passed, shown' : 'failed, not shown' })),
    el('p', { text: 'Prototype only: the checks production code runs on the AI output before showing it. On a failure it retries once with the errors, then shows the facts alone.' }),
    el('ul', {}, verdict.checks.map(c => el('li', { class: c.ok ? 'ok' : 'no' },
      el('span', { class: 'm', text: c.ok ? '✓' : '✗' }), el('span', { text: c.name }),
      c.errors.slice(0, 4).map(e => el('span', { class: 'err', text: e }))))),
    el('p', { text: `Author text addressed to AI tools: model flag ${verdict.injection.model ? 'yes' : 'no'}, code detector ${verdict.injection.code ? 'yes' : 'no'}, so the notice is ${verdict.injection.shown ? 'shown' : 'not shown'}.` }));
}
function renderIO(s) {
  const all = evidenceOf(s);
  const input = {
    prompt_version: PROMPT_VERSION,
    strategy_version: { program: s.program, deploy_slot: s.version.slot },
    evidence: all.filter(e => e.group !== 'Author').map(({ id, label, value }) => ({ id, label, value })),
    author_text_tool_result: all.filter(e => e.group === 'Author').map(({ id, label, value }) => ({ id, origin: label, text: value }))
  };
  $('io').replaceChildren(
    el('summary', { text: 'The model input and output for this sample (JSON)' }),
    el('p', { text: 'The input is what Pipescope would send after normalising author text; author text goes in a tool result, JSON-encoded. The output is the structured JSON the model returns; the page above renders it as plain text.' }),
    el('pre', { text: JSON.stringify(input, null, 2) }),
    el('pre', { text: JSON.stringify(output(s), null, 2) }));
  $('io').open = false;
}
function renderAbout(s) {
  $('about').replaceChildren(...(s.notes || []).map(n => el('p', { text: n })));
}
function go() {
  const s = sample();
  const v = VARIANTS[state.v];
  const hash = `${s.key}-${v.key}${state.d === 'fooled' ? '-fooled' : ''}`;
  if (location.hash.slice(1) !== hash) history.replaceState(null, '', '#' + hash);
  const verdict = validate({ evidence: evidenceOf(s) }, output(s));
  renderTabs(); renderHead(s); renderExplainer(s, verdict); renderFacts(s); renderChecks(s, verdict); renderIO(s); renderAbout(s);
  $('vlabel').textContent = `${v.key.toUpperCase()} · ${v.name}`;
}
function fromHash() {
  const m = location.hash.slice(1).match(/^([a-z0-9-]+?)-([abc])(-fooled)?$/);
  if (!m) return;
  const i = SAMPLES.findIndex(x => x.key === m[1]);
  if (i >= 0) { state.s = i; state.v = 'abc'.indexOf(m[2]); state.d = m[3] && SAMPLES[i].outputs.fooled ? 'fooled' : 'pass'; }
}
function step(d) { state.v = (state.v + d + VARIANTS.length) % VARIANTS.length; go(); }
$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, [contenteditable]')) return;
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});
window.addEventListener('hashchange', () => { fromHash(); go(); });
fromHash();
go();
