// PROTOTYPE (throwaway): renders the page for the current hash, wires events, and draws the prototype bar.
(function () {
  'use strict';
  const P = window.PS;
  const { esc, href, D } = P;
  const app = document.getElementById('app');
  const proto = document.getElementById('proto');
  const KEY = { '': 'feed', market: 'market', strategy: 'strategy', wallet: 'wallet', create: 'create', search: 'search', fees: 'fees', 'devnet-help': 'devnet-help', decisions: 'decisions' };
  let lastPath = null, menuOpen = false;

  const pageKey = r => KEY[r.parts[0] || ''] || 'missing';
  function variantOf(r) {
    const list = P.variants[pageKey(r)];
    if (!list) return null;
    const v = (r.q.get('variant') || 'A').toUpperCase();
    return list.some(x => x[0] === v) ? v : 'A';
  }

  function render() {
    const r = P.route();
    const key = pageKey(r);
    const v = variantOf(r);
    if (r.q.get('wallet') === '1') P.session.wallet = true;
    const page = P.pages[key] ? P.pages[key](r, v) : { nav: '', cls: 'missing', title: 'Not found', html: `<div class="page-head"><h1>There is no page here</h1><p class="lede"><a href="#/">Go to the feed</a>, or search for a mint, a market or a strategy.</p></div>` };
    const active = document.activeElement;
    const wasSearch = active && active.closest && active.closest('.search');
    const caret = wasSearch ? active.selectionStart : null;
    const y = window.scrollY;
    app.innerHTML = P.shell(page, r);
    document.title = `${page.title} - Pipescope (prototype)`;
    if (page.after) page.after(app);
    if (wasSearch) { const i = app.querySelector('.search input'); i.focus(); try { i.setSelectionRange(caret, caret); } catch (e) { /* not a text input */ } }
    if (r.path !== lastPath) window.scrollTo(0, 0); else window.scrollTo(0, y);
    lastPath = r.path;
    drawBar(r, key, v);
  }

  // ---- the prototype bar: not part of the design ----
  const STATES = [
    ['A market that trades, with nothing to report', '/market/2EFM4BPqHxpQ1cGycuTXBu7Uhm6bNBGERhUCPVtv4mQp'],
    ['A buyer could not sell back (the notice in the trade box)', '/market/6efYzb4yWss5gpEmEjZxF7WkDL5Kzj4Pt6nHj1dednYp'],
    ['A round trip that returns 48.8%', '/market/2u5ep2aLFzp2SACkG5ZLUrAkEY7vCzm2vL56Q6YiQxb9'],
    ['A tax at launch that fades', '/market/51YanguqL28u3zTj8wiGgTnpUg2jN64fJFWAiXZaramH'],
    ['A token authority that could act', '/market/5A7chnyqWn3vDzaN8L7aaoMGxmE7YfjKBcKag5SSfv4T'],
    ['A stranded market: no trade box', '/market/2g5T3r4LmRtgzPvdybenUMTehJ9HxM7fT7SVMszq8KCV'],
    ['A market closed by its own rules', '/market/24UgWpWcjGxAT5L6fNMvWsUjvs1UWtWvycGozWMEwKiq'],
    ['A named token and the busiest chart', '/market/AZ5m8DNBA4XqHjpnX6b9R8sQNaGguvk8pEjPdxE1dW1E'],
    ['A strategy with stranded markets', '/strategy/4ajWF6Y3wsxXUbvvaEu7ZcA2RosB1YfaXcqot8kguwJD'],
    ['A strategy with no explanation yet', '/strategy/EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b'],
    ['Just upgraded: results pending', '/strategy/4LHmX6x7xgB2eNeuRsuF3U3huhFoyfYeddRLzsBwzvPc?upgraded=1'],
    ['Action forms from metadata (turn on "Pretend it is valid")', '/market/2aoXNhjCYpGSdRdMBcE6S4A2wQpTo4GEj9gS3PYH3SPp'],
  ];
  function drawBar(r, key, v) {
    const list = P.variants[key];
    const cur = list && list.find(x => x[0] === v);
    const seg = (k, options) => `<span class="pb-seg" role="group">${options.map(([val, label]) => `<button type="button" data-opt="${k}" data-val="${val}" aria-pressed="${P.opts[k] === val}">${label}</button>`).join('')}</span>`;
    proto.innerHTML = `<div class="pb" role="region" aria-label="Prototype controls">
      ${menuOpen ? `<div class="pb-menu">
        <p class="pb-h">Prototype options</p>
        <div class="pb-row"><span>Theme</span>${seg('theme', [['system', 'Device'], ['light', 'Light'], ['dark', 'Dark']])}</div>
        <div class="pb-row"><span>Candles</span>${seg('candles', [['ink', 'Hollow and solid'], ['colour', 'Green and red']])}</div>
        <div class="pb-row"><span>Strategy metadata</span>${seg('metadata', [['devnet', 'As on devnet'], ['pretend', 'Pretend it is valid']])}</div>
        <p class="pb-h">States worth a look</p>
        <ul class="pb-states">${STATES.map(([t, p]) => `<li><a href="#${p}">${esc(t)}</a></li>`).join('')}</ul>
      </div>` : ''}
      <div class="pb-pill">
        ${list ? `<button type="button" data-proto="prev" aria-label="Previous layout">&larr;</button><span class="pb-label">Layout ${cur[0]} of ${list.length}: ${esc(cur[1])}</span><button type="button" data-proto="next" aria-label="Next layout">&rarr;</button>` : `<span class="pb-label">Prototype</span>`}
        <button type="button" class="pb-opt" data-proto="menu" aria-expanded="${menuOpen}">${menuOpen ? 'Close' : 'Options'}</button>
      </div></div>`;
  }
  function cycle(dir) {
    const r = P.route();
    const list = P.variants[pageKey(r)];
    if (!list) return;
    const i = list.findIndex(x => x[0] === variantOf(r));
    const next = list[(i + dir + list.length) % list.length][0];
    P.setQuery({ variant: next === 'A' ? null : next });
  }

  // ---- events ----
  document.addEventListener('click', e => {
    const t = e.target;
    const pb = t.closest('[data-proto]');
    if (pb) { const a = pb.dataset.proto; if (a === 'menu') { menuOpen = !menuOpen; render(); } else cycle(a === 'next' ? 1 : -1); return; }
    const opt = t.closest('[data-opt]');
    if (opt) { P.setOpt(opt.dataset.opt, opt.dataset.val); render(); return; }
    if (menuOpen && t.closest('.pb-states a')) { menuOpen = false; }
    const cp = t.closest('[data-copy]');
    if (cp) { const v = cp.dataset.copy; try { navigator.clipboard.writeText(v); } catch (err) { /* no clipboard */ } cp.textContent = 'Copied'; setTimeout(() => { cp.textContent = 'Copy'; }, 1200); e.preventDefault(); return; }
    const ev = t.closest('[data-ev]');
    if (ev) {
      const panel = ev.closest('[data-explainer]');
      const box = panel.querySelector('.ai-evidence');
      box.open = true;
      panel.querySelectorAll('.ev-on').forEach(x => x.classList.remove('ev-on'));
      const row = document.getElementById(`ev-${panel.dataset.explainer}-${ev.dataset.ev}`);
      if (row) { row.classList.add('ev-on'); row.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
      return;
    }
    const act = t.closest('[data-action]');
    if (act) {
      const a = act.dataset.action;
      if (P.tradeEvents.click(a, act, app)) return;
      if (a === 'wallet') { if (P.session.wallet) location.hash = '#/wallet'; else { P.session.wallet = true; render(); } return; }
      if (a === 'disconnect') { P.session.wallet = false; render(); return; }
      if (a === 'unwrap-demo') { P.session.unwrapDemo = true; render(); return; }
      if (a === 'pretend') { P.setOpt('metadata', 'pretend'); render(); return; }
      if (a === 'unpretend') { P.setOpt('metadata', 'devnet'); render(); return; }
      if (a === 'wrong-open') { act.closest('[data-wrong]').innerHTML = `<label class="field"><span class="field-l">What is wrong with this explanation?</span><textarea rows="3" maxlength="600"></textarea></label><div class="rv-actions"><button type="button" class="btn" data-action="wrong-cancel">Cancel</button><button type="button" class="btn btn-primary" data-action="wrong-send">Send report</button></div>`; act.closest('section').querySelector('textarea').focus(); return; }
      if (a === 'wrong-cancel') { act.closest('[data-wrong]').innerHTML = '<button type="button" class="btn btn-quiet" data-action="wrong-open">This is wrong</button>'; return; }
      if (a === 'wrong-send') { act.closest('[data-wrong]').innerHTML = '<p class="notice notice-plain" role="status">Report sent. It reaches Pipescope\'s owner with the strategy version, prompt and model this explanation came from. (Prototype: nothing was sent.)</p>'; return; }
      if (a === 'aform-sim') { act.closest('[data-aform]').querySelector('[data-aform-out]').innerHTML = P.stub('Prototype: the product builds this transaction from the form, simulates it, and shows here whether it would succeed and how each of your balances would change. The sign button appears only after a simulation that passes. Nothing was built or sent.'); return; }
      if (a === 'unwrap') { act.closest('.unwrap').querySelector('[data-stub-out]').innerHTML = P.stub('Prototype: the product simulates closing your wrapped SOL account, shows the SOL you would get back, then asks your wallet to sign. Nothing was sent.'); return; }
    }
    const row = t.closest('tr[data-href]');
    if (row && !t.closest('a,button,input,select,label,summary')) { location.hash = row.dataset.href; }
  });
  document.addEventListener('input', e => {
    if (P.tradeEvents.input(e, app)) return;
    const s = e.target.closest('[data-search]');
    if (s) { clearTimeout(s._t); const v = e.target.value; s._t = setTimeout(() => { const h = href('/search', { q: v }); if (P.route().parts[0] === 'search') { history.replaceState(null, '', h); render(); } else location.hash = h; }, 220); }
  });
  document.addEventListener('change', e => {
    const f = e.target.closest('[data-filter]');
    if (f) {
      const form = f.closest('[data-filters]');
      const hide = [...form.querySelectorAll('input[name="hide"]:checked')].map(x => x.value).join(',');
      const open = form.querySelector('.hide-flags').open;
      P.setQuery({ liq: form.liq.value, vol: form.vol.value, age: form.age.value, hide, open: null, n: null });
      if (open) { const d = app.querySelector('.hide-flags'); if (d) d.open = true; }
    }
  });
  document.addEventListener('submit', e => {
    e.preventDefault();
    const s = e.target.closest('[data-search]');
    if (s) location.hash = href('/search', { q: s.q.value });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menuOpen) { menuOpen = false; render(); return; }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const a = document.activeElement;
    if (a && (a.matches('input,textarea,select,[contenteditable]') || a.closest('.chart'))) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    cycle(e.key === 'ArrowRight' ? 1 : -1);
  });
  window.addEventListener('hashchange', render);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (P.opts.theme === 'system') render(); });

  P.applyTheme();
  render();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => P.redrawChart());
})();
