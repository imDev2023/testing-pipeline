// PROTOTYPE (throwaway): data access, formatting and routing shared by every screen.
(function () {
  'use strict';
  const D = window.PIPESCOPE_DATA;
  const WSOL = 'So11111111111111111111111111111111111111112';
  const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  const NOW = new Date(D.built_at);

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = a => (a ? a.slice(0, 4) + '...' + a.slice(-4) : '');

  // ---- indices ----
  const S = Object.fromEntries(D.strategies.map(s => [s.program_id, s]));
  const M = Object.fromEntries(D.markets.map(m => [m.address, m]));
  for (const s of D.strategies) s.markets = D.markets.filter(m => m.strategy_program === s.program_id);

  // ---- options the prototype bar changes (kept per browser, never needed for the page to work) ----
  const opts = { theme: 'system', candles: 'ink', metadata: 'devnet' };
  try { Object.assign(opts, JSON.parse(localStorage.getItem('pipescope-proto') || '{}')); } catch (e) { /* private window */ }
  function setOpt(k, v) {
    opts[k] = v;
    try { localStorage.setItem('pipescope-proto', JSON.stringify(opts)); } catch (e) { /* ignore */ }
    applyTheme();
  }
  function applyTheme() {
    if (opts.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', opts.theme);
  }
  const isDark = () => opts.theme === 'dark' || (opts.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  // ---- session state (in memory only) ----
  const session = { wallet: false, upgraded: {} };

  // ---- routing: #/path?query ----
  function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    const i = h.indexOf('?');
    const path = i < 0 ? h : h.slice(0, i);
    return { path, parts: path.split('/').filter(Boolean), q: new URLSearchParams(i < 0 ? '' : h.slice(i + 1)) };
  }
  function href(path, params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') q.set(k, v);
    const s = q.toString();
    return '#' + path + (s ? '?' + s : '');
  }
  function setQuery(changes) {
    const r = route();
    for (const [k, v] of Object.entries(changes)) { if (v == null || v === '') r.q.delete(k); else r.q.set(k, v); }
    const s = r.q.toString();
    history.replaceState(null, '', '#' + r.path + (s ? '?' + s : ''));
    window.dispatchEvent(new Event('hashchange'));
  }

  // ---- numbers, amounts, dates ----
  function fmtNum(v) {
    if (v == null || !isFinite(v)) return '-';
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (a >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 3 });
    if (a >= 1e-7) return v.toFixed(Math.min(12, 3 - Math.floor(Math.log10(a)))).replace(/0+$/, '').replace(/\.$/, '');
    // very small: 0.0 with the count of zeros as a subscript, the usual way a terminal shows a tiny token price
    const zeros = -Math.floor(Math.log10(a)) - 1;
    const digits = Math.round(a * 10 ** (zeros + 4)).toString().replace(/0+$/, '') || '0';
    return `${v < 0 ? '-' : ''}0.0<sub>${zeros}</sub>${digits}`;
  }
  // A price: anything under 0.0001 uses the subscript form, so one chart never mixes the two.
  function fmtPrice(v) {
    if (v == null || !isFinite(v)) return '-';
    const a = Math.abs(v);
    if (a === 0 || a >= 1e-4) return fmtNum(v);
    const zeros = -Math.floor(Math.log10(a)) - 1;
    const digits = Math.round(a * 10 ** (zeros + 4)).toString().replace(/0+$/, '') || '0';
    return `0.0<sub>${zeros}</sub>${digits}`;
  }
  const units = (u, dec) => Number(u) / 10 ** dec;
  const fmtUnits = (u, dec) => fmtNum(units(u, dec));
  const pct = n => (n == null ? '-' : n < 1 ? `${+n.toPrecision(3)}%` : `${n.toFixed(1)}%`);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = n => String(n).padStart(2, '0');
  function fmtDate(x, withTime = true) {
    const d = typeof x === 'number' ? new Date(x * 1000) : new Date(x);
    const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    return withTime ? `${day}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC` : day;
  }
  function ago(x) {
    const d = typeof x === 'number' ? new Date(x * 1000) : new Date(x);
    const s = Math.max(0, (NOW - d) / 1000);
    if (s < 90) return `${Math.round(s)}s ago`;
    if (s < 5400) return `${Math.round(s / 60)}m ago`;
    if (s < 129600) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  const ageSeconds = x => (NOW - new Date(x)) / 1000;

  // ---- tokens: SOL and USDC are named by Pipescope; every other name is the mint author's, shown with the address ----
  function tok(mint) {
    const t = D.tokens[mint] || {};
    return { mint, symbol: t.symbol || '', name: t.name || '', ours: !!t.ours };
  }
  function tokText(mint) { const t = tok(mint); return t.symbol || short(mint); }
  function tokHtml(mint, o = {}) {
    const t = tok(mint);
    if (t.ours) return `<span class="tok"><span class="tok-ours">${esc(t.symbol)}</span></span>`;
    if (t.symbol) return `<span class="tok"><span class="author" title="Token name from the mint's own metadata, written by its creator and not verified">${esc(t.symbol)}</span>${o.bare ? '' : ` <span class="addr">${short(mint)}</span>`}</span>`;
    return `<span class="tok"><span class="addr">${short(mint)}</span></span>`;
  }
  const isFeeMint = mint => mint === WSOL || mint === USDC;
  const mintOf = (m, mint) => m.mints.find(x => x.mint === mint);
  // Which mint a price is quoted in: SOL, else USDC, else the market's second mint.
  function orient(m) {
    const ms = m.mints.map(x => x.mint);
    const quote = ms.find(x => x === WSOL) || ms.find(x => x === USDC) || ms[1];
    return { base: ms.find(x => x !== quote), quote };
  }
  function pairHtml(m, o = {}) {
    const { base, quote } = orient(m);
    return `<span class="pair">${tokHtml(base, o)}<span class="pair-sep"> / </span>${tokHtml(quote, o)}</span>`;
  }
  const pairText = m => { const { base, quote } = orient(m); return `${tokText(base)} / ${tokText(quote)}`; };

  // ---- strategies: a name appears only when the metadata is valid (or the prototype pretends it is) ----
  function metaUsable(s) { return s.metadata_status === 'valid' || (opts.metadata === 'pretend' && s.metadata && typeof s.metadata === 'object' && s.metadata.name); }
  function stratName(s) { return metaUsable(s) ? String(s.metadata.name).slice(0, 64) : ''; }
  function stratHtml(s, o = {}) {
    const n = stratName(s);
    const a = `<span class="addr">${short(s.program_id)}</span>`;
    const inner = n ? `<span class="author" title="Strategy name from its metadata, written by its author and not verified">${esc(n)}</span> ${a}` : a;
    return o.link === false ? inner : `<a href="${href('/strategy/' + s.program_id)}">${inner}</a>`;
  }
  const METADATA_WORDS = { missing: 'none published', 'not-fetched': 'not fetched yet', unreachable: 'the link could not be fetched', invalid: 'the document is not valid', valid: 'valid' };

  // ---- Canary ----
  const CHECKS = [
    ['readable', 'Reading the market', 'Can the strategy\'s current version read this market and quote it'],
    ['exit_sizes', 'Buy, then sell straight back', 'Buys each size and sells everything bought in the same slot'],
    ['cost', 'What a round trip costs', 'What comes back from a buy sold straight back, and where the rest went'],
    ['exit_hold', 'Buy, wait, then sell', 'Buys once, then sells after each wait'],
    ['exit_wallets', 'Fresh wallets and insiders', 'The same round trip from fresh wallets, the market creator and each authority'],
    ['exit_transferred', 'Selling tokens someone sent you', 'One wallet buys and sends the tokens to a second wallet, which sells'],
    ['exit_queue', 'Five buyers leaving in turn', 'Five wallets buy one after another, then sell in the same order'],
    ['exit_late', 'Arriving later', 'The whole round trip after each wait'],
    ['exit_launch_clock', 'The clock set back to launch', 'The round trip with the clock at the market\'s creation and just after'],
    ['token_authorities', 'Token authorities acting', 'Acts as each mint, freeze, fee, delegate or pause authority, then trades again'],
    ['quote_matches_swap', 'Quote against swap', 'Every swap compared with the quote taken just before it'],
    ['direct_call', 'Calling the strategy without the router', 'A swap sent straight to the strategy, skipping Pipeline'],
    ['transaction_accounts', 'Telling a test from a real trade', 'Accounts the strategy asks for that describe the transaction, not the market'],
    ['contained_mint', 'Transfer hook', 'Whether a hooked mint is a contained token of our containment hook'],
    ['conformance', 'Pipeline\'s own conformance check', 'pipeline-check, run unchanged on the same copy of the market'],
    ['custom_instructions', 'Instructions beyond Pipeline\'s own', 'Listed from the deployed program, never called'],
  ];
  const CHECK_NAME = Object.fromEntries(CHECKS.map(c => [c[0], c[1]]));
  const CHECK_HELP = Object.fromEntries(CHECKS.map(c => [c[0], c[2]]));
  const CHECK_ORDER = Object.fromEntries(CHECKS.map((c, i) => [c[0], i]));
  const OUTCOME_ORDER = { fail: 0, warn: 1, 'not run': 2, pass: 3, noted: 4 };
  const rec = (m, check) => m.canary && m.canary.records.find(r => r.check === check);
  // The one result a trader most needs, for lists: never a count or a score.
  function lead(m) {
    const c = m.canary;
    if (!c) return null;
    const r = c.records;
    if (c.state === 'stranded') return { outcome: 'fail', text: rec(m, 'readable').brief };
    if (c.state === 'closed') return { outcome: 'not run', text: rec(m, 'readable').brief };
    const pick = r.find(x => x.outcome === 'fail' && x.brief && x.check !== 'exit_queue')
      || r.find(x => x.outcome === 'warn' && x.brief && x.check.startsWith('exit'))
      || r.find(x => x.outcome === 'warn' && x.brief);
    return pick ? { outcome: pick.outcome, text: pick.brief } : null;
  }
  const sortedRecords = m => [...m.canary.records].sort((a, b) => (OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome]) || (CHECK_ORDER[a.check] - CHECK_ORDER[b.check]));

  const explorer = (kind, id) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

  window.PS = {
    D, S, M, WSOL, USDC, NOW, FEE_BPS: 50, PIPELINE_BPS: 25,
    esc, short, opts, setOpt, applyTheme, isDark, session, route, href, setQuery,
    fmtNum, fmtPrice, units, fmtUnits, pct, fmtDate, ago, ageSeconds,
    tok, tokText, tokHtml, isFeeMint, mintOf, orient, pairHtml, pairText,
    metaUsable, stratName, stratHtml, METADATA_WORDS,
    CHECKS, CHECK_NAME, CHECK_HELP, OUTCOME_ORDER, rec, lead, sortedRecords, explorer,
    pages: {}, variants: {},
  };
})();
