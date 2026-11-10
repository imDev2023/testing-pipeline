// PROTOTYPE logic for the explainer samples: the output validator production would run, plus helpers.
// Kept free of DOM code so `node check.mjs` can run the same checks the page shows.

const BANNED = [
  'safe', 'safely', 'safer', 'safest', 'safety', 'unsafe', 'secure', 'secured', 'security',
  'audit', 'audits', 'audited', 'auditor', 'auditors', 'trustworthy', 'trusted',
  'legit', 'legitimate', 'scam', 'scams', 'scammer', 'rug', 'rugs', 'rugged', 'rugpull', 'rug-pull',
  'honeypot', 'honeypots', 'risk-free', 'riskless', 'guarantee', 'guarantees', 'guaranteed',
  'recommend', 'recommends', 'recommended', 'recommendation', 'certified', 'vetted', 'approved'
];
const BANNED_PHRASES = [
  /\bshould (?:you )?(?:buy|sell|hold)\b/i, /\b(?:buy|sell|hold) (?:now|today)\b/i,
  /\bprice (?:will|could|should|may) (?:rise|fall|go|moon|pump|dump)\b/i, /\bexpected (?:return|profit|yield)\b/i,
  /\bnothing (?:can|will) go wrong\b/i, /\byou can always\b/i
];
const B58 = '[1-9A-HJ-NP-Za-km-z]';
const SHORT_ADDR = new RegExp(`\\b${B58}{4}\\.\\.\\.${B58}{4}\\b`, 'g');
const FULL_ADDR = new RegExp(`\\b${B58}{32,44}\\b`, 'g');
const INJECTION_HINTS = [
  /ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions|rules)/i, /\byou are (?:an? )?(?:ai|assistant|language model|llm)\b/i,
  /\b(?:ai|llm|assistant|language model)s?\b.*\b(?:must|should|say|state|describe|tell)\b/i, /\bsystem prompt\b/i,
  /\bdisregard\b/i, /\bnew instructions\b/i
];
const LIMITS = { summarySentences: [2, 3], summaryWords: 70, claims: 14, claimWords: 45, unknowns: 6, unknownWords: 35 };

function words(s) { return s.trim().split(/\s+/).filter(Boolean).length; }
function norm(s) { return String(s).replace(/(\d),(?=\d{3}\b)/g, '$1'); }

// Pull every number-like token out of a claim: dates, times, then plain numbers; addresses are removed first.
function tokens(text) {
  let t = norm(text);
  const addrs = [...(t.match(SHORT_ADDR) || []), ...(t.match(FULL_ADDR) || [])];
  t = t.replace(SHORT_ADDR, ' ').replace(FULL_ADDR, ' ');
  const dates = t.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
  t = t.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  const times = t.match(/\b\d{1,2}:\d{2}\b/g) || [];
  t = t.replace(/\b\d{1,2}:\d{2}\b/g, ' ');
  const nums = (t.match(/\d+(?:\.\d+)?/g) || []);
  return { addrs, dates, times, nums };
}

function evidenceText(ev) { return norm(`${ev.label} ${ev.value} ${ev.source || ''}`); }

function numberIn(num, hay) {
  const re = new RegExp(`(?<![\\d.])${num.replace('.', '\\.')}(?![\\d]|\\.\\d)`);
  return re.test(hay);
}

function addressIn(addr, hay) {
  if (addr.includes('...')) {
    const [a, b] = addr.split('...');
    const full = hay.match(FULL_ADDR) || [];
    return full.some(f => f.startsWith(a) && f.endsWith(b)) || hay.includes(addr);
  }
  return hay.includes(addr);
}

export function detectInjection(author) {
  return author.some(a => INJECTION_HINTS.some(re => re.test(a.value)));
}

// Normalise author text the way production would before the model sees it.
export function sanitizeAuthor(value, cap) {
  const stripped = String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[​-‏‪-‮⁠-⁩﻿]/g, '');
  return stripped.length > cap ? stripped.slice(0, cap) + ' [cut at ' + cap + ' characters]' : stripped;
}

