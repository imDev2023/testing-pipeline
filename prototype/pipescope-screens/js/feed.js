// PROTOTYPE (throwaway): the feed, in three layouts.
// "Three layouts of the feed, switchable with ?variant=, on the one feed route."
(function () {
  'use strict';
  const P = window.PS;
  const { esc, href, D } = P;

  P.variants.feed = [['A', 'Markets table'], ['B', 'By strategy'], ['C', 'Activity log']];

  const AGES = [['', 'Any time'], ['3600', 'In the last hour'], ['86400', 'In the last 24 hours'], ['604800', 'In the last 7 days']];
  const LIQS = [['', 'Any amount'], ['0.1', 'At least 0.1 SOL'], ['1', 'At least 1 SOL'], ['10', 'At least 10 SOL']];
  const VOLS = [['', 'Any amount'], ['0.01', 'At least 0.01 SOL'], ['0.1', 'At least 0.1 SOL'], ['1', 'At least 1 SOL']];

  function filters(r) {
    return { age: Number(r.q.get('age') || 0), liq: Number(r.q.get('liq') || 0), vol: Number(r.q.get('vol') || 0), hide: (r.q.get('hide') || '').split(',').filter(Boolean) };
  }
  function passes(m, f) {
    if (f.age && P.ageSeconds(m.created_at) > f.age) return false;
    if (f.liq) { const sol = P.mintOf(m, P.WSOL); if (!sol || P.units(sol.liquidity, 9) < f.liq) return false; }
    if (f.vol) { const v = Number((m.stats_24h.volume_by_input_mint || {})[P.WSOL] || 0) / 1e9; if (v < f.vol) return false; }
    if (f.hide.some(x => m.flags.includes(x))) return false;
    return true;
  }
  const sel = (name, label, options, value) => `<label class="field"><span class="field-l">${label}</span><select name="${name}" data-filter>${options.map(([v, t]) => `<option value="${v}"${String(value || '') === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
  function filterBar(r, f, shown, total) {
    const present = [...new Set(D.markets.flatMap(m => m.flags))].sort();
    const on = f.age || f.liq || f.vol || f.hide.length;
    return `<form class="filters" data-filters aria-label="Filter the list">
      ${sel('liq', 'Liquidity', LIQS, r.q.get('liq'))}
      ${sel('vol', 'Volume, 24 hours', VOLS, r.q.get('vol'))}
      ${sel('age', 'Created', AGES, r.q.get('age'))}
      <details class="field hide-flags"><summary><span class="field-l">Hide markets with</span><span class="fake-select">${f.hide.length ? esc(f.hide.join(', ')) : 'Nothing hidden'}</span></summary>
        <div class="pop"><p class="muted">These are Pipeline's trust flags: facts about a market's program and mints, not verdicts. Every box starts empty.</p>
        ${present.map(x => `<label class="check"><input type="checkbox" name="hide" value="${esc(x)}" data-filter${f.hide.includes(x) ? ' checked' : ''}><span><span class="flag">${esc(x)}</span> <span class="muted">${esc(D.flags[x] || '')}</span></span></label>`).join('')}</div>
      </details>
      <p class="filters-count" aria-live="polite">${on ? `Showing ${shown} of ${total} markets. <a href="${href('/', { variant: r.q.get('variant') })}">Clear the filters</a>` : `All ${total} markets are listed. Nothing is curated or hidden.`}${f.liq || f.vol ? ' Markets with no SOL side are hidden while a liquidity or volume filter is on.' : ''}</p>
    </form>`;
  }

  function marketRow(m, o = {}) {
    const s = P.S[m.strategy_program];
    return `<tr data-href="${href('/market/' + m.address)}">
      <td class="c-main"><a class="rowlink" href="${href('/market/' + m.address)}">${P.pairHtml(m)}</a><span class="sub">market ${P.addr(m.address)}</span></td>
      ${o.noStrategy ? '' : `<td class="c-strategy"><span class="cell-l">Strategy</span>${P.stratHtml(s)}${P.metaUsable(s) ? '' : '<span class="sub">Metadata unavailable</span>'}</td>`}
      <td class="c-age" title="${P.fmtDate(m.created_at)}"><span class="cell-l">Created</span>${P.ago(m.created_at)}</td>
      <td class="c-liq num"><span class="cell-l">Liquidity</span>${P.liquidityHtml(m)}</td>
      <td class="c-vol num"><span class="cell-l">Volume, 24h</span>${P.volumeHtml(m)}${m.stats_24h.trades ? `<span class="sub">${m.stats_24h.trades} trade${m.stats_24h.trades === 1 ? '' : 's'}</span>` : ''}</td>
      <td class="c-canary"><span class="cell-l">Canary's 0.01 SOL round trip</span>${P.leadHtml(m)}</td>
      <td class="c-flags"><span class="cell-l">Trust flags</span>${P.flags(m.flags)}</td>
    </tr>`;
  }
  function marketTable(list, o = {}) {
    if (!list.length) return '<p class="empty">No market matches these filters. Loosen one, or clear them all.</p>';
    return `<div class="tscroll"><table class="t t-markets${o.noStrategy ? ' t-nostrategy' : ''}"><thead><tr><th>Market</th>${o.noStrategy ? '' : '<th>Strategy</th>'}<th>Created</th><th class="num">Liquidity</th><th class="num">Volume, 24h</th><th>Canary's round trip, and what a trader most needs</th><th>Trust flags</th></tr></thead><tbody>${list.map(m => marketRow(m, o)).join('')}</tbody></table></div>`;
  }

  function strategyRow(s) {
    const stranded = s.markets.filter(m => m.canary && m.canary.state === 'stranded').length;
    const rt = P.roundTripRange(s);
    return `<tr data-href="${href('/strategy/' + s.program_id)}">
      <td class="c-main"><a class="rowlink" href="${href('/strategy/' + s.program_id)}">${P.stratHtml(s, { link: false })}</a>${P.metaUsable(s) ? '' : `<span class="sub">Metadata unavailable: ${P.METADATA_WORDS[s.metadata_status]}</span>`}</td>
      <td class="c-age" title="${P.fmtDate(s.registered_at)}"><span class="cell-l">Registered</span>${P.ago(s.registered_at)}</td>
      <td class="c-liq num"><span class="cell-l">Markets</span>${s.market_count}</td>
      <td class="c-vol"><span class="cell-l">This version</span>slot ${P.n0(s.last_deploy_slot)}<span class="sub">upgradeable by ${P.addr(s.upgrade_authority)}</span></td>
      <td class="c-canary"><span class="cell-l">Canary</span>${rt ? `<span class="rt">${rt} back</span>` : ''}${stranded ? `<span class="lead">${P.outcome('fail')} <span class="lead-t">${stranded} of ${s.markets.length} markets cannot be read by this version</span></span>` : ''}</td>
      <td class="c-flags"><span class="cell-l">Trust flags</span>${P.flags(s.flags)}</td>
    </tr>`;
  }
  const strategyTable = () => `<div class="tscroll"><table class="t t-markets t-strategies"><thead><tr><th>Strategy</th><th>Registered</th><th class="num">Markets</th><th>This version</th><th>Canary's round trip on the markets that trade</th><th>Trust flags</th></tr></thead><tbody>${[...D.strategies].sort((a, b) => b.registered_at.localeCompare(a.registered_at)).map(strategyRow).join('')}</tbody></table></div>`;

  function intro() {
    return `<div class="page-head"><h1>New on Pipeline</h1><p class="lede">${D.markets.length} markets on ${D.strategies.length} strategies, newest first. Anyone can register a strategy and Pipeline vets none of them, so every one is listed here with what Pipescope read and measured.</p></div>`;
  }

  // A: one flat table of markets, with strategies behind a second tab.
  function variantA(r) {
    const f = filters(r);
    const tab = r.q.get('tab') === 'strategies' ? 'strategies' : 'markets';
    const list = D.markets.filter(m => passes(m, f));
    const tabs = `<div class="tabs" role="tablist"><a role="tab" aria-selected="${tab === 'markets'}" href="${href('/', { ...Object.fromEntries(r.q), tab: null })}">Markets <span class="tab-n">${D.markets.length}</span></a><a role="tab" aria-selected="${tab === 'strategies'}" href="${href('/', { ...Object.fromEntries(r.q), tab: 'strategies' })}">Strategies <span class="tab-n">${D.strategies.length}</span></a></div>`;
    return intro() + tabs + (tab === 'markets' ? filterBar(r, f, list.length, D.markets.length) + marketTable(list) : strategyTable());
  }

  // B: markets grouped under the strategy that runs them, with that version's roll-up on top.
  function variantB(r) {
    const f = filters(r);
    let shown = 0;
    const groups = [...D.strategies].sort((a, b) => b.registered_at.localeCompare(a.registered_at)).map(s => {
      const list = s.markets.filter(m => passes(m, f));
      shown += list.length;
      const open = r.q.get('open') === s.program_id;
      const ru = P.rollup(s).filter(x => x.counts.fail || x.counts.warn);
      const rt = P.roundTripRange(s);
      const cut = open ? list : list.slice(0, 4);
      const time = s.history && s.history.find(h => h.slot === s.last_deploy_slot);
      return `<section class="sgroup">
        <header class="sgroup-h">
          <div class="sgroup-id"><h2>${P.stratHtml(s)}</h2>
          <p class="sgroup-facts">${P.metaUsable(s) ? '' : `Metadata unavailable. `}Upgradeable by ${P.addr(s.upgrade_authority)}. This version was deployed ${time ? P.ago(time.time) : `in slot ${P.n0(s.last_deploy_slot)}`}. ${s.market_count} market${s.market_count === 1 ? '' : 's'}.</p></div>
          <ul class="sgroup-ru">
            ${rt ? `<li><span class="ru-name">Canary's 0.01 SOL round trip, on the markets that trade</span><span class="rt">${rt} back</span></li>` : ''}
            ${ru.map(x => `<li><span class="ru-name">${esc(P.CHECK_NAME[x.check])}</span>${P.rollupSentence({ counts: { fail: x.counts.fail, warn: x.counts.warn, 'not run': 0, pass: 0, noted: 0 } }, s.markets.length)}</li>`).join('')}
          </ul>
        </header>
        ${list.length ? marketTable(cut, { noStrategy: true }) : '<p class="empty">None of its markets match these filters.</p>'}
        ${list.length > cut.length ? `<p class="more"><a href="${href('/', { ...Object.fromEntries(r.q), open: s.program_id })}">Show all ${list.length} markets of this strategy</a></p>` : ''}
      </section>`;
    }).join('');
    return intro() + filterBar(r, f, shown, D.markets.length) + groups;
  }

  // C: one time-ordered log of what happened on Pipeline.
  function events() {
    const ev = [];
    for (const s of D.strategies) {
      ev.push({ t: s.registered_at, type: 'strategy', html: `Strategy ${P.stratHtml(s)} registered, with ${P.fmtUnits(s.listing_fee_paid, 9)} SOL paid as its listing fee.` });
      const cur = s.history && s.history.find(h => h.slot === s.last_deploy_slot);
      if (cur && new Date(cur.time * 1000) - new Date(s.registered_at) > 60000) ev.push({ t: new Date(cur.time * 1000).toISOString(), type: 'upgrade', html: `Strategy ${P.stratHtml(s)} was upgraded by ${P.addr(s.upgrade_authority)}: a new version, deployed in slot ${P.n0(cur.slot)}. Canary re-ran on its ${s.market_count} market${s.market_count === 1 ? '' : 's'}.` });
    }
    for (const m of D.markets) {
      const s = P.S[m.strategy_program];
      ev.push({ t: m.created_at, type: 'market', html: `Market <a href="${href('/market/' + m.address)}">${P.pairHtml(m)}</a> created on ${P.stratHtml(s)} by ${P.addr(m.created_by)}.` });
      for (const x of m.trades) {
        const a = P.mintOf(m, x.in), b = P.mintOf(m, x.out);
        ev.push({ t: x.t, type: 'swap', html: `${P.addr(x.trader)} paid ${P.fmtUnits(x.sent, a.decimals)} ${P.tokHtml(x.in, { bare: true })} for ${P.fmtUnits(x.got, b.decimals)} ${P.tokHtml(x.out, { bare: true })} on <a href="${href('/market/' + m.address)}">${P.pairHtml(m, { bare: true })}</a>.` });
      }
    }
    return ev.sort((a, b) => b.t.localeCompare(a.t));
  }
  const TYPES = [['', 'Everything'], ['strategy', 'New strategies'], ['market', 'New markets'], ['upgrade', 'Upgrades'], ['swap', 'Swaps']];
  const TYPE_WORD = { strategy: 'New strategy', market: 'New market', upgrade: 'Upgrade', swap: 'Swap' };
  function variantC(r) {
    const show = r.q.get('show') || '';
    const all = events();
    const list = all.filter(e => !show || e.type === show);
    const n = Number(r.q.get('n') || 60);
    let day = '';
    const rows = list.slice(0, n).map(e => {
      const d = P.fmtDate(e.t, false);
      const head = d !== day ? `<li class="log-day"><h2>${d}</h2></li>` : '';
      day = d;
      return `${head}<li class="log-row log-${e.type}"><time datetime="${e.t}" title="${P.fmtDate(e.t)}">${P.fmtDate(e.t).split(', ')[1].replace(' UTC', '')}</time><span class="log-type">${TYPE_WORD[e.type]}</span><span class="log-text">${e.html}</span></li>`;
    }).join('');
    return intro() + `<div class="seg" role="group" aria-label="Show">${TYPES.map(([v, t]) => `<a href="${href('/', { variant: 'C', show: v })}" aria-pressed="${show === v}">${t} <span class="tab-n">${v ? all.filter(e => e.type === v).length : all.length}</span></a>`).join('')}</div>
      <ol class="log">${rows}</ol>
      ${list.length > n ? `<p class="more"><a href="${href('/', { variant: 'C', show, n: n + 60 })}">Show 60 earlier events</a></p>` : '<p class="muted more">That is everything since the router\'s first transaction on devnet.</p>'}`;
  }

  P.pages.feed = (r, v) => ({ nav: 'feed', cls: 'feed', title: 'Feed', html: v === 'B' ? variantB(r) : v === 'C' ? variantC(r) : variantA(r) });
  P.marketTable = marketTable;
  P.marketRow = marketRow;
})();
