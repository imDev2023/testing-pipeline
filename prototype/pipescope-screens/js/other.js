// PROTOTYPE (throwaway): wallet, create market, search, the two static pages and the decisions list.
(function () {
  'use strict';
  const P = window.PS;
  const { esc, short, href, D } = P;

  const marketsOf = mint => D.markets.filter(m => m.mints.some(t => t.mint === mint));
  const stub = text => `<p class="notice notice-plain" role="status">${text}</p>`;

  // ---------- wallet ----------
  P.pages.wallet = () => {
    if (!P.session.wallet) {
      return { nav: 'wallet', cls: 'wallet', title: 'Wallet', html: `<div class="page-head"><h1>Your wallet</h1>
        <p class="lede">Connect a wallet to see its swaps through Pipeline and what it holds of the tokens that trade here.</p></div>
        <div class="prose"><p><button type="button" class="btn btn-primary" data-action="wallet">Connect wallet</button></p>
        <p>Any wallet that follows the Solana Wallet Standard works: Phantom, Solflare, Backpack and the rest. On a phone, open Pipescope in your wallet's own browser, or use Mobile Wallet Adapter on Android.</p>
        <p>Pipescope reads your address and nothing else. It never asks for a key or a seed phrase, and every transaction is signed in your wallet after a simulation you see first.</p>
        <p class="proto-inline">Prototype: connecting shows this project's own devnet wallet, ${P.addr(D.wallet.address)}, read on ${P.fmtDate(D.built_at, false)}. No wallet is opened.</p></div>` };
    }
    const w = D.wallet;
    const held = w.balances.filter(b => b.inPipeline && Number(b.amount) > 0);
    const empty = w.balances.filter(b => b.inPipeline && Number(b.amount) === 0).length;
    const other = w.balances.filter(b => !b.inPipeline).length;
    const wsol = w.balances.find(b => b.mint === P.WSOL && Number(b.amount) > 0) || (P.session.unwrapDemo ? { amount: '41250000' } : null);
    const rows = held.map(b => {
      const mk = marketsOf(b.mint);
      return `<tr><td class="c-main">${P.tokHtml(b.mint)}</td><td class="num"><span class="cell-l">Balance</span>${P.fmtUnits(b.amount, b.decimals)}</td><td class="c-where"><span class="cell-l">Trades on</span>${mk.slice(0, 3).map(m => `<a href="${href('/market/' + m.address)}">${P.pairHtml(m, { bare: true })}</a>`).join(', ')}${mk.length > 3 ? ` and ${mk.length - 3} more` : ''}</td></tr>`;
    }).join('');
    const swaps = w.trades.map(x => {
      const m = P.M[x.market];
      const a = m && P.mintOf(m, x.in), b = m && P.mintOf(m, x.out);
      return `<tr><td class="c-time" title="${P.fmtDate(x.t)}">${P.fmtDate(x.t)}</td><td class="c-main">${m ? `<a href="${href('/market/' + m.address)}">${P.pairHtml(m, { bare: true })}</a>` : P.addr(x.market)}</td><td class="num"><span class="cell-l">Paid</span>${P.fmtUnits(x.sent, a ? a.decimals : 0)} ${P.tokHtml(x.in, { bare: true })}</td><td class="num"><span class="cell-l">Received</span>${P.fmtUnits(x.got, b ? b.decimals : 0)} ${P.tokHtml(x.out, { bare: true })}</td><td class="num"><span class="cell-l">Fees</span>Pipeline ${P.fmtUnits(x.pfee, a ? a.decimals : 0)}${Number(x.ifee) ? `, Pipescope ${P.fmtUnits(x.ifee, a ? a.decimals : 0)}` : ''}</td><td class="c-tx">${P.ext(P.explorer('tx', x.sig), 'View')}</td></tr>`;
    }).join('');
    return { nav: 'wallet', cls: 'wallet', title: 'Wallet', html: `<div class="page-head"><h1>Your wallet</h1>
        <p class="mk-meta"><span>${P.addr(w.address, { full: true })} ${P.copy(w.address)}</span><span>${P.fmtUnits(w.sol, 9)} SOL</span><span>${P.ext(P.explorer('address', w.address), 'Explorer')}</span><span><button type="button" class="linkish" data-action="disconnect">Disconnect</button></span></p></div>
      ${wsol ? `<div class="panel unwrap"><p><b>You hold ${P.fmtUnits(wsol.amount, 9)} wrapped SOL.</b> Some markets pay out in wrapped SOL, which most wallets show as a separate token. Unwrapping turns it back into ordinary SOL.</p><div class="aform-go"><button type="button" class="btn btn-primary" data-action="unwrap">Unwrap ${P.fmtUnits(wsol.amount, 9)} SOL</button></div><div data-stub-out></div></div>` : ''}
      ${wsol ? '' : `<p class="proto-inline">Prototype: this wallet holds no wrapped SOL, so the offer to unwrap it does not show. <button type="button" class="linkish" data-action="unwrap-demo">Show it as it would look with 0.04125 wrapped SOL</button></p>`}
      <section aria-label="Balances"><h2>What you hold that trades on Pipeline</h2>
        ${held.length ? `<div class="tscroll"><table class="t t-wallet t-stack"><thead><tr><th>Token</th><th class="num">Balance</th><th>Trades on</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">Nothing yet. Tokens you buy on a Pipeline market show up here.</p>'}
        <p class="muted">${empty ? `${empty} empty token account${empty === 1 ? '' : 's'} left over from earlier swaps ${empty === 1 ? 'is' : 'are'} not listed. ` : ''}${other ? `${other} token${other === 1 ? '' : 's'} in this wallet ${other === 1 ? 'is' : 'are'} not listed because no Pipeline market trades ${other === 1 ? 'it' : 'them'}.` : ''} Balances are in tokens; there are no dollar prices on devnet.</p></section>
      <section aria-label="Swaps"><h2>Your swaps through Pipeline</h2>
        ${w.trades.length ? `<div class="tscroll"><table class="t t-wallet t-stack"><thead><tr><th>When</th><th>Market</th><th class="num">Paid</th><th class="num">Received</th><th class="num">Fees</th><th class="c-tx">Transaction</th></tr></thead><tbody>${swaps}</tbody></table></div>` : '<p class="empty">No swaps yet. A swap you make here shows up at once.</p>'}
        <p class="muted">Every swap this wallet made through Pipeline's router, on Pipescope or anywhere else. Trades that bypass the router leave no swap event and are not here.</p></section>` };
  };

  // ---------- create market ----------
  function initForm(s) {
    const init = s.metadata.init || {};
    const inputs = (init.accounts || []).filter(x => String(x.source).startsWith('input:'));
    const fake = { mints: [], market_state: '', address: '' };
    const ms = init.market_state;
    return `<form class="aform-fields create-form" data-aform>
      <p class="aform-fact aform-fact-solo">${P.glyph('noted')} <span>Calls the create instruction of the program ${P.addr(s.program_id)} through Pipeline's router, which records the new market. ${!ms || ms === 'new_keypair' ? 'The market\'s state gets a new address made in your browser for this one transaction; it signs once beside your wallet and is never stored.' : 'The market\'s state lives at an address derived by a rule in the metadata.'}</span></p>
      <h3>The mints, which must already exist</h3>
      ${inputs.length ? inputs.map(x => `<label class="field"><span class="field-l">${esc(x.name)} <span class="muted">a mint address${x.signer ? '; this strategy asks the mint itself to sign, so it creates the token in the same transaction' : ''}</span></span><input name="${esc(x.name)}" autocomplete="off" spellcheck="false" placeholder="A mint address"></label>`).join('') : '<p class="muted">This form asks for no mint address.</p>'}
      <h3>The market's settings</h3>
      ${(init.args || []).map(g => `<label class="field"><span class="field-l"><span class="author">${esc(String(g.label || g.name).slice(0, 64))}</span> <span class="muted">${esc(g.name)}, ${esc(g.type)}</span></span><input name="${esc(g.name)}" inputmode="${/^(u|i)\d+$/.test(g.type) ? 'numeric' : 'text'}" autocomplete="off" spellcheck="false"${g.type === 'pubkey' ? ' placeholder="A Solana address"' : ''}></label>`).join('') || '<p class="muted">This strategy takes no settings.</p>'}
      <h3>Every account it touches</h3>
      <div class="tscroll"><table class="t t-accounts"><thead><tr><th>Account</th><th>What it is</th><th>Can change it</th><th>Signs</th></tr></thead><tbody>
      <tr><td><code>creator</code></td><td>your wallet, which pays for the new accounts</td><td>writable</td><td>signs</td></tr>
      ${(init.accounts || []).map(x => `<tr><td><code>${esc(x.name)}</code></td><td>${P.sourceText(String(x.source), fake)}</td><td>${x.writable ? 'writable' : '<span class="muted">read only</span>'}</td><td>${x.signer ? 'signs' : '<span class="muted">does not sign</span>'}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="aform-go"><button type="button" class="btn btn-primary" data-action="${P.session.wallet ? 'aform-sim' : 'wallet'}">${P.session.wallet ? 'Simulate creating this market' : 'Connect wallet'}</button><span class="muted">Simulated first. You see the outcome and what it would cost in SOL before your wallet asks you to sign.</span></div>
      <div data-aform-out></div>
    </form>`;
  }
  P.pages.create = r => {
    const s = P.S[r.parts[1]];
    if (s && P.metaUsable(s) && s.metadata.init) {
      return { nav: 'create', cls: 'create', title: 'Create a market', html: `<div class="page-head"><p class="crumbs"><a href="#/create">Create a market</a><span aria-hidden="true">/</span>${P.stratHtml(s)}</p>
        <h1>Create a market on ${P.stratHtml(s, { link: false })}</h1>
        <p class="lede">This form comes from the strategy's own metadata. <span class="author">Text like this</span> is its author's wording and is not verified. Read <a href="${href('/strategy/' + s.program_id)}">what Pipescope found about this strategy</a> before you put tokens into it.</p>
        ${P.opts.metadata === 'pretend' && s.metadata_status !== 'valid' ? `<p class="proto-inline">Prototype: this document failed Pipeline's validator, so the product would offer no form here. It is drawn to judge the design. <button type="button" class="linkish" data-action="unpretend">Show it as it is on devnet</button></p>` : ''}</div>
        <div class="prose-wide">${initForm(s)}</div>` };
    }
    const list = [...D.strategies].sort((a, b) => b.registered_at.localeCompare(a.registered_at)).map(x => {
      const ok = P.metaUsable(x) && x.metadata.init;
      return `<li class="pick${ok ? '' : ' pick-off'}"><div class="pick-main">${P.stratHtml(x)}<span class="sub">${x.market_count} market${x.market_count === 1 ? '' : 's'}; upgradeable by ${P.addr(x.upgrade_authority)}</span></div>
        <div class="pick-act">${ok ? `<a class="btn" href="${href('/create/' + x.program_id)}">Use this strategy</a>` : `<span class="muted">No create form: its metadata is unavailable (${P.METADATA_WORDS[x.metadata_status]}).</span>`}</div></li>`;
    }).join('');
    const any = D.strategies.some(x => P.metaUsable(x));
    const could = D.strategies.filter(x => x.metadata && typeof x.metadata === 'object' && x.metadata.init).length;
    return { nav: 'create', cls: 'create', title: 'Create a market', html: `<div class="page-head"><h1>Create a market</h1>
      <p class="lede">A market is made from a registered strategy's own create form, with mints that already exist. Pipescope does not create tokens or register strategies; developers register a strategy from the command line.</p></div>
      ${any ? '' : `<p class="notice notice-plain">No strategy on devnet has valid metadata today, so none offers a create form here. Their markets were created from their authors' own tools.${could ? ` <span class="proto-inline">Prototype: ${could} did publish a document. <button type="button" class="linkish" data-action="pretend">Show the forms they would give if they were valid</button></span>` : ''}</p>`}
      ${any && P.opts.metadata === 'pretend' ? `<p class="proto-inline">Prototype: documents that failed validation are treated as valid here. <button type="button" class="linkish" data-action="unpretend">Show devnet as it is</button></p>` : ''}
      <h2>Choose a strategy</h2><ul class="picks">${list}</ul>` };
  };

  // ---------- search ----------
  function find(q) {
    const s = q.trim().toLowerCase();
    if (!s) return null;
    // Names match anywhere, in any case. Addresses are case-sensitive and match from their start or their end,
    // the two parts people copy or remember.
    const raw = q.trim();
    const name = v => String(v || '').toLowerCase().includes(s);
    const at = v => !!v && (v.startsWith(raw) || v.endsWith(raw));
    const strategies = D.strategies.filter(x => at(x.program_id) || (P.stratName(x) && name(P.stratName(x))));
    const mints = [...new Set(D.markets.flatMap(m => m.mints.map(t => t.mint)))].filter(a => { const t = P.tok(a); return at(a) || (t.symbol && name(t.symbol)) || (t.name && name(t.name)); });
    const markets = D.markets.filter(m => at(m.address) || at(m.market_state));
    return { strategies, mints, markets };
  }
  P.pages.search = r => {
    const q = r.q.get('q') || '';
    const res = find(q);
    const examples = `<p>Try <a href="${href('/search', { q: 'DREAM' })}">a token name</a>, <a href="${href('/search', { q: 'So1111' })}">the start of a mint address</a>, or <a href="${href('/search', { q: 'yRpt' })}">the start of a strategy address</a>.</p>`;
    let body;
    if (!res) body = `<div class="prose"><p>Type a name, a mint, a market address or a strategy address in the box at the top. Results appear as you type.</p>${examples}</div>`;
    else if (!res.strategies.length && !res.mints.length && !res.markets.length) body = `<div class="prose"><p class="empty">Nothing registered with Pipeline on devnet matches <span class="addr">${esc(q)}</span>.</p><p>Search covers strategies, markets and the mints they trade. A token that trades on no Pipeline market does not appear, and names come from each token's own metadata, so two tokens can share one.</p>${examples}</div>`;
    else {
      const mintRows = res.mints.slice(0, 20).map(a => {
        const mk = marketsOf(a); const t = P.tok(a);
        return `<li class="hit"><div class="hit-main">${P.tokHtml(a)}${t.name && !t.ours ? ` <span class="author">${esc(t.name)}</span>` : ''}<span class="sub">mint <span class="addr">${esc(a)}</span></span></div><div class="hit-side">Trades on ${mk.slice(0, 3).map(m => `<a href="${href('/market/' + m.address)}">${P.pairHtml(m, { bare: true })}</a>`).join(', ')}${mk.length > 3 ? ` and ${mk.length - 3} more` : ''}</div></li>`;
      }).join('');
      body = `${res.strategies.length ? `<section><h2>Strategies <span class="tab-n">${res.strategies.length}</span></h2><ul class="hits">${res.strategies.map(s => `<li class="hit"><div class="hit-main">${P.stratHtml(s)}<span class="sub">program <span class="addr">${esc(s.program_id)}</span></span></div><div class="hit-side">${s.market_count} market${s.market_count === 1 ? '' : 's'}${P.metaUsable(s) ? '' : '; metadata unavailable'}</div></li>`).join('')}</ul></section>` : ''}
        ${res.markets.length ? `<section><h2>Markets <span class="tab-n">${res.markets.length}</span></h2>${P.marketTable(res.markets.slice(0, 20))}</section>` : ''}
        ${res.mints.length ? `<section><h2>Mints <span class="tab-n">${res.mints.length}</span></h2><ul class="hits">${mintRows}</ul>${res.mints.length > 20 ? `<p class="muted more">The first 20 of ${res.mints.length}. Type more of the address to narrow it.</p>` : ''}<p class="muted">Token names are each token's own claim. Pipescope names only SOL and USDC itself, and marks no other token as verified, so check the mint address.</p></section>` : ''}`;
    }
    return { nav: 'search', cls: 'search', title: q ? `Search: ${q}` : 'Search', html: `<div class="page-head"><h1>${q ? `Results for <span class="addr">${esc(q)}</span>` : 'Search'}</h1></div>${body}` };
  };

  // ---------- static pages ----------
  P.pages.fees = () => ({ nav: 'fees', cls: 'static', title: 'Fees', html: `<div class="page-head"><h1>Fees</h1><p class="lede">What a swap on Pipescope costs, and who gets it. The trade box shows the same figures, in tokens, before you sign.</p></div>
    <div class="prose">
      <div class="tscroll"><table class="t t-fees t-stack"><thead><tr><th>Fee</th><th>Rate</th><th>When</th><th>Goes to</th></tr></thead><tbody>
        <tr><td class="c-main"><b>Pipeline fee</b></td><td><span class="cell-l">Rate</span>0.25%</td><td><span class="cell-l">When</span>Every swap, charged by Pipeline's router on what you pay</td><td><span class="cell-l">Goes to</span>Pipeline's treasury</td></tr>
        <tr><td class="c-main"><b>Pipescope fee</b></td><td><span class="cell-l">Rate</span>0.5%</td><td><span class="cell-l">When</span>Only when you pay in SOL or USDC. A swap paid in any other token carries none</td><td><span class="cell-l">Goes to</span>Pipescope's fee wallet</td></tr>
        <tr><td class="c-main"><b>The strategy's own fees and taxes</b></td><td><span class="cell-l">Rate</span>Set by each strategy</td><td><span class="cell-l">When</span>Inside the quote: the expected output you see is already after them</td><td><span class="cell-l">Goes to</span>Whoever the strategy says</td></tr>
        <tr><td class="c-main"><b>Solana network fee</b></td><td><span class="cell-l">Rate</span>About 0.000005 SOL</td><td><span class="cell-l">When</span>Every transaction, plus rent of about 0.002 SOL the first time you receive a token</td><td><span class="cell-l">Goes to</span>The network</td></tr>
      </tbody></table></div>
      <h2>An example</h2>
      <p>You pay 1 SOL for a token. 0.9926 SOL goes into the market, 0.0025 SOL is Pipeline's fee and 0.0050 SOL is Pipescope's, 0.75% in all. If you later sell that token for SOL, you pay Pipeline's 0.25% in the token and nothing to Pipescope.</p>
      <h2>What carries no Pipescope fee</h2>
      <ul><li>Swaps paid in any token other than SOL or USDC.</li><li>A strategy's own actions, such as adding liquidity or claiming. You sign those directly on the strategy, outside the router.</li><li>Creating a market.</li></ul>
      <h2>What the fee cannot do</h2>
      <p>The swap your wallet signs is built from exactly the rate on screen, and every swap is simulated before you sign. Pipescope never holds your tokens or your keys.</p>
    </div>` });
  P.pages['devnet-help'] = () => ({ nav: 'help', cls: 'static', title: 'Devnet help', html: `<div class="page-head"><h1>Devnet help</h1><p class="lede">Pipescope runs on Solana's devnet, a test network. Tokens there are free and worth nothing, and the network can be reset.</p></div>
    <div class="prose">
      <h2>Point your wallet at devnet</h2>
      <p>In Phantom: Settings, Developer Settings, Testnet Mode, then choose Solana Devnet. In Solflare: Settings, General, Network, Devnet. In Backpack: Settings, Solana, RPC Connection, Devnet. A wallet left on mainnet shows a mismatch when it connects, and Pipescope will not build a transaction for it.</p>
      <h2>Get devnet SOL</h2>
      <ol><li>Copy your wallet's address.</li><li>Ask a faucet for SOL. Solana's own is at <span class="url">faucet.solana.com</span>. The <code>solana airdrop</code> command no longer works against the public devnet RPC, whose faucet is closed.</li><li>Faucets limit how much each address gets a day. If one refuses, wait or try another.</li></ol>
      <p>Pipescope has no faucet of its own. One SOL is plenty: a swap costs about 0.000005 SOL in network fees.</p>
      <h2>Get devnet USDC</h2>
      <p>Circle's faucet at <span class="url">faucet.circle.com</span> sends devnet USDC, mint <span class="addr">4zMM...ncDU</span>.</p>
      <h2>What is different on devnet</h2>
      <ul><li>There are no dollar prices. Charts and amounts are in each market's own tokens.</li><li>Strategies are upgraded often, and an upgrade can leave older markets unreadable. Pipescope says so on the market's page.</li><li>Nothing here says anything about a later mainnet version of the same program.</li></ul>
    </div>` });

  // ---------- the decisions these screens rest on ----------
  const DECISIONS = [
    ['Three voices', 'How does a reader tell a chain fact from an AI\'s sentence from an author\'s claim?', 'By how the text is set: plain for what Pipescope read or measured, a serif for AI-written text, purple italic for an author\'s words (strategy names, descriptions, form labels, token names), always with the address beside a name.', 'One style for everything with small labels; icons per source.'],
    ['Outcomes without colour', 'How is a Canary outcome shown with no score, badge, green or red?', 'The word (pass, warn, fail, not run, noted) beside one of five ink shapes that get heavier the more a trader needs to look. Never counted per market.', 'Coloured dots; words only.'],
    ['What a list row says about Canary', 'What does the feed show of Canary for each market?', 'The return of a 0.01 SOL round trip as a number, and the one result a trader most needs as a short phrase.', 'A count of passes and warns (ruled out: it is a score); nothing in lists.'],
    ['Feed layout', 'Is the feed a flat table, grouped by strategy, or a log of events?', 'Proposed default A: a flat table of markets, newest first, with strategies on a second tab. B and C are in the prototype to compare.', 'B: markets grouped under their strategy with the version\'s roll-up. C: one time-ordered log.'],
    ['Market page layout', 'What comes first on a market page?', 'Proposed default A: chart and trade box on top, explanation beside the facts panel below. B is in the prototype to compare.', 'B: Canary\'s findings and the explanation first, chart and trade box in a side column.'],
    ['Canary on the strategy page', 'How are a version\'s results across its markets shown?', 'Proposed default A: one line per check with how many markets got each outcome, opening to the markets that warn or fail. B is in the prototype to compare.', 'B: a grid of markets against checks.'],
    ['The amount you type', 'Is the amount in the trade box what goes into the market, or everything that leaves the wallet?', 'Everything that leaves the wallet, fees included; the amount sent to the market is worked back from it.', 'The amount sent to the market, with fees added on top (Pipeline\'s own exact-in meaning).'],
    ['Price direction', 'Which mint is a price quoted in?', 'SOL if the market has it, else USDC, else the market\'s second mint; a Flip control turns it round.', 'Always the market\'s first mint, as Pipeline\'s hosted API does.'],
    ['Candles', 'How are up and down candles drawn?', 'Hollow for up and solid for down, in ink, so the page keeps one rule about colour.', 'Green and red, the convention on other terminals (a switch in the prototype).'],
    ['Default candle length', 'Which candle length opens first?', '15 minutes.', '1 minute; 1 hour.'],
    ['Slippage choices', 'Which slippage values are one tap away?', '0.5%, 1% (the default) and 3%, plus a box for another value up to 50%.', 'Other presets; a slider.'],
    ['Stranded and closed markets', 'What does a market that cannot trade show?', 'Stranded: no trade box, a plain statement in its place. Closed by its own rules: the trade box stays and a quote shows the strategy\'s own error, decoded.', 'Hide such markets (ruled out by the v1 scope).'],
    ['Phone layout', 'How do tables and the market page fold on a phone?', 'Each table row becomes a small labelled block; the market page stacks chart, trade box, explanation, facts.', 'Sideways-scrolling tables; a fixed Trade bar at the bottom.'],
    ['Theme', 'Light, dark or both?', 'Both, following the device, with light as the look the design was drawn in.', 'Dark only, as most terminals are.'],
  ];
  P.pages.decisions = () => ({ nav: 'decisions', cls: 'static', title: 'Decisions behind these screens', html: `<div class="page-head"><h1>Decisions behind these screens</h1><p class="lede">Every choice below is a default, and any of them can be changed. They are listed so that whoever looks at the prototype can see what it rests on and say which to change.</p></div>
    <div class="tscroll"><table class="t t-decisions t-stack"><thead><tr><th>Decision</th><th>The question</th><th>What the prototype does</th><th>Other answers</th></tr></thead><tbody>
    ${DECISIONS.map(d => `<tr><td class="c-main"><b>${esc(d[0])}</b></td><td><span class="cell-l">The question</span>${esc(d[1])}</td><td><span class="cell-l">What the prototype does</span>${esc(d[2])}</td><td><span class="cell-l">Other answers</span>${esc(d[3])}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="prose"><p class="muted">What the pages contain, the fee, the trade rules and what Canary checks were decided earlier and are in the Pipescope spec files; those are defaults that can change too.</p></div>` });
  P.DECISIONS = DECISIONS;
  P.stub = stub;
})();