export function validate(sample, out) {
  const all = new Map(sample.evidence.map(e => [e.id, e]));
  const problems = { cites: [], ids: [], numbers: [], format: [], banned: [], author: [], length: [], shape: [] };
  const items = [
    ...out.summary.map((s, i) => ({ where: `summary ${i + 1}`, kind: 'summary', ...s })),
    ...out.claims.map((c, i) => ({ where: `claim ${i + 1}`, kind: 'claim', ...c })),
    ...out.unknowns.map((u, i) => ({ where: `unknown ${i + 1}`, kind: 'unknown', ...u }))
  ];
  for (const it of items) {
    const ev = it.evidence || [];
    if (it.kind !== 'unknown' && ev.length === 0) problems.cites.push(`${it.where} cites no evidence`);
    for (const id of ev) if (!all.has(id)) problems.ids.push(`${it.where} cites ${id}, which is not in the input`);
    const hay = ev.filter(id => all.has(id)).map(id => evidenceText(all.get(id))).join(' \n ');
    const { addrs, dates, times, nums } = tokens(it.text);
    for (const a of addrs) if (!addressIn(a, hay)) problems.numbers.push(`${it.where}: address ${a} is not in its cited evidence`);
    for (const d of dates) if (!hay.includes(d)) problems.numbers.push(`${it.where}: date ${d} is not in its cited evidence`);
    for (const t of times) if (!hay.includes(t)) problems.numbers.push(`${it.where}: time ${t} is not in its cited evidence`);
    for (const n of nums) if (!numberIn(n, hay)) problems.numbers.push(`${it.where}: number ${n} is not in its cited evidence`);
    if (/https?:\/\/|www\.|javascript:|data:|\b[a-z0-9-]+\.(?:com|io|xyz|fun|app|net|org|dev)\b/i.test(it.text)) problems.format.push(`${it.where} contains a link or domain`);
    if (/[<>`]|\*\*|__|\]\(|^\s*(?:#|[-+*]\s)/m.test(it.text)) problems.format.push(`${it.where} contains Markdown or HTML characters`);
    if (/\b[PFCSA]\d{1,2}\b/.test(it.text)) problems.format.push(`${it.where} writes an evidence id into its text`);
    for (const w of BANNED) if (new RegExp(`\\b${w}\\b`, 'i').test(it.text)) problems.banned.push(`${it.where} uses the banned term "${w}"`);
    for (const re of BANNED_PHRASES) if (re.test(it.text)) problems.banned.push(`${it.where} gives advice or a prediction ("${it.text.match(re)[0]}")`);
    const citesAuthor = ev.some(id => id.startsWith('A'));
    if (it.kind === 'claim' && it.basis === 'author') {
      if (!citesAuthor) problems.author.push(`${it.where} is marked author but cites no author text`);
      if (!/\bauthor\b/i.test(it.text)) problems.author.push(`${it.where} does not say the text is the author's`);
    } else if (citesAuthor && !/\bauthor\b/i.test(it.text)) {
      problems.author.push(`${it.where} rests on author text without attributing it`);
    }
    if (it.kind === 'claim' && it.basis === 'inferred' && !/\bappears? to\b/i.test(it.text)) problems.author.push(`${it.where} is inferred but does not say "appears to"`);
    const cap = it.kind === 'claim' ? LIMITS.claimWords : it.kind === 'unknown' ? LIMITS.unknownWords : 40;
    if (words(it.text) > cap) problems.length.push(`${it.where} has ${words(it.text)} words (limit ${cap})`);
  }
  const [lo, hi] = LIMITS.summarySentences;
  if (out.summary.length < lo || out.summary.length > hi) problems.length.push(`summary has ${out.summary.length} sentences (${lo} to ${hi})`);
  const sw = out.summary.reduce((n, s) => n + words(s.text), 0);
  if (sw > LIMITS.summaryWords) problems.length.push(`summary has ${sw} words (limit ${LIMITS.summaryWords})`);
  if (out.claims.length > LIMITS.claims) problems.length.push(`${out.claims.length} claims (limit ${LIMITS.claims})`);
  if (out.unknowns.length > LIMITS.unknowns) problems.length.push(`${out.unknowns.length} unknowns (limit ${LIMITS.unknowns})`);
  const topics = new Set(['does', 'control', 'canary', 'protection', 'author']);
  const bases = new Set(['confirmed', 'inferred', 'author']);
  out.claims.forEach((c, i) => {
    if (!topics.has(c.topic)) problems.shape.push(`claim ${i + 1} has unknown topic ${c.topic}`);
    if (!bases.has(c.basis)) problems.shape.push(`claim ${i + 1} has unknown basis ${c.basis}`);
  });
  const codeFlag = detectInjection(sample.evidence.filter(e => e.id.startsWith('A')));
  const checks = [
    ['Every sentence cites evidence', problems.cites],
    ['Every cited id exists in the input', problems.ids],
    ['Numbers, dates and addresses appear in the cited evidence', problems.numbers],
    ['Plain text: no links, Markdown, HTML or evidence ids', problems.format],
    ['No verdicts, advice or predictions', problems.banned],
    ['Author text only in attributed claims; inferred claims say "appears to"', problems.author],
    ['Within length limits', problems.length],
    ['Matches the schema', problems.shape]
  ].map(([name, errs]) => ({ name, ok: errs.length === 0, errors: errs }));
  return {
    pass: checks.every(c => c.ok),
    checks,
    injection: { model: !!out.author_text_addresses_ai, code: codeFlag, shown: !!out.author_text_addresses_ai || codeFlag }
  };
}
