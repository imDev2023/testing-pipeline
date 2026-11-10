// PROTOTYPE (throwaway): pieces shared by several screens.
(function () {
  'use strict';
  const P = window.PS;
  const { esc, short, href, D } = P;
  const n0 = n => Number(n).toLocaleString('en-US');

  // ---- Canary outcomes: five shapes in ink, heavier the more a trader needs to look. No colour, no score. ----
  function glyph(o) {
    const a = 'class="gl" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false"';
    if (o === 'fail') return `<svg ${a}><circle cx="6" cy="6" r="5" fill="currentColor"/></svg>`;
    if (o === 'warn') return `<svg ${a}><circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1.75 6a4.25 4.25 0 0 0 8.5 0z" fill="currentColor"/></svg>`;
    if (o === 'pass') return `<svg ${a}><circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
    if (o === 'not run') return `<svg ${a}><circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 2.25"/></svg>`;
    return `<svg ${a}><rect x="2.5" y="5.25" width="7" height="1.5" fill="currentColor"/></svg>`;
  }
  const outcome = o => `<span class="oc oc-${o.replace(' ', '')}">${glyph(o)}<span class="oc-w">${o}</span></span>`;

  // ---- small pieces ----
  function addr(a, o = {}) {
    const inner = `<span class="addr" title="${esc(a)}">${o.full ? esc(a) : short(a)}</span>`;
    return o.href ? `<a href="${o.href}">${inner}</a>` : inner;
  }
  const copy = a => `<button class="copy" type="button" data-copy="${esc(a)}" aria-label="Copy ${esc(a)}">Copy</button>`;
  const ext = (url, label) => `<a class="ext" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  function flags(list) {
    if (!list || !list.length) return '<span class="muted">none</span>';
    return `<span class="flags">${list.map(f => `<span class="flag" title="${esc(D.flags[f] || '')}">${esc(f)}</span>`).join('')}</span>`;
  }

  // ---- a result's numbers as bars: label, bar, value. It is the chart and its own table. ----
  function bars(series) {
    return `<table class="bars"><tbody>${series.map(s => `<tr class="bar-${s.state.replace(' ', '')}"><th scope="row">${esc(s.label)}${s.share != null ? `<span class="bar-share">${s.share >= 100 ? 'more than the vault holds' : `${s.share}% of the vault`}</span>` : ''}</th><td class="bar-cell"><span class="bar-track"><span class="bar-fill" style="width:${Math.max(0, Math.min(100, s.pct || 0))}%"></span></span></td><td class="bar-val">${s.pct != null ? `${P.pct(s.pct)} back` : s.state === 'stuck' ? 'could not sell back' : 'could not be bought'}</td></tr>`).join('')}</tbody></table>`;
  }
  function split(sp) {
    const parts = [['Came back', sp.back, 'sb-back'], ["Pipeline's fee, both legs", sp.pipeline, 'sb-pipe'], ["The strategy's own fee and spread", sp.rest, 'sb-rest']];
    return `<div class="splitbar" role="img" aria-label="Where a round trip went">${parts.map(([l, v, c]) => `<span class="${c}" style="flex:${Math.max(v, 0.6)} 1 0" title="${l}: ${P.pct(v)}"></span>`).join('')}</div>
      <table class="kv kv-split"><tbody>${parts.map(([l, v, c]) => `<tr><th scope="row"><span class="sw ${c}"></span>${l}</th><td>${P.pct(v)}</td></tr>`).join('')}</tbody></table>`;
  }
  function failure(f) {
    return `<table class="kv"><tbody>
      <tr><th scope="row">Refused by</th><td>${f.who === 'strategy' ? 'the strategy' : esc(f.who || 'unknown')}, program ${addr(f.program)}</td></tr>
      <tr><th scope="row">Its error</th><td><code>${esc(f.name || f.kind)}</code>${f.code != null ? ` (${f.code})` : ''}${f.message ? `: ${esc(f.message)}` : ''}</td></tr>
      ${f.stage ? `<tr><th scope="row">Stage</th><td>${esc(f.stage)}${f.origin ? `, raised at <code>${esc(f.origin)}</code>` : ''}</td></tr>` : ''}
    </tbody></table>`;
  }

  // ---- one Canary result ----
  function canaryResult(r, m, o = {}) {
    const d = [];
    if (r.series) d.push(bars(r.series));
    if (r.split) d.push(split(r.split));
    if (r.rows && r.rows.length) d.push(`<table class="kv"><tbody>${r.rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`);
    if (r.failure) d.push(failure(r.failure));
    if (r.list && r.list.length) d.push(`<p class="inst">${r.list.map(x => `<code>${esc(x)}</code>`).join(' ')}</p>`);
    d.push(`<p class="cr-meta">Check <code>${r.check}</code>: ${esc(P.CHECK_HELP[r.check]).toLowerCase()}. Run on ${P.fmtDate(m.canary.run_at)} at slot ${n0(m.canary.slot)}, on the strategy version deployed in slot ${n0(m.canary.strategy_slot)}.</p>`);
    return `<details class="cr"${o.open ? ' open' : ''}><summary><span class="cr-oc">${outcome(r.outcome)}</span><span class="cr-body"><span class="cr-name">${esc(P.CHECK_NAME[r.check])}</span><span class="cr-reason">${esc(r.reason)}</span></span></summary><div class="cr-detail">${d.join('')}</div></details>`;
  }
  // All results of one market, most needed first. Runs of "not run" with one shared reason fold into one line.
  function canaryList(m, o = {}) {
    const recs = P.sortedRecords(m);
    const first = recs.filter(r => r.outcome === 'fail' || r.outcome === 'warn');
    const notRun = recs.filter(r => r.outcome === 'not run');
    const rest = recs.filter(r => r.outcome === 'pass' || r.outcome === 'noted');
    const groups = new Map();
    for (const r of notRun) { if (!groups.has(r.reason)) groups.set(r.reason, []); groups.get(r.reason).push(r); }
    const notRunHtml = [...groups].map(([reason, list]) => list.length === 1 ? canaryResult(list[0], m) : `<div class="cr cr-group"><div class="cr-sum"><span class="cr-oc">${outcome('not run')}</span><span class="cr-body"><span class="cr-name">${list.map(r => esc(P.CHECK_NAME[r.check])).join(', ')}</span><span class="cr-reason">${esc(reason)}</span></span></div></div>`).join('');
    const restHtml = rest.map(r => canaryResult(r, m)).join('');
    return `<div class="crs">${first.map(r => canaryResult(r, m, { open: r.check !== 'conformance' })).join('')}${notRunHtml}${o.foldRest && rest.length ? `<details class="cr-more"><summary>The checks that passed, and what Canary only noted</summary>${restHtml}</details>` : restHtml}</div>`;
  }
  function canaryHead(m) {
    return `<p class="canary-about">Canary traded a private copy of this market on ${P.fmtDate(m.canary.run_at)}, as a trader would, and recorded what happened. It detects; it cannot prove a market safe, and a result is no promise about a later trade or a later version.</p>`;
  }

  // Per strategy version: for each check, how many markets got each outcome, and which markets warn or fail.
  function rollup(s) {
    return P.CHECKS.map(([check]) => {
      const row = { check, counts: { fail: 0, warn: 0, 'not run': 0, pass: 0, noted: 0 }, flagged: [] };
      for (const m of s.markets) {
        const r = P.rec(m, check);
        if (!r) continue;
        row.counts[r.outcome]++;
        if (r.outcome === 'fail' || r.outcome === 'warn') row.flagged.push({ m, r });
      }
      return row;
    });
  }
  function rollupSentence(row, total) {
    const c = row.counts;
    const bits = [];
    for (const o of ['fail', 'warn', 'not run', 'pass', 'noted']) if (c[o]) bits.push(`<span class="ru-bit">${outcome(o)} <span class="ru-n">${c[o] === total ? (total === 1 ? 'the one market' : total === 2 ? 'both markets' : `all ${total} markets`) : `${c[o]} of ${total}`}</span></span>`);
    return bits.join('');
  }
  function roundTripRange(s) {
    const v = s.markets.map(m => m.canary && m.canary.ordinary).filter(x => x != null);
    if (!v.length) return '';
    const lo = Math.min(...v), hi = Math.max(...v);
    return lo === hi ? P.pct(lo) : `${P.pct(lo)} to ${P.pct(hi)}`;
  }

  // ---- the upgrade notice ----
  const pending = s => !!P.session.upgraded[s.program_id];
  function upgradeNotice(s) {
    if (!pending(s)) return '';
    return `<p class="notice notice-plain" role="status">Upgraded on ${P.fmtDate(P.NOW, false)}; tests and explanation for this version are pending. Results for the version before it are in the strategy's version history.</p>`;
  }

  // ---- the explainer, presentation A: short first ----
  const TOPICS = [['does', 'What it does'], ['control', 'Who can change it'], ['canary', 'What Canary saw'], ['protection', 'What protects your trade'], ['author', 'What its author says']];
  const chips = ev => (ev || []).map(id => `<button type="button" class="chip" data-ev="${esc(id)}" title="Show the evidence this sentence cites">${esc(id)}</button>`).join('');
  function explainer(s, o = {}) {
    const e = D.explanations[s.program_id];
    const verified = s.verified_build && s.verified_build.verified;
    if (pending(s) || !e) {
      return `<section class="panel ai-panel ai-none" aria-label="Explanation"><h2>Explanation</h2>
        <p class="ai-none-line">${pending(s) ? 'Tests and explanation for this version are pending.' : 'No explanation for this version yet.'}</p>
        <p class="muted">An explanation is written once for each strategy version, from the facts ${o.market ? 'on this page' : 'beside it'} and the Canary results, and only after its cost is approved. Opening a page never makes one.</p>
        ${verified ? '' : '<p class="muted">Source not verified: no build of this program has been matched to public source, so no source code would be used as evidence.</p>'}
      </section>`;
    }
    const out = e.output;
    const claims = TOPICS.map(([k, title]) => {
      const list = out.claims.filter(c => c.topic === k);
      if (!list.length) return '';
      return `<h4>${title}</h4><ul class="claims">${list.map(c => `<li class="claim claim-${c.basis}"><span class="ai-text">${esc(c.text)}</span> ${chips(c.evidence)}${c.basis === 'inferred' ? '<span class="basis">inferred</span>' : c.basis === 'author' ? '<span class="basis basis-author">the author\'s words</span>' : ''}</li>`).join('')}</ul>`;
    }).join('');
    return `<section class="panel ai-panel" aria-label="Explanation" data-explainer="${esc(s.program_id)}">
      <h2>Explanation</h2>
      <p class="ai-label">Written by an AI on ${P.fmtDate(e.generated, false)} from on-chain data${e.hasSource ? ', its verified source' : ''} and Canary results for this strategy version (deployed in slot ${n0(e.slot)}). It can be wrong. It is not an audit, a safety rating or advice.</p>
      ${out.author_text_addresses_ai ? '<p class="notice notice-plain">This strategy\'s metadata contains text addressed to AI tools.</p>' : ''}
      <p class="ai-summary">${out.summary.map(x => `<span class="ai-text">${esc(x.text)}</span> ${chips(x.evidence)}`).join(' ')}</p>
      ${o.market ? '<p class="muted ai-scope">It describes the strategy version, not this market: where it says "the sampled market", it means the strategy\'s busiest one. This market\'s own facts are in the facts panel.</p>' : ''}
      <h3>What the evidence does not settle</h3>
      <ul class="unknowns">${out.unknowns.map(u => `<li><span class="ai-text">${esc(u.text)}</span> ${chips(u.evidence)}</li>`).join('')}</ul>
      <details class="ai-full"><summary>Read the full explanation (${out.claims.length} points)</summary>
        <p class="muted ai-key"><span class="key-dot key-solid"></span>stated by the evidence <span class="key-dot key-hollow"></span>inferred from it <span class="key-dot key-author"></span>the author's own words, unverified</p>
        ${claims}
      </details>
      <details class="ai-evidence"><summary>The evidence it was given (${e.evidence.length} items)</summary>
        <div class="tscroll"><table class="t t-evidence"><thead><tr><th>Id</th><th>What</th><th>Value</th><th>Read from</th></tr></thead><tbody>
        ${e.evidence.map(x => `<tr id="ev-${esc(s.program_id)}-${esc(x.id)}" class="${x.group === 'Author' ? 'ev-author' : ''}"><td><code>${esc(x.id)}</code></td><td>${esc(x.label)}</td><td class="${x.group === 'Author' ? 'author' : ''}">${esc(x.value)}</td><td class="muted">${esc(x.source || '')}</td></tr>`).join('')}
        </tbody></table></div>
      </details>
      <div class="wrong" data-wrong>
        <button type="button" class="btn btn-quiet" data-action="wrong-open">This is wrong</button>
      </div>
    </section>`;
  }

  // ---- facts ----
  const kv = rows => `<table class="kv"><tbody>${rows.filter(Boolean).map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join('')}</tbody></table>`;
  function flagFacts(list) {
    if (!list || !list.length) return '';
    return `<ul class="flagfacts">${list.map(f => `<li><span class="flag">${esc(f)}</span> <span>${esc(D.flags[f] || '')}</span></li>`).join('')}</ul>`;
  }
  function programFacts(s) {
    const meta = s.metadata_status;
    const metaLine = meta === 'valid' ? 'Valid' : `Unavailable: ${P.METADATA_WORDS[meta] || esc(meta)}`;
    return kv([
      ['Program', `${addr(s.program_id)} ${copy(s.program_id)} ${ext(P.explorer('address', s.program_id), 'Explorer')}`],
      ['Upgrade authority', s.upgradeable ? `${addr(s.upgrade_authority)} can replace this program's code` : 'None: the program is frozen'],
      ['This version', `Deployed in slot ${n0(s.last_deploy_slot)}${s.history && s.history.find(h => h.slot === s.last_deploy_slot) ? `, ${P.fmtDate(s.history.find(h => h.slot === s.last_deploy_slot).time)}` : ''}`],
      ['Code hash', `<span class="addr" title="${esc(s.executable_sha256)}">${esc(s.executable_sha256.slice(0, 8))}...${esc(s.executable_sha256.slice(-5))}</span> ${copy(s.executable_sha256)}`],
      ['Verified build', s.verified_build && s.verified_build.verified ? 'Rebuilt from public source and matched' : 'None: source not verified'],
      ['Metadata', `${metaLine}${s.metadata_url ? `<span class="url">${esc(s.metadata_url)}</span>` : ''}`],
      ['Registered', `${P.fmtDate(s.registered_at)}; listing fee paid ${P.fmtUnits(s.listing_fee_paid, 9)} SOL`],
      ['Markets', `${s.market_count}`],
    ]) + flagFacts(s.flags);
  }
  function mintFacts(t) {
    const tk = P.tok(t.mint);
    if (tk.ours) return `<h4 class="mint-h">${P.tokHtml(t.mint)} ${copy(t.mint)}</h4>` + kv([
      ['Named by', 'Pipescope. It names SOL and USDC itself, and no other token'],
      ['Mint', `${addr(t.mint)}${t.mint === P.WSOL ? ', wrapped SOL: Pipescope wraps and unwraps it for you' : ''}`],
      ['In this market\'s vault', P.fmtUnits(t.liquidity, t.decimals)],
    ]);
    const ex = Object.keys(t.extensions || {});
    const fee = t.extensions && t.extensions.transfer_fee;
    return `<h4 class="mint-h">${P.tokHtml(t.mint)} ${copy(t.mint)}</h4>` + kv([
      tk.name && !tk.ours ? ['Name', `<span class="author">${esc(tk.name)}</span> <span class="muted">(from the mint's metadata, unverified)</span>`] : null,
      ['Token program', t.token_program.startsWith('Tokenz') ? 'Token-2022' : 'Token'],
      ['Decimals, supply', `${t.decimals}; ${P.fmtUnits(t.supply, t.decimals)}`],
      ['Mint authority', t.mint_authority ? `${addr(t.mint_authority)} can mint more` : 'None'],
      ['Freeze authority', t.freeze_authority ? `${addr(t.freeze_authority)} can freeze accounts` : 'None'],
      ex.length ? ['Extensions', ex.map(x => `<code>${esc(x)}</code>`).join(' ') + (fee ? `<span class="url">Transfer fee: ${esc(JSON.stringify(fee.newer_transfer_fee || fee).slice(0, 140))}</span>` : '')] : null,
      ['In this market\'s vault', `${P.fmtUnits(t.liquidity, t.decimals)}${Number(t.supply) > 0 ? ` (${+(Number(t.liquidity) / Number(t.supply) * 100).toPrecision(3)}% of supply)` : ''}`],
    ]) + flagFacts(t.flags);
  }
  function volumeHtml(m) {
    const v = m.stats_24h.volume_by_input_mint || {};
    const e = Object.entries(v);
    if (!e.length) return '<span class="muted">none</span>';
    return e.map(([mint, amt]) => { const t = P.mintOf(m, mint); return `${P.fmtUnits(amt, t ? t.decimals : 9)} ${P.tokHtml(mint, { bare: true })}`; }).join('<br>');
  }
  const liquidityHtml = m => m.mints.map(t => `${P.fmtUnits(t.liquidity, t.decimals)} ${P.tokHtml(t.mint, { bare: true })}`).join('<br>');

  // The round trip and the one result a trader most needs, for a list row.
  function leadHtml(m) {
    const c = m.canary;
    if (!c) return '<span class="muted">not tested yet</span>';
    const l = P.lead(m);
    const rt = c.ordinary != null ? `<span class="rt">${P.pct(c.ordinary)} back</span>` : '';
    if (!l) return rt;
    const repeatsRt = c.ordinary != null && /round trip returned/.test(l.text) && !/launch/.test(l.text);
    return `${repeatsRt ? '' : rt}<span class="lead">${outcome(l.outcome)} <span class="lead-t">${esc(l.text)}</span></span>`;
  }

  // ---- page frame ----
  function shell(page, r) {
    const cur = k => (page.nav === k ? ' aria-current="page"' : '');
    const w = P.session.wallet;
    return `<header class="top"><div class="top-in">
        <a class="brand" href="#/"><span class="brand-name">Pipescope</span><span class="brand-net" title="This build reads and trades on Solana devnet only">devnet</span></a>
        <nav class="nav" aria-label="Pages"><a href="#/"${cur('feed')}>Feed</a><a href="#/create"${cur('create')}>Create market</a><a href="#/wallet"${cur('wallet')}>Wallet</a></nav>
        <form class="search" role="search" data-search><input type="search" name="q" value="${esc(page.nav === 'search' ? r.q.get('q') || '' : '')}" placeholder="Name, mint, market or strategy address" aria-label="Search markets, strategies and mints" autocomplete="off" spellcheck="false"></form>
        <button type="button" class="btn wallet-btn${w ? ' is-on' : ''}" data-action="wallet">${w ? `<span class="addr">${short(D.wallet.address)}</span>` : 'Connect wallet'}</button>
      </div></header>
      <main id="main" class="page page-${esc(page.cls || '')}" tabindex="-1">${page.html}</main>
      <footer class="foot"><div class="foot-in">
        <p class="voices"><span class="voice"><span class="v-sample">Plain text</span> was read from the chain or measured by Pipescope.</span> <span class="voice"><span class="v-sample ai-text">Text set like this</span> was written by an AI from those facts.</span> <span class="voice"><span class="v-sample author">Text like this</span> was written by a strategy's or token's author and is not verified.</span></p>
        <p>Devnet only. Pipescope never holds your keys: every transaction is signed in your own wallet, after a simulation you see first.</p>
        <p class="foot-links"><a href="#/fees">Fees</a><a href="#/devnet-help">Devnet help</a><a href="#/decisions">Decisions behind these screens</a></p>
        <p class="muted">Prototype. Devnet as it was on ${P.fmtDate(D.built_at)}, at slot ${n0(D.health.finalized_slot)}; quotes in the trade box are live.</p>
      </div></footer>`;
  }

  Object.assign(P, { glyph, outcome, addr, copy, ext, flags, bars, canaryResult, canaryList, canaryHead, rollup, rollupSentence, roundTripRange, pending, upgradeNotice, explainer, kv, flagFacts, programFacts, mintFacts, volumeHtml, liquidityHtml, leadHtml, shell, n0 });
})();
