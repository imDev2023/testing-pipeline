// PROTOTYPE (throwaway): the market page, in two layouts, with the trade box.
// "Two layouts of the market page, switchable with ?variant=, on the one market route."
(function () {
  'use strict';
  const P = window.PS;
  const { esc, short, href, D } = P;

  P.variants.market = [['A', 'Terminal: chart and trade first'], ['B', 'Read first: findings before the chart']];

  // ---------- prices and candles, built from swap events ----------
  function tradePrice(m, x, o) {
    const b = P.mintOf(m, o.base), q = P.mintOf(m, o.quote);
    const baseAmt = P.units(x.in === o.base ? x.sent : x.got, b.decimals);
    const quoteAmt = P.units(x.in === o.quote ? x.sent : x.got, q.decimals);
    return baseAmt ? quoteAmt / baseAmt : null;
  }
  const STEP = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
  function candles(m, o, interval) {
    const step = STEP[interval];
    const rows = [];
    let prev = null;
    for (const x of [...m.trades].sort((a, b) => a.slot - b.slot)) {
      const p = tradePrice(m, x, o);
      if (p == null) continue;
      const t = Math.floor(new Date(x.t).getTime() / 1000 / step) * step;
      let c = rows[rows.length - 1];
      if (!c || c.time !== t) { c = { time: t, open: prev == null ? p : prev, high: Math.max(prev == null ? p : prev, p), low: Math.min(prev == null ? p : prev, p), close: p, n: 0 }; rows.push(c); }
      c.high = Math.max(c.high, p); c.low = Math.min(c.low, p); c.close = p; c.n++;
      prev = p;
    }
    return rows;
  }
  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  function plain(v) {
    if (v < 0) return '';
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (a >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
    if (a >= 1e-4) return String(Number(v.toPrecision(4)));
    const zeros = -Math.floor(Math.log10(a)) - 1;
    const digits = Math.round(a * 10 ** (zeros + 4)).toString().replace(/0+$/, '') || '0';
    return `0.0${String(zeros).split('').map(d => SUB[d]).join('')}${digits}`;
  }

  let chart = null;
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function drawChart(root, m) {
    const el = root.querySelector('[data-chart]');
    if (chart) { chart.remove(); chart = null; }
    if (!el || !window.LightweightCharts) return;
    const r = P.route();
    const o = orientation(m, r);
    const interval = STEP[r.q.get('iv')] ? r.q.get('iv') : '15m';
    const rows = candles(m, o, interval);
    const legend = root.querySelector('[data-chart-legend]');
    if (!rows.length) { el.innerHTML = '<p class="chart-empty">No swap has gone through Pipeline on this market yet, so there is no price to chart.</p>'; if (legend) legend.textContent = ''; return; }
    el.innerHTML = '';
    const ink = cssVar('--ink'), ink2 = cssVar('--ink2'), rule = cssVar('--rule'), sheet = cssVar('--sheet');
    const colour = P.opts.candles === 'colour';
    const up = colour ? '#1E9E6A' : sheet, down = colour ? '#D9483B' : ink, edgeUp = colour ? '#1E9E6A' : ink, edgeDown = colour ? '#D9483B' : ink;
    const L = window.LightweightCharts;
    chart = L.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: ink2, fontFamily: "Archivo, system-ui, sans-serif", fontSize: 12 },
      grid: { vertLines: { color: rule, style: 1 }, horzLines: { color: rule, style: 1 } },
      rightPriceScale: { borderColor: rule, scaleMargins: { top: 0.14, bottom: 0.1 } },
      timeScale: { borderColor: rule, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0, vertLine: { color: ink2, labelBackgroundColor: ink }, horzLine: { color: ink2, labelBackgroundColor: ink } },
      localization: { priceFormatter: plain },
    });
    const series = chart.addSeries(L.CandlestickSeries, { upColor: up, downColor: down, borderUpColor: edgeUp, borderDownColor: edgeDown, wickUpColor: edgeUp, wickDownColor: edgeDown, priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'custom', formatter: plain, minMove: 1e-15 },
      // one swap, or swaps all at one price, would give the scale no height to draw in
      autoscaleInfoProvider: orig => { const a = orig(); if (a && a.priceRange && a.priceRange.minValue === a.priceRange.maxValue) { const v = a.priceRange.minValue; a.priceRange = { minValue: v * 0.97, maxValue: v * 1.03 }; } return a; } });
    series.setData(rows.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
    chart.timeScale().setVisibleLogicalRange({ from: rows.length - (el.clientWidth < 520 ? 22 : 44), to: rows.length + 1.5 });
    const show = c => { if (legend && c) legend.innerHTML = `<span>${P.fmtDate(c.time)}</span><span>Open <b>${plain(c.open)}</b></span><span>High <b>${plain(c.high)}</b></span><span>Low <b>${plain(c.low)}</b></span><span>Close <b>${plain(c.close)}</b></span><span>${c.n} trade${c.n === 1 ? '' : 's'}</span>`; };
    show(rows[rows.length - 1]);
    chart.subscribeCrosshairMove(p => { const c = p && p.time != null ? rows.find(x => x.time === p.time) : null; show(c || rows[rows.length - 1]); });
  }
  function orientation(m, r) {
    const o = P.orient(m);
    return r.q.get('flip') === '1' ? { base: o.quote, quote: o.base } : o;
  }

  function chartPanel(m, r, o = {}) {
    const or = orientation(m, r);
    const iv = STEP[r.q.get('iv')] ? r.q.get('iv') : '15m';
    const q = Object.fromEntries(r.q);
    const last = [...m.trades].sort((a, b) => b.slot - a.slot)[0];
    const lp = last ? tradePrice(m, last, or) : null;
    if (!m.trades.length) return `<section class="panel chart-panel chart-none" aria-label="Price chart"><h2>Price</h2><p class="chart-empty">No swap has gone through Pipeline on this market yet, so there is no price to chart. The trade box gives a live quote from the strategy itself.</p></section>`;
    return `<section class="panel chart-panel${o.small ? ' chart-small' : ''}" aria-label="Price chart">
      <div class="chart-top">
        <div class="price"><span class="price-v">${lp == null ? 'No trades yet' : P.fmtPrice(lp)}</span>${lp == null ? '' : `<span class="price-u">${P.tokHtml(or.quote, { bare: true })} for one ${P.tokHtml(or.base, { bare: true })}</span><a class="flip" href="${href(r.path, { ...q, flip: q.flip === '1' ? null : '1' })}" title="Show the price the other way round">Flip</a>`}</div>
        <div class="seg seg-small" role="group" aria-label="Candle length">${Object.keys(STEP).map(k => `<a href="${href(r.path, { ...q, iv: k })}" aria-pressed="${k === iv}">${k}</a>`).join('')}</div>
      </div>
      <div class="chart" data-chart></div>
      <p class="chart-legend" data-chart-legend aria-live="off"></p>
      <p class="chart-note muted">Built from Pipeline's swap events on this market: ${m.trades.length} swap${m.trades.length === 1 ? '' : 's'} so far. Prices are in the market's own mints; there are no dollar prices on devnet.</p>
    </section>`;
  }

  function tradesPanel(m, r) {
    const or = orientation(m, r);
    if (!m.trades.length) return `<section class="trades" aria-label="Trades"><h2>Trades</h2><p class="empty">No swap has gone through Pipeline on this market yet.</p></section>`;
    const rows = [...m.trades].sort((a, b) => b.slot - a.slot).slice(0, 40).map(x => {
      const a = P.mintOf(m, x.in), b = P.mintOf(m, x.out);
      const side = x.in === or.quote ? 'Buy' : 'Sell';
      const p = tradePrice(m, x, or);
      return `<tr><td class="c-time" title="${P.fmtDate(x.t)}">${P.ago(x.t)}</td><td class="c-side side-${side.toLowerCase()}">${side}</td><td class="num c-paid"><span class="cell-l">Paid</span>${P.fmtUnits(x.sent, a.decimals)} ${P.tokHtml(x.in, { bare: true })}</td><td class="num c-got"><span class="cell-l">Received</span>${P.fmtUnits(x.got, b.decimals)} ${P.tokHtml(x.out, { bare: true })}</td><td class="num c-price">${p == null ? '-' : P.fmtPrice(p)}</td><td class="c-trader">${P.addr(x.trader)}</td><td class="c-tx">${P.ext(P.explorer('tx', x.sig), 'View')}</td></tr>`;
    }).join('');
    return `<section class="trades" aria-label="Trades"><h2>Trades</h2>
      <div class="tscroll"><table class="t t-trades"><thead><tr><th>When</th><th>Side</th><th class="num">Paid</th><th class="num">Received</th><th class="num">Price</th><th class="c-trader">Trader</th><th class="c-tx">Transaction</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${m.trades.length > 40 ? `<p class="muted more">The 40 most recent of ${m.trades.length}.</p>` : ''}</section>`;
  }

  // ---------- the trade box ----------
  const tb = {};
  function tbState(m) {
    if (!tb[m.address]) { const o = P.orient(m); tb[m.address] = { in: o.quote, out: o.base, amount: '', slip: 100, ack: false, quote: null, err: null, loading: false, review: null, seq: 0 }; }
    return tb[m.address];
  }
  function knownFailure(m, text) {
    const code = (/Custom\((\d+)\)/.exec(text) || [])[1];
    if (!code) return null;
    for (const mk of P.S[m.strategy_program].markets) for (const r of (mk.canary ? mk.canary.records : [])) if (r.failure && String(r.failure.code) === code) return r.failure;
    return null;
  }
  function balanceOf(mint) {
    if (!P.session.wallet) return null;
    if (mint === P.WSOL) return { amount: D.wallet.sol, decimals: 9 };
    const b = D.wallet.balances.find(x => x.mint === mint);
    return b ? { amount: b.amount, decimals: b.decimals } : { amount: '0', decimals: null };
  }
  function tradeBox(m) {
    const c = m.canary;
    if (c && c.state === 'stranded') {
      const s = P.S[m.strategy_program];
      return `<section class="panel tradebox tb-none" aria-label="Trade"><h2>Trade</h2>
        <p class="tb-none-lead">This market cannot be traded through Pipeline.</p>
        <p>The current version of its strategy, deployed in slot ${P.n0(s.last_deploy_slot)}, cannot read this market's state, so it can give no quote and take no swap. The market was left behind by an upgrade of the strategy.</p>
        <p class="muted">Whatever tokens its vaults hold are still there: ${m.mints.map(t => `${P.fmtUnits(t.liquidity, t.decimals)} ${P.tokHtml(t.mint, { bare: true })}`).join(' and ')}.</p></section>`;
    }
    const st = tbState(m);
    const opt = sel => m.mints.map(t => `<option value="${t.mint}"${t.mint === sel ? ' selected' : ''}>${esc(P.tokText(t.mint))}</option>`).join('');
    return `<section class="panel tradebox" aria-label="Trade" data-tradebox="${m.address}"><h2>Trade</h2>
      ${c && c.state === 'closed' ? `<p class="notice notice-plain">This market refuses every trade by its own rules (${esc(P.rec(m, 'readable').failure.name)}: ${esc(P.rec(m, 'readable').failure.message)}). A quote here returns the strategy's own error.</p>` : ''}
      <div class="tb-field"><label for="tb-amt">You pay, fees included</label>
        <div class="tb-in"><input id="tb-amt" data-tb="amount" inputmode="decimal" autocomplete="off" placeholder="0.0" value="${esc(st.amount)}"><select data-tb="in" aria-label="Token you pay with">${opt(st.in)}</select></div>
        <p class="tb-bal" data-tb-bal></p></div>
      <button type="button" class="tb-flip" data-action="tb-flip">Switch the two sides</button>
      <div class="tb-field"><span class="tb-label" id="tb-out-l">You receive, expected</span>
        <div class="tb-in tb-in-out"><output data-tb-out aria-labelledby="tb-out-l">-</output><select data-tb="out" aria-label="Token you receive">${opt(st.out)}</select></div></div>
      <div class="tb-slip"><span class="tb-label">Slippage you accept</span><div class="seg seg-small" role="group" aria-label="Slippage">${[50, 100, 300].map(b => `<button type="button" data-action="tb-slip" data-bps="${b}" aria-pressed="${st.slip === b}">${b / 100}%</button>`).join('')}<label class="slip-custom"><input data-tb="slip" inputmode="decimal" aria-label="Custom slippage, percent" placeholder="Other" value="${[50, 100, 300].includes(st.slip) ? '' : st.slip / 100}"><span>%</span></label></div></div>
      <div data-tb-dyn></div>
      <p class="tb-foot muted">One market, one hop, exact in. Every swap is simulated before your wallet is asked to sign. Devnet tokens have no value.</p>
    </section>`;
  }
  function paintTrade(root, m) {
    const box = root.querySelector('[data-tradebox]');
    if (!box) return;
    const st = tbState(m);
    const tin = P.mintOf(m, st.in), tout = P.mintOf(m, st.out);
    const feeBps = P.isFeeMint(st.in) ? P.FEE_BPS : 0;
    const q = st.quote;
    const inName = P.tokHtml(st.in, { bare: true }), outName = P.tokHtml(st.out, { bare: true });
    box.querySelector('[data-tb-out]').innerHTML = st.loading && !q ? '<span class="muted">quoting</span>' : q ? P.fmtUnits(q.amount_out, tout.decimals) : '-';
    const bal = balanceOf(st.in);
    box.querySelector('[data-tb-bal]').innerHTML = bal ? `Your balance: ${P.fmtUnits(bal.amount, bal.decimals == null ? tin.decimals : bal.decimals)} ${inName}${Number(bal.amount) > 0 ? ' <button type="button" class="linkish" data-action="tb-max">Use it all</button>' : ''}` : '';
    const amt = v => `${P.fmtUnits(v, tin.decimals)} ${inName}`;
    const minOut = q ? BigInt(q.amount_out) * BigInt(10000 - st.slip) / 10000n : null;
    const fees = `<table class="kv tb-fees"><caption>What this swap costs</caption><tbody>
      <tr><th scope="row">Goes into the market</th><td>${q ? amt(q.net_sent) : '-'}</td></tr>
      <tr><th scope="row">Pipeline fee, 0.25%</th><td>${q ? amt(q.pipeline_fee) : '-'}</td></tr>
      <tr><th scope="row">Pipescope fee, ${feeBps ? '0.5%' : 'none on this swap'}</th><td>${feeBps ? (q ? amt(q.integrator_fee) : '-') : `<span class="muted">only charged when you pay in SOL or USDC</span>`}</td></tr>
      <tr><th scope="row">The strategy's own fees and taxes</th><td>included in the quote</td></tr>
      <tr class="tb-total"><th scope="row">Leaves your wallet</th><td>${q ? amt(q.total_spend) : '-'}</td></tr>
      <tr><th scope="row">Expected output</th><td>${q ? `${P.fmtUnits(q.amount_out, tout.decimals)} ${outName}` : '-'}</td></tr>
      <tr><th scope="row">Minimum received, after ${st.slip / 100}% slippage</th><td>${q ? `${P.fmtUnits(minOut, tout.decimals)} ${outName}` : '-'}</td></tr>
    </tbody></table>`;
    let err = '';
    if (st.err) {
      const f = knownFailure(m, st.err);
      err = `<div class="tb-error" role="alert"><p><b>No quote: the ${f && f.who === 'strategy' ? 'strategy refused' : 'quote failed'}.</b> ${f ? `<code>${esc(f.name)}</code>${f.message ? `: ${esc(f.message)}` : ''}` : esc(st.err)}</p>${f ? `<p class="muted">${esc(st.err)}</p>` : ''}</div>`;
    }
    const n = m.canary && m.canary.notice;
    const notice = n ? `<div class="tb-notice"><p><b>In Canary's test on ${P.fmtDate(m.canary.run_at, false)}, ${esc(n.text)}.</b> ${n.who === 'strategy' ? 'The strategy refused the sale' : 'The sale was refused'}: ${esc(n.error)}.</p><label class="check"><input type="checkbox" data-tb="ack"${st.ack ? ' checked' : ''}><span>I have read this</span></label></div>` : '';
    let label = 'Review swap', off = false, why = '';
    if (!P.session.wallet) { label = 'Connect wallet'; }
    else if (!(parseFloat(st.amount) > 0)) { label = 'Enter an amount'; off = true; }
    else if (st.err) { label = 'Review swap'; off = true; why = 'There is no quote to build a swap from.'; }
    else if (!q) { label = 'Getting a quote'; off = true; }
    else if (n && !st.ack) { off = true; why = 'Tick the box above to say you have read it.'; }
    const button = `<button type="button" class="btn btn-primary tb-go" data-action="${P.session.wallet ? 'tb-review' : 'wallet'}"${off ? ' disabled' : ''}>${label}</button>${why ? `<p class="tb-why muted">${why}</p>` : ''}`;
    box.querySelector('[data-tb-dyn]').innerHTML = st.review ? review(m, st) : fees + err + notice + button;
  }
  function review(m, st) {
    const rv = st.review, q = rv.quote;
    const tin = P.mintOf(m, st.in), tout = P.mintOf(m, st.out);
    const minOut = BigInt(q.amount_out) * BigInt(10000 - st.slip) / 10000n;
    const head = rv.state === 'working' ? `<p class="rv-state" role="status">Building the swap and simulating it, exactly as it would be signed.</p>`
      : rv.state === 'ok' ? `<p class="rv-state rv-ok" role="status"><b>The simulation went through.</b> ${rv.units ? `It used ${P.n0(rv.units)} compute units.` : ''} This is what signing would change in your wallet:</p>`
        : rv.state === 'failed' ? `<div class="tb-error" role="alert"><p><b>The simulation failed, so there is nothing to sign.</b> ${esc(rv.error)}</p>${rv.logs && rv.logs.length ? `<details><summary>The last lines of the program log</summary><pre>${esc(rv.logs.slice(-8).join('\n'))}</pre></details>` : ''}</div>`
          : `<p class="rv-state" role="status"><b>The prototype could not reach the network to simulate.</b> In the product, the swap is built and simulated in one request, and this panel shows the outcome.</p>`;
    const changes = rv.state === 'failed' ? '' : `<table class="kv rv-changes"><tbody>
      <tr><th scope="row">${P.tokHtml(st.in, { bare: true })}</th><td>minus ${P.fmtUnits(q.total_spend, tin.decimals)}</td></tr>
      <tr><th scope="row">${P.tokHtml(st.out, { bare: true })}</th><td>plus ${P.fmtUnits(q.amount_out, tout.decimals)} expected, at least ${P.fmtUnits(minOut, tout.decimals)}</td></tr>
      <tr><th scope="row">Network fee</th><td>about 0.000005 SOL${rv.rent ? ', plus rent for a new token account' : ''}</td></tr></tbody></table>`;
    const signed = rv.signed ? `<p class="notice notice-plain" role="status">Prototype: this is where your wallet opens to sign. Nothing is signed or sent here.</p>` : '';
    return `<div class="review"><h3>Review this swap</h3>${head}${changes}${signed}
      <div class="rv-actions"><button type="button" class="btn" data-action="tb-back">Back</button><button type="button" class="btn btn-primary" data-action="tb-sign"${rv.state === 'ok' ? '' : ' disabled'}>Sign in wallet</button></div>
      <p class="muted tb-why">${rv.state === 'failed' ? 'The sign button stays off while the simulation fails.' : 'Signed in your own wallet. Pipescope never holds your keys.'}</p></div>`;
  }
  async function getQuote(root, m) {
    const st = tbState(m);
    const tin = P.mintOf(m, st.in);
    const typed = parseFloat(st.amount);
    const seq = ++st.seq;
    st.review = null;
    if (!(typed > 0)) { st.quote = null; st.err = null; st.loading = false; return paintTrade(root, m); }
    st.loading = true; paintTrade(root, m);
    const feeBps = P.isFeeMint(st.in) ? P.FEE_BPS : 0;
    // What the trader types is everything that leaves the wallet, so the amount sent to the market is worked back from it.
    const total = BigInt(Math.round(typed * 10 ** tin.decimals));
    const net = total * 10000n / BigInt(10000 + P.PIPELINE_BPS + feeBps);
    try {
      const res = await fetch(`${D.api}/v1/quote?market=${m.address}&input_mint=${st.in}&output_mint=${st.out}&amount=${net}&integrator_fee_bps=${feeBps}`);
      const body = await res.json();
      if (seq !== st.seq) return;
      if (!res.ok) { st.quote = null; st.err = body.error || `The quote service answered ${res.status}.`; }
      else { st.quote = body; st.err = null; }
    } catch (e) {
      if (seq !== st.seq) return;
      st.quote = null; st.err = 'The prototype could not reach the quote service. In the product a quote is a simulation of the strategy\'s own quote, 50 to 300 ms.';
    }
    st.loading = false;
    paintTrade(root, m);
  }
  async function doReview(root, m) {
    const st = tbState(m);
    st.review = { state: 'working', quote: st.quote };
    paintTrade(root, m);
    const rv = st.review;
    try {
      const res = await fetch(`${D.api}/v1/swap-transaction`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ market: m.address, input_mint: st.in, output_mint: st.out, amount: rv.quote.net_sent, mode: 'exact_in', trader: D.wallet.address, slippage_bps: st.slip, wrap_sol: true }) });
      const body = await res.json();
      if (!res.ok) { rv.state = 'failed'; rv.error = body.error || `The swap could not be built (${res.status}).`; }
      else {
        const sim = await (await fetch('https://api.devnet.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [body.transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }] }) })).json();
        const v = sim.result && sim.result.value;
        if (!v) { rv.state = 'offline'; }
        else if (v.err) {
          const logs = v.logs || [];
          const f = knownFailure(m, JSON.stringify(v.err).replace(/\{"Custom":(\d+)\}/, 'Custom($1)'));
          const funds = logs.some(l => /insufficient (lamports|funds)/i.test(l));
          rv.state = 'failed'; rv.logs = logs;
          rv.error = funds ? 'Your wallet does not hold enough to pay for it.' : f ? `${f.who === 'strategy' ? 'The strategy refused it' : 'It was refused'}: ${f.name}${f.message ? `, "${f.message}"` : ''}.` : `The chain answered ${JSON.stringify(v.err)}.`;
        } else { rv.state = 'ok'; rv.units = v.unitsConsumed; rv.rent = (v.logs || []).some(l => /Initialize the associated token account|InitializeAccount3/.test(l)); }
      }
    } catch (e) { rv.state = 'offline'; }
    if (st.review === rv) paintTrade(root, m);
  }

  // ---------- custom-action forms ----------
  function sourceText(src, m) {
    const idx = s => Number(s.split(':')[1]);
    if (src === 'wallet') return 'your wallet';
    if (src === 'market_state') return `this market's state, ${P.addr(m.market_state)}`;
    if (src === 'market') return `this market, ${P.addr(m.address)}`;
    if (src === 'system_program') return 'the System program';
    if (src === 'associated_token_program') return 'the Associated Token program';
    if (src.startsWith('vault:')) { const t = m.mints[idx(src)]; return t ? `the market's vault for ${P.tokHtml(t.mint, { bare: true })}, ${P.addr(t.vault)}` : esc(src); }
    if (src.startsWith('mint:')) { const t = m.mints[idx(src)]; return t ? `the mint ${P.tokHtml(t.mint)}` : esc(src); }
    if (src.startsWith('token_program:')) { const t = m.mints[idx(src)]; return t ? `${t.token_program.startsWith('Tokenz') ? 'the Token-2022 program' : 'the Token program'}` : esc(src); }
    if (src.startsWith('wallet_token_account:')) { const t = m.mints[idx(src)]; return t ? `your token account for ${P.tokHtml(t.mint, { bare: true })}` : esc(src); }
    if (src.startsWith('input:')) return `an address you enter below (<code>${esc(src.slice(6))}</code>)`;
    if (src.startsWith('fixed:')) return `a fixed address, ${P.addr(src.slice(6))}`;
    if (src.startsWith('pda:')) { const prog = src.split(':')[1]; return `an address derived from the program ${prog === 'strategy' ? 'itself' : P.addr(prog)} by a rule in the metadata`; }
    if (src.startsWith('ata:')) return 'an associated token account worked out from the metadata';
    return `<code>${esc(src)}</code>`;
  }
  const pascal = n => String(n).split('_').map(w => w[0] ? w[0].toUpperCase() + w.slice(1) : '').join('');
  function actionForm(a, i, s, m) {
    const known = (P.rec(m, 'custom_instructions') || {}).list || [];
    const match = known.includes(pascal(a.name));
    const inputs = (a.accounts || []).filter(x => String(x.source).startsWith('input:'));
    return `<details class="aform"${i === 0 ? ' open' : ''}><summary><span class="author">${esc(String(a.label || a.name).slice(0, 64))}</span><span class="aform-ix">calls <code>${esc(a.name)}</code></span></summary>
      <div class="aform-body">
        <p class="aform-fact">${P.outcome(match ? 'pass' : 'warn')} <span>Calls the instruction <code>${esc(a.name)}</code> of the program ${P.addr(s.program_id)}. ${match ? "Checked in code: an instruction of that name is in the deployed program." : 'No instruction of that name was found in the deployed program, so what this form calls could not be checked.'}</span></p>
        <p class="aform-fact">${P.glyph('noted')} <span>You sign this directly on the strategy. The router's swap protections (a minimum received, nothing taken beyond what you signed) do not apply to it.</span></p>
        <form class="aform-fields" data-aform>
          ${(a.args || []).map(g => `<label class="field"><span class="field-l"><span class="author">${esc(String(g.label || g.name).slice(0, 64))}</span> <span class="muted">${esc(g.name)}, ${esc(g.type)}${g.decimals_of ? ', in whole tokens' : ''}</span></span><input name="${esc(g.name)}" inputmode="${/^(u|i)\d+$/.test(g.type) ? 'decimal' : 'text'}" autocomplete="off" spellcheck="false"></label>`).join('')}
          ${inputs.map(x => `<label class="field"><span class="field-l">${esc(x.name)} <span class="muted">an address you enter</span></span><input name="${esc(x.name)}" autocomplete="off" spellcheck="false" placeholder="A Solana address"></label>`).join('')}
          ${!(a.args || []).length && !inputs.length ? '<p class="muted">This action takes no input.</p>' : ''}
          <h4>Every account it touches</h4>
          <div class="tscroll"><table class="t t-accounts"><thead><tr><th>Account</th><th>What it is</th><th>Can change it</th><th>Signs</th></tr></thead><tbody>
          ${(a.accounts || []).map(x => `<tr><td><code>${esc(x.name)}</code></td><td>${sourceText(String(x.source), m)}</td><td>${x.writable ? 'writable' : '<span class="muted">read only</span>'}</td><td>${x.signer ? 'signs' : '<span class="muted">does not sign</span>'}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="aform-go"><button type="button" class="btn btn-primary" data-action="${P.session.wallet ? 'aform-sim' : 'wallet'}">${P.session.wallet ? 'Simulate this action' : 'Connect wallet'}</button><span class="muted">Simulated first; you see how your balances would change before your wallet asks you to sign.</span></div>
          <div data-aform-out></div>
        </form>
      </div></details>`;
  }
  function forms(s, m) {
    if (!P.metaUsable(s)) {
      const errs = s.metadata_errors || [];
      const has = s.metadata && typeof s.metadata === 'object' && (s.metadata.actions || []).length;
      return `<section class="forms" aria-label="Actions"><h2>Actions</h2>
        <p>No forms. Pipescope builds a strategy's forms from its metadata, and this strategy's metadata is unavailable: ${P.METADATA_WORDS[s.metadata_status]}.</p>
        ${errs.length ? `<details class="plain"><summary>What Pipeline's validator said about the document</summary><ul class="errs">${errs.map(e => `<li><code>${esc(e)}</code></li>`).join('')}</ul></details>` : ''}
        <p class="muted">The deployed program has ${((P.rec(m, 'custom_instructions') || {}).list || []).length} instruction${((P.rec(m, 'custom_instructions') || {}).list || []).length === 1 ? '' : 's'} beyond Pipeline's own; they are listed under Canary's results.</p>
        ${has ? `<p class="proto-inline">Prototype: this strategy did publish a document, with ${s.metadata.actions.length} action${s.metadata.actions.length === 1 ? '' : 's'}. <button type="button" class="linkish" data-action="pretend">Show the forms it would give if it were valid</button></p>` : ''}
      </section>`;
    }
    const acts = s.metadata.actions || [];
    return `<section class="forms" aria-label="Actions"><h2>Actions</h2>
      ${P.opts.metadata === 'pretend' && s.metadata_status !== 'valid' ? `<p class="proto-inline">Prototype: this document failed Pipeline's validator, so the product would show no forms. They are drawn here to judge the form design. <button type="button" class="linkish" data-action="unpretend">Show it as it is on devnet</button></p>` : ''}
      <p class="forms-about">These forms come from the strategy's own metadata. <span class="author">Text like this</span> is the author's wording and is not verified; the instruction and accounts beside it are checked by Pipescope.</p>
      ${acts.length ? acts.map((a, i) => actionForm(a, i, s, m)).join('') : '<p class="empty">Its metadata lists no actions.</p>'}
    </section>`;
  }

  // ---------- the page ----------
  function head(m, s) {
    const c = m.canary;
    const state = c && c.state === 'stranded' ? `<p class="mk-state">${P.outcome('fail')} <span>The strategy's current version cannot read this market, so it cannot be quoted or traded through Pipeline.</span></p>`
      : c && c.state === 'closed' ? `<p class="mk-state">${P.outcome('not run')} <span>This market reads, and refuses every trade by its own rules (${esc(P.rec(m, 'readable').failure.name)}). Canary's trading checks were not run.</span></p>` : '';
    return `<div class="page-head mk-head">
      <p class="crumbs"><a href="#/">Feed</a><span aria-hidden="true">/</span>${P.stratHtml(s)}</p>
      <h1>${P.pairHtml(m)}</h1>
      <p class="mk-meta"><span>Market ${P.addr(m.address)} ${P.copy(m.address)}</span><span>on strategy ${P.stratHtml(s)}${P.metaUsable(s) ? '' : ' (metadata unavailable)'}</span><span title="${P.fmtDate(m.created_at)}">created ${P.ago(m.created_at)}</span><span>${P.ext(P.explorer('address', m.address), 'Explorer')}</span></p>
      ${state}${P.upgradeNotice(s)}
    </div>`;
  }
  function marketFacts(m, s, o = {}) {
    const canary = m.canary && !P.pending(s)
      ? `<h3 class="canary-h"><span class="canary-mark" aria-hidden="true"></span>What Canary saw</h3>${P.canaryHead(m)}${P.canaryList(m, { foldRest: o.foldRest })}`
      : `<h3 class="canary-h"><span class="canary-mark" aria-hidden="true"></span>What Canary saw</h3><p class="muted">${P.pending(s) ? 'Tests for this version are pending.' : 'Not tested yet.'}</p>`;
    return `<section class="panel facts" aria-label="Facts"><h2>Facts</h2>
      <p class="muted facts-about">Read from the chain and measured by Pipescope. No score, and no verdict.</p>
      ${o.noCanary ? '' : canary}
      <h3>This market</h3>
      ${P.kv([
        ['Market', `${P.addr(m.address)} ${P.copy(m.address)}`],
        ['Market state', P.addr(m.market_state)],
        ['Created', `${P.fmtDate(m.created_at)} by ${P.addr(m.created_by)}`],
        ['Liquidity', P.liquidityHtml(m)],
        ['Last 24 hours', `${m.stats_24h.trades} trade${m.stats_24h.trades === 1 ? '' : 's'}${m.stats_24h.trades ? `; volume ${P.volumeHtml(m).replace(/<br>/g, ', ')}` : ''}`],
        ['Exact-out swaps', m.supports_exact_out ? 'Supported by the strategy; Pipescope trades exact in only' : 'Not supported'],
      ])}
      <h3>Its strategy</h3>
      ${P.kv([
        ['Program', `<a href="${href('/strategy/' + s.program_id)}">${P.addr(s.program_id)}</a>`],
        ['Upgrade authority', s.upgradeable ? `${P.addr(s.upgrade_authority)} can replace the program's code` : 'None: frozen'],
        ['This version', `Deployed in slot ${P.n0(s.last_deploy_slot)}`],
        ['Verified build', 'None: source not verified'],
        ['Metadata', s.metadata_status === 'valid' ? 'Valid' : `Unavailable: ${P.METADATA_WORDS[s.metadata_status]}`],
      ])}${P.flagFacts(s.flags)}
      <h3>Its mints</h3>
      ${m.mints.map(P.mintFacts).join('')}
    </section>`;
  }
  function canaryBlock(m, s) {
    return `<section class="panel facts canary-first" aria-label="What Canary saw"><h2 class="canary-h"><span class="canary-mark" aria-hidden="true"></span>What Canary saw</h2>${m.canary && !P.pending(s) ? P.canaryHead(m) + P.canaryList(m, { foldRest: true }) : '<p class="muted">Tests for this version are pending.</p>'}</section>`;
  }

  P.pages.market = (r, v) => {
    const m = P.M[r.parts[1]];
    if (!m) return { nav: 'feed', cls: 'missing', title: 'Market not found', html: `<div class="page-head"><h1>No market at that address</h1><p class="lede">Pipescope lists every market registered with Pipeline's router on devnet, and <span class="addr">${esc(r.parts[1] || '')}</span> is not one of them. <a href="#/">Back to the feed</a>, or search for a mint or a strategy.</p></div>` };
    const s = P.S[m.strategy_program];
    if (r.q.get('upgraded') === '1') P.session.upgraded[s.program_id] = true;
    const html = v === 'B'
      ? `${head(m, s)}<div class="mk-B">
          <div class="b-canary">${canaryBlock(m, s)}</div>
          <aside class="b-side"><div class="mk-sticky">${chartPanel(m, r, { small: true })}${tradeBox(m)}</div></aside>
          <div class="b-rest">${P.explainer(s, { market: true })}${marketFacts(m, s, { noCanary: true })}${forms(s, m)}${tradesPanel(m, r)}</div>
        </div>`
      : `${head(m, s)}<div class="mk-top">
          <div class="a-chart">${chartPanel(m, r)}</div>
          <aside class="a-trade"><div class="mk-sticky">${tradeBox(m)}</div></aside>
          <div class="a-trades">${tradesPanel(m, r)}</div>
        </div>
        <div class="mk-low">
          <div class="mk-explain">${P.explainer(s, { market: true })}${forms(s, m)}</div>
          <div class="mk-facts">${marketFacts(m, s, { foldRest: true })}</div>
        </div>`;
    return {
      nav: 'feed', cls: 'market', title: P.pairText(m), html,
      after(root) {
        drawChart(root, m);
        paintTrade(root, m);
        const st = tb[m.address];
        if (st && parseFloat(st.amount) > 0 && !st.quote && !st.err) getQuote(root, m);
      },
    };
  };

  // events the trade box owns
  let timer = null;
  P.tradeEvents = {
    input(e, root) {
      const el = e.target.closest('[data-tb]');
      const box = e.target.closest('[data-tradebox]');
      if (!el || !box) return false;
      const m = P.M[box.dataset.tradebox], st = tbState(m);
      const k = el.dataset.tb;
      if (k === 'amount') { st.amount = el.value.replace(/[^0-9.]/g, ''); if (el.value !== st.amount) el.value = st.amount; }
      else if (k === 'slip') { const v = parseFloat(el.value); if (v > 0 && v <= 50) { st.slip = Math.round(v * 100); box.querySelectorAll('[data-action="tb-slip"]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.bps) === st.slip))); } return paintTrade(root, m), true; }
      else if (k === 'ack') { st.ack = el.checked; return paintTrade(root, m), true; }
      else if (k === 'in' || k === 'out') {
        const other = k === 'in' ? 'out' : 'in';
        st[k] = el.value;
        if (st[other] === el.value) { st[other] = m.mints.find(t => t.mint !== el.value).mint; box.querySelector(`[data-tb="${other}"]`).value = st[other]; }
      }
      st.quote = null; st.err = null;
      clearTimeout(timer);
      timer = setTimeout(() => getQuote(root, m), k === 'amount' ? 350 : 0);
      paintTrade(root, m);
      return true;
    },
    click(action, el, root) {
      const box = el.closest('[data-tradebox]');
      if (!box) return false;
      const m = P.M[box.dataset.tradebox], st = tbState(m);
      if (action === 'tb-flip') { [st.in, st.out] = [st.out, st.in]; st.amount = ''; st.quote = null; st.err = null; st.review = null; box.querySelector('[data-tb="in"]').value = st.in; box.querySelector('[data-tb="out"]').value = st.out; box.querySelector('[data-tb="amount"]').value = ''; paintTrade(root, m); return true; }
      if (action === 'tb-slip') { st.slip = Number(el.dataset.bps); box.querySelectorAll('[data-action="tb-slip"]').forEach(b => b.setAttribute('aria-pressed', String(b === el))); box.querySelector('[data-tb="slip"]').value = ''; paintTrade(root, m); return true; }
      if (action === 'tb-max') { const b = balanceOf(st.in); const t = P.mintOf(m, st.in); const v = P.units(b.amount, b.decimals == null ? t.decimals : b.decimals); st.amount = String(st.in === P.WSOL ? Math.max(0, +(v - 0.01).toFixed(6)) : v); box.querySelector('[data-tb="amount"]').value = st.amount; getQuote(root, m); return true; }
      if (action === 'tb-review') { doReview(root, m); return true; }
      if (action === 'tb-back') { st.review = null; paintTrade(root, m); return true; }
      if (action === 'tb-sign') { st.review.signed = true; paintTrade(root, m); return true; }
      return false;
    },
  };
  P.redrawChart = () => { const r = P.route(); if (r.parts[0] === 'market' && P.M[r.parts[1]]) drawChart(document, P.M[r.parts[1]]); };
  P.forms = forms;
  P.sourceText = sourceText;
})();
