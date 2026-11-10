// PROTOTYPE (throwaway): the strategy page, with Canary's results for the version in two layouts.
// "Two layouts of a strategy version's Canary results, switchable with ?variant=, on the one strategy route."
(function () {
  'use strict';
  const P = window.PS;
  const { esc, href, D } = P;

  P.variants.strategy = [['A', 'Canary by check'], ['B', 'Canary as a grid of markets and checks']];

  const worst = c => (c.fail ? 0 : c.warn ? 1 : c['not run'] ? 2 : c.pass ? 3 : 4);

  // A: one line per check, with how many markets got each outcome and which ones warn or fail.
  function byCheck(s) {
    const total = s.markets.length;
    const rows = P.rollup(s).sort((a, b) => worst(a.counts) - worst(b.counts));
    return `<div class="rollup">${rows.map(x => {
      const flagged = x.flagged;
      const reasons = new Map();
      for (const f of flagged) { const k = `${f.r.outcome}|${f.r.brief || f.r.reason}`; if (!reasons.has(k)) reasons.set(k, []); reasons.get(k).push(f); }
      const body = flagged.length ? [...reasons.values()].map(list => `<div class="ru-group"><p class="ru-reason">${P.outcome(list[0].r.outcome)} <span>${esc(list.length === 1 ? list[0].r.reason : (list[0].r.brief ? list[0].r.brief[0].toUpperCase() + list[0].r.brief.slice(1) + '.' : list[0].r.reason))}</span></p><ul class="ru-markets">${list.map(f => `<li><a href="${href('/market/' + f.m.address)}">${P.pairHtml(f.m, { bare: true })}</a> <span class="addr">${P.short(f.m.address)}</span></li>`).join('')}</ul></div>`).join('')
        : `<p class="muted ru-none">${esc(sampleReason(s, x.check))}</p>`;
      return `<details class="ru"${flagged.length && x.check !== 'conformance' ? ' open' : ''}><summary><span class="ru-name">${esc(P.CHECK_NAME[x.check])}<span class="ru-help">${esc(P.CHECK_HELP[x.check])}</span></span><span class="ru-counts">${P.rollupSentence(x, total)}</span></summary><div class="ru-body">${body}</div></details>`;
    }).join('')}</div>`;
  }
  function sampleReason(s, check) {
    const m = s.markets.find(mk => P.rec(mk, check) && ['pass', 'noted'].includes(P.rec(mk, check).outcome)) || s.markets.find(mk => P.rec(mk, check));
    return m ? `For example, on ${P.pairText(m)}: ${P.rec(m, check).reason}` : '';
  }

  // B: every market against every check.
  function grid(s) {
    const cols = P.CHECKS;
    return `<p class="muted grid-note">One row per market, one column per check. Each mark is that check's outcome on that market; hover or focus one for what happened. Nothing is added up.</p>
      <p class="grid-key">${['fail', 'warn', 'not run', 'pass', 'noted'].map(P.outcome).join('')}</p>
      <div class="tscroll"><table class="t t-grid"><thead><tr><th class="g-m">Market</th>${cols.map(c => `<th class="g-c"><span>${esc(c[1])}</span></th>`).join('')}</tr></thead><tbody>
      ${s.markets.map(m => `<tr><th scope="row" class="g-m"><a href="${href('/market/' + m.address)}">${P.pairHtml(m, { bare: true })}</a><span class="sub addr">${P.short(m.address)}</span></th>${cols.map(c => { const r = P.rec(m, c[0]); return `<td class="g-c">${r ? `<span class="g-cell" tabindex="0" title="${esc(c[1])}: ${r.outcome}. ${esc(r.reason)}" aria-label="${esc(c[1])}: ${r.outcome}">${P.glyph(r.outcome)}</span>` : ''}</td>`; }).join('')}</tr>`).join('')}
      </tbody></table></div>`;
  }

  function history(s) {
    const h = (s.history || []).filter(x => x.slot <= s.last_deploy_slot).sort((a, b) => b.slot - a.slot);
    if (!h.length) return `<p class="muted">The current version was deployed in slot ${P.n0(s.last_deploy_slot)}. Earlier versions are not in this snapshot.</p>`;
    return `<ol class="versions">${h.map((x, i) => `<li><span class="v-when">${P.fmtDate(x.time)}</span><span class="v-slot">slot ${P.n0(x.slot)}</span><span class="v-what">${i === 0 ? '<b>The current version.</b> The results and explanation on this page are for it.' : 'An earlier write to the program\'s code. Results for a version stay attached to that version, labelled as such.'}</span><span class="v-tx">${P.ext(P.explorer('tx', x.sig), 'Transaction')}</span></li>`).join('')}</ol>
      <p class="muted">Prototype: the list is every transaction on the program's code account; the product keeps one row per upgrade, with that version's own Canary results behind it.</p>`;
  }

  function metadata(s) {
    const md = s.metadata && typeof s.metadata === 'object' ? s.metadata : null;
    const usable = P.metaUsable(s);
    const errs = s.metadata_errors || [];
    const links = md && md.links && typeof md.links === 'object' ? Object.entries(md.links).filter(([, v]) => typeof v === 'string') : [];
    return `<section class="meta-sec" aria-label="Metadata"><h2>Metadata, from its author</h2>
      ${P.kv([
        ['Status', s.metadata_status === 'valid' ? 'Valid' : `Unavailable: ${P.METADATA_WORDS[s.metadata_status]}`],
        ['Link stored in the router', s.metadata_uri ? `<span class="url">${esc(s.metadata_uri)}</span>` : 'None'],
        usable && md.description ? ['Description', `<span class="author">${esc(String(md.description).slice(0, 600))}</span>`] : null,
        usable && links.length ? ['Links', links.map(([k, v]) => `${esc(k)}: <span class="url author">${esc(v)}</span>`).join('<br>')] : null,
      ])}
      ${errs.length ? `<details class="plain"><summary>What Pipeline's validator said about the document</summary><ul class="errs">${errs.map(e => `<li><code>${esc(e)}</code></li>`).join('')}</ul></details>` : ''}
      ${!usable ? `<p>With no valid metadata, this strategy is listed under its program address, and Pipescope draws no forms for it.${md ? ` <span class="proto-inline">Prototype: it did publish a document. <button type="button" class="linkish" data-action="pretend">Show the page as if it were valid</button></span>` : ''}</p>`
        : `<p class="muted">Everything in this box is the author's wording, shown as plain text and not verified. Links are never fetched or followed by Pipescope.${P.opts.metadata === 'pretend' && s.metadata_status !== 'valid' ? ` <span class="proto-inline">Prototype: the document failed validation; it is drawn here to judge the design. <button type="button" class="linkish" data-action="unpretend">Show it as it is on devnet</button></span>` : ''}</p>
           ${md.init ? `<p><a class="btn" href="${href('/create/' + s.program_id)}">Create a market on this strategy</a></p>` : ''}`}
    </section>`;
  }

  P.pages.strategy = (r, v) => {
    const s = P.S[r.parts[1]];
    if (!s) return { nav: 'feed', cls: 'missing', title: 'Strategy not found', html: `<div class="page-head"><h1>No strategy at that address</h1><p class="lede">Pipescope lists every strategy registered with Pipeline's router on devnet, and <span class="addr">${esc(r.parts[1] || '')}</span> is not one of them. <a href="#/">Back to the feed</a>.</p></div>` };
    if (r.q.get('upgraded') === '1') P.session.upgraded[s.program_id] = true;
    const name = P.stratName(s);
    const stranded = s.markets.filter(m => m.canary && m.canary.state === 'stranded').length;
    const closed = s.markets.filter(m => m.canary && m.canary.state === 'closed').length;
    const rt = P.roundTripRange(s);
    const run = s.markets.find(m => m.canary);
    const ci = (s.markets.map(m => P.rec(m, 'custom_instructions')).find(Boolean) || {}).list || [];
    const html = `<div class="page-head">
        <p class="crumbs"><a href="#/">Feed</a><span aria-hidden="true">/</span><span>Strategy</span></p>
        <h1>${name ? `<span class="author">${esc(name)}</span>` : `<span class="addr">${P.short(s.program_id)}</span>`}</h1>
        <p class="mk-meta"><span>Program ${P.addr(s.program_id)} ${P.copy(s.program_id)}</span><span>${name ? '' : 'Metadata unavailable, so it is listed under its address'}</span><span>${s.market_count} market${s.market_count === 1 ? '' : 's'}</span><span title="${P.fmtDate(s.registered_at)}">registered ${P.ago(s.registered_at)}</span><span>${P.ext(P.explorer('address', s.program_id), 'Explorer')}</span></p>
        ${P.upgradeNotice(s)}
      </div>
      <div class="st-grid">
        <div class="st-explain">${P.explainer(s)}</div>
        <div class="st-facts"><section class="panel facts" aria-label="Facts"><h2>Facts</h2><p class="muted facts-about">Read from the chain by Pipescope, worded as Pipeline's own SDK words them. No score, and no verdict.</p>${P.programFacts(s)}
          <h3>Instructions beyond Pipeline's own</h3>
          ${ci.length ? `<p class="inst">${ci.map(x => `<code>${esc(x)}</code>`).join(' ')}</p><p class="muted">Found by name in the deployed program. People call these directly on the strategy, outside the router. Canary lists them and does not call them.</p>` : '<p class="muted">None found by name in the deployed program.</p>'}
        </section></div>
      </div>
      <section class="canary-sec" aria-label="Canary results">
        <h2 class="canary-h"><span class="canary-mark" aria-hidden="true"></span>What Canary saw on this version</h2>
        ${P.pending(s) ? '<p class="muted">Tests for this version are pending.</p>' : `
        <p class="canary-about">Canary traded a private copy of each of this version's ${s.markets.length} market${s.markets.length === 1 ? '' : 's'}${run ? ` on ${P.fmtDate(run.canary.run_at, false)}` : ''}, as a trader would. ${stranded ? `${stranded} of ${s.markets.length} cannot be read by this version. ` : ''}${closed ? `${closed} refuse${closed === 1 ? 's' : ''} every trade by ${closed === 1 ? 'its' : 'their'} own rules. ` : ''}${rt ? `On the markets that trade, a 0.01 SOL buy sold straight back returned ${rt}.` : ''} Canary detects; it cannot prove a strategy safe.</p>
        ${v === 'B' ? grid(s) : byCheck(s)}`}
      </section>
      <section aria-label="Markets"><h2>Its markets</h2>${P.marketTable([...s.markets].sort((a, b) => b.created_at.localeCompare(a.created_at)), { noStrategy: true })}</section>
      <div class="st-grid st-grid-low">
        <section aria-label="Version history"><h2>Version history</h2>${history(s)}</section>
        ${metadata(s)}
      </div>`;
    return { nav: 'feed', cls: 'strategy', title: name || P.short(s.program_id), html };
  };
})();
