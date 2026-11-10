// PROTOTYPE (throwaway): builds data.js, a snapshot of real devnet data for the Pipescope screens prototype.
// Sources, all free and keyless:
//   - Pipeline's hosted devnet API (strategies, markets, trust flags, trades, candles, one trader's trades)
//   - the Canary prototype's results on origin/prototype/canary-checks (run of 2026-11-10), turned into
//     Canary result records by the outcome rules of docs/spec/pipescope-canary.md
//   - the explainer samples on origin/prototype/explainer-samples (approved by the owner on 2026-11-10)
//   - the public devnet RPC (token names, version history, the demo wallet's balances)
// Run: node build-data.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const API = 'https://pipeline-devnet.up.railway.app';
const RPC = process.env.PROTO_RPC_URL || 'https://api.devnet.solana.com';
const DEMO_WALLET = '9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt'; // this project's devnet wallet (public address only)
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const CANARY_REF = 'origin/prototype/canary-checks:prototype/canary-checks/results/2026-11-10';
const EXPLAINER_REF = 'origin/prototype/explainer-samples:prototype/explainer-samples';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url, init, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'user-agent': 'Mozilla/5.0', ...(init?.headers || {}) } });
      if (res.status === 429) throw new Error('429');
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(600 * (i + 1));
    }
  }
}
const api = p => getJson(API + p);
let rpcId = 0;
async function rpc(method, params) {
  const out = await getJson(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) }, 5);
  if (out.error) throw new Error(`${method}: ${JSON.stringify(out.error)}`);
  return out.result;
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
const git = (...args) => execFileSync('git', args, { cwd: HERE, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ---------- base58 and program-derived addresses, with no dependencies ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  while (bytes.length < 32) bytes.unshift(0);
  return Uint8Array.from(bytes);
}
function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const P = 2n ** 255n - 19n;
const modpow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
const D = (P - 121665n) * modpow(121666n, P - 2n, P) % P;
function onCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = y * y % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = u * modpow(v, P - 2n, P) % P;
  return x2 === 0n || modpow(x2, (P - 1n) / 2n, P) === 1n;
}
function pda(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump)); h.update(b58decode(programId)); h.update('ProgramDerivedAddress');
    const out = h.digest();
    if (!onCurve(out)) return b58encode(out);
  }
  throw new Error('no pda');
}

// ---------- formatting used in code-written Canary sentences ----------
const short = a => a.slice(0, 4) + '...' + a.slice(-4);
function pct(n) {
  if (n == null) return 'n/a';
  if (n < 1) return `${+n.toPrecision(3)}%`;
  return `${n.toFixed(1)}%`;
}
function amount(units, decimals) {
  const v = Number(units) / 10 ** decimals;
  if (v === 0) return '0';
  if (v >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return String(+v.toPrecision(4)).replace(/e-(\d+)/, (_, e) => `e-${e}`).replace(/^(\d)e-(\d+)$/, (_, d, e) => '0.' + '0'.repeat(e - 1) + d);
}
const failureText = f => f ? `${f.name || f.kind}${f.message ? `, "${f.message}"` : ''}` : 'no reason given';
const refusedBy = f => f ? (f.who === 'strategy' ? 'The strategy refused' : f.who === 'router' ? 'The router refused' : f.who === 'token program' ? 'The token program refused' : 'It failed') : 'It failed';

// ---------- Canary: prototype JSON -> Canary result records (docs/spec/pipescope-canary.md) ----------
function canaryFor(raw) {
  const d = raw;
  const base = { run_at: d.run_at, slot: d.source.slot, harness: d.schema, strategy_slot: d.strategy.deploy_slot, strategy_hash: d.strategy.executable_sha256, router_slot: d.router.deploy_slot, router_hash: d.router.executable_sha256 };
  const records = [];
  const add = (check, outcome, reason, extra = {}) => records.push({ check, outcome, reason, ...extra });
  const pc = d.pipeline_check;
  const probe = d.readable.probes.find(p => p.state && p.state.kind) || d.readable.probes[0];
  const probeFail = d.readable.probes.map(p => p.state).find(s => s && s.kind);
  const tradable = (d.tradable_directions || []).length > 0;
  let state = 'trades';
  if (d.readable.unreadable) state = 'stranded';
  else if (!tradable) state = 'closed';

  // readable
  if (state === 'stranded') {
    add('readable', 'fail', `The strategy's current version cannot read this market's state (${failureText(probeFail)}). It cannot be quoted or traded through Pipeline.`, { failure: slimFailure(probeFail), brief: "the strategy's current version cannot read this market" });
  } else if (state === 'closed') {
    add('readable', 'pass', `The current version reads this market. The market refuses every trade by its own rules (${failureText(probeFail)}).`, { failure: slimFailure(probeFail), brief: `the market refuses every trade (${probeFail && probeFail.name ? probeFail.name : 'its own rules'})` });
  } else {
    add('readable', 'pass', `The current version reads this market and quotes it in ${d.tradable_directions.length} direction${d.tradable_directions.length === 1 ? '' : 's'}.`);
  }
  // conformance
  if (pc && pc.summary) {
    const s = pc.summary;
    add('conformance', s.result === 'skip' ? 'not run' : s.result, `Pipeline's own checker, pipeline-check, reported ${s.result} on this market: ${s.pass} pass, ${s.warn} warn, ${s.fail} fail, ${s.skip} skipped.`,
      { rows: (pc.checks || []).filter(c => c.status !== 'pass').map(c => [`${c.id} (${c.status})`, c.message]) });
  }

  const notRunReason = state === 'stranded'
    ? `Not run: the current version cannot read the market (${failureText(probeFail)}).`
    : `Not run: the market refuses every trade (${failureText(probeFail)}).`;
  const trading = ['exit_sizes', 'exit_hold', 'exit_late', 'exit_launch_clock', 'exit_wallets', 'exit_transferred', 'exit_queue', 'quote_matches_swap', 'cost', 'direct_call', 'token_authorities'];
  let notice = null, ordinary = null;

  if (state !== 'trades') {
    for (const c of trading) add(c, 'not run', notRunReason);
  } else {
    const e = d.exits[0];
    const m = d.mints[e.money];
    const dec = m.decimals;
    const unit = e.money_is_sol ? 'SOL' : short(m.address);
    const money = u => `${amount(u, dec)} ${unit}`;
    const vault = Number(m.vault_balance);
    const ref = e.reference_amount;
    const refSize = e.sizes.find(s => s.amount === ref) || e.sizes.find(s => s.bought && s.sold) || e.sizes[0];
    const now = refSize.returned_pct;
    ordinary = now;

    // exit_sizes
    const bought = e.sizes.filter(s => s.bought);
    const stuck = bought.filter(s => !s.sold);
    const sold = bought.filter(s => s.sold);
    const notBought = e.sizes.filter(s => !s.bought);
    const series = e.sizes.map(s => ({ label: money(s.amount), share: vault ? +(Number(s.amount) / vault * 100).toPrecision(3) : null, pct: s.bought && s.sold ? s.returned_pct : null, state: !s.bought ? 'not bought' : s.sold ? 'sold' : 'stuck' }));
    if (stuck.length) {
      const ordinaryStuck = stuck.some(s => s.amount === ref || s === e.sizes[0]);
      const f = stuck[0].sell && stuck[0].sell.failure;
      const reason = `A wallet that bought ${money(stuck[0].amount)} or more could not sell back${sold.length ? `; buys of ${money(sold[sold.length - 1].amount)} and less sold back` : ''}. ${refusedBy(f)} the sale: ${failureText(f)}.`;
      add('exit_sizes', ordinaryStuck ? 'fail' : 'warn', reason, { series, failure: slimFailure(f), brief: `buys of ${money(stuck[0].amount)} or more could not sell back` });
      notice = { check: 'exit_sizes', text: `a wallet that bought ${money(stuck[0].amount)} or more could not sell back${sold.length ? `; buys of ${money(sold[sold.length - 1].amount)} and less sold back` : ''}`, error: failureText(f), who: f ? f.who : null };
    } else {
      add('exit_sizes', 'pass', `Every size that could be bought was sold back in the same slot: ${sold.length} sizes from ${money(sold[0].amount)} to ${money(sold[sold.length - 1].amount)}.${notBought.length ? ` ${notBought.length} size${notBought.length === 1 ? '' : 's'} could not be bought, which is not a finding.` : ''}`, { series });
    }

    // exit_hold
    {
      const h = e.hold;
      const first = h[0];
      const failEarly = h.slice(0, 2).some(x => !x.sold);
      const failLater = h.slice(2).filter(x => !x.sold);
      const drop = h.filter(x => x.sold && first.returned_pct - x.returned_pct > 1);
      const ser = h.map(x => ({ label: x.wait, pct: x.sold ? x.returned_pct : null, state: x.sold ? 'sold' : 'stuck' }));
      if (failEarly) {
        const f = (h.find(x => !x.sold).sell || {}).failure;
        add('exit_hold', 'fail', `Tokens bought with ${money(ref)} could not be sold in the same slot or the next. ${refusedBy(f)} the sale: ${failureText(f)}.`, { series: ser, failure: slimFailure(f) });
        notice = notice || { check: 'exit_hold', text: `a wallet that bought ${money(ref)} could not sell back in the same slot or the next`, error: failureText(f) };
      } else if (failLater.length) {
        const f = (failLater[0].sell || {}).failure;
        add('exit_hold', 'warn', `Tokens bought with ${money(ref)} could not be sold after a wait of ${failLater[0].wait}. ${refusedBy(f)} the sale: ${failureText(f)}.`, { series: ser, failure: slimFailure(f) });
        notice = notice || { check: 'exit_hold', text: `a wallet that bought ${money(ref)} could not sell back after a wait of ${failLater[0].wait}`, error: failureText(f) };
      } else if (drop.length) {
        add('exit_hold', 'warn', `Tokens bought with ${money(ref)} sold for ${pct(first.returned_pct)} in the same slot and for ${pct(drop[0].returned_pct)} after ${drop[0].wait}.`, { series: ser });
      } else {
        add('exit_hold', 'pass', `Tokens bought with ${money(ref)} sold for ${pct(first.returned_pct)} in the same slot and within 1 point of that after each of ${h.length - 1} waits, up to ${h[h.length - 1].wait}.`, { series: ser });
      }
    }
    // exit_late and exit_launch_clock
    const timed = (check, list, passText, warnLead) => {
      const ser = list.map(x => ({ label: x.wait, pct: x.bought && x.sold ? x.returned_pct : null, state: !x.bought ? 'not bought' : x.sold ? 'sold' : 'stuck' }));
      const bad = list.filter(x => !x.bought || !x.sold || now - x.returned_pct > 1);
      if (!list.length) return add(check, 'not run', 'Not run: no clock position was in range for this market.');
      if (!bad.length) return add(check, 'pass', passText(list), { series: ser });
      const parts = list.map(x => `${x.bought && x.sold ? pct(x.returned_pct) : 'no sale'} ${x.wait}`);
      add(check, 'warn', `${warnLead} ${money(ref)} round trip returned ${parts.join(', ')}. Now it returns ${pct(now)}.`, { series: ser, brief: check === 'exit_launch_clock' ? `at launch a round trip returned ${list[0].bought && list[0].sold ? pct(list[0].returned_pct) : 'nothing'}; now ${pct(now)}` : `started later, a round trip returned ${bad[0].bought && bad[0].sold ? pct(bad[0].returned_pct) : 'nothing'}` });
    };
    timed('exit_late', e.late, l => `A ${money(ref)} round trip started after each of ${l.length} waits, up to ${l[l.length - 1].wait}, returned within 1 point of now (${pct(now)}).`, 'Started later, a');
    timed('exit_launch_clock', e.rewind, l => `With the clock set back to the market's creation and ${l.length - 1} later moments, a ${money(ref)} round trip returned within 1 point of now (${pct(now)}).`, "With the clock set back to the market's launch (today's state, an earlier clock), a");

    // exit_wallets
    {
      const ran = e.wallets.filter(w => !w.skipped);
      const skipped = e.wallets.filter(w => w.skipped);
      const fresh = ran.filter(w => w.who === 'fresh wallet');
      const insiders = ran.filter(w => w.who !== 'fresh wallet');
      const freshPcts = [...new Set(fresh.map(w => w.sold ? w.returned_pct : -1))];
      const stuckW = ran.filter(w => w.bought && !w.sold);
      const rows = [...(fresh.length ? [[`${fresh.length} fresh wallets`, fresh.every(w => w.sold) ? pct(fresh[0].returned_pct) : 'could not sell']] : []), ...insiders.map(w => [`${w.who}${w.address ? ` (${short(w.address)})` : ''}`, w.sold ? pct(w.returned_pct) : 'could not sell']), ...skipped.map(w => [`${w.who}${w.address ? ` (${short(w.address)})` : ''}`, `skipped: ${w.skipped}`])];
      const more = insiders.filter(w => w.sold && w.returned_pct > fresh[0].returned_pct + 1e-9);
      const less = insiders.filter(w => !w.sold || w.returned_pct < fresh[0].returned_pct - 1e-9);
      const who = [`${fresh.length} fresh wallets`, ...insiders.map(w => `the ${w.who}`)];
      const list = who.length > 1 ? who.slice(0, -1).join(', ') + ' and ' + who[who.length - 1] : who[0];
      const skipText = skipped.length ? ` The ${skipped.map(w => w.who).join(' and the ')} is a program's address, not a wallet, and was skipped.` : '';
      if (stuckW.length) notice = notice || { check: 'exit_wallets', text: `the ${stuckW[0].who} bought ${money(ref)} and could not sell back`, error: failureText((stuckW[0].sell || {}).failure) };
      if (freshPcts.length > 1 || more.length) add('exit_wallets', 'fail', freshPcts.length > 1 ? `Fresh wallets got different results from the same starting state.${skipText}` : `The ${more[0].who} got ${pct(more[0].returned_pct)} back where a fresh wallet got ${pct(fresh[0].returned_pct)}.${skipText}`, { rows });
      else if (less.length) add('exit_wallets', 'warn', `The ${less[0].who} got ${less[0].sold ? pct(less[0].returned_pct) : 'nothing'} back where a fresh wallet got ${pct(fresh[0].returned_pct)}.${skipText}`, { rows });
      else add('exit_wallets', 'pass', `${list[0].toUpperCase() + list.slice(1)} each round-tripped ${money(ref)} from the same starting state and all got ${pct(fresh[0].returned_pct)} back.${skipText}`, { rows });
    }
    // exit_transferred
    {
      const t = e.transfer;
      if (!t.transferred || !t.sold) {
        const f = (t.sell || {}).failure;
        add('exit_transferred', 'fail', !t.transferred ? `Tokens bought with ${money(ref)} could not be sent to a second wallet.` : `A second wallet could not sell tokens the buyer sent it. ${refusedBy(f)} the sale: ${failureText(f)}.`, { failure: slimFailure(f) });
        if (t.transferred) notice = notice || { check: 'exit_transferred', text: `a wallet that was sent tokens bought with ${money(ref)} could not sell them`, error: failureText(f) };
      } else if (t.returned_pct < 95 && now >= 95) add('exit_transferred', 'warn', `A second wallet sold tokens the buyer sent it and got back ${pct(t.returned_pct)} of what the buyer put in; the buyer's own round trip returns ${pct(now)}.`);
      else add('exit_transferred', 'pass', `A second wallet sold tokens the buyer sent it and got back ${pct(t.returned_pct)} of what the buyer put in${t.returned_pct < 95 ? ", the same as the buyer's own round trip" : ''}.`);
    }
    // exit_queue
    {
      const q = e.queue;
      const text = `Five wallets each bought ${money(ref)} in turn, then sold in the same order: ${5 - q.could_not_sell} of 5 sold and together they got back ${pct(q.returned_pct)}.`;
      const rows = (q.wallets || []).map((w, i) => [`Buyer ${i + 1}`, w.sold === false ? 'could not sell' : w.returned_pct != null ? pct(w.returned_pct) : 'sold']);
      if (q.could_not_sell > 0) notice = notice || { check: 'exit_queue', text: `${q.could_not_sell} of five wallets that bought ${money(ref)} in turn could not sell back`, error: 'see the queue check' };
      add('exit_queue', q.could_not_sell > 0 || q.returned_pct < 50 ? 'fail' : q.returned_pct < 95 ? 'warn' : 'pass', text, { rows, brief: `five buyers leaving in turn got back ${pct(q.returned_pct)}` });
    }
    // quote_matches_swap
    {
      const q = d.quote_parity;
      const bad = (q.mismatches || []).length + (q.quote_failed_swap_ok || []).length + (q.quote_ok_swap_failed || []).length;
      if (!bad) add('quote_matches_swap', 'pass', `All ${q.compared} swaps that had a quote equalled it to the unit: output, input, Pipeline fee and the trader's balance changes.`, { rows: [['Swaps sent', String(q.swaps)], ['Compared with a quote', String(q.compared)], ['Equal to the unit', String(q.matched)]] });
      else add('quote_matches_swap', 'warn', `${bad} of ${q.compared} compared swaps differed from the quote taken just before.`);
    }
    // cost
    {
      const done = e.sizes.filter(s => s.bought && s.sold);
      const lo = Math.min(...done.map(s => s.returned_pct)), hi = Math.max(...done.map(s => s.returned_pct));
      const fee = refSize.pipeline_fee_pct;
      const loss = 100 - now;
      const rest = Math.max(0, loss - (fee || 0));
      const others = done.filter(s => s !== refSize && s.returned_pct < 95);
      const outcome = now < 50 ? 'fail' : (now < 95 || others.length) ? 'warn' : 'pass';
      const where = rest < 0.02 ? `The ${pct(loss)} lost is Pipeline's fee on both legs; the strategy kept nothing more.` : `Of the ${pct(loss)} lost, Pipeline's fee on both legs was ${pct(fee)} and the rest, ${pct(rest)}, is the strategy's own fee and spread.`;
      const reason = `A ${money(refSize.amount)} buy sold straight back returned ${pct(now)}. ${where}${done.length > 1 ? ` Across ${done.length} sizes the return ran from ${pct(lo)} to ${pct(hi)}.` : ''}`;
      add('cost', outcome, reason, { split: { back: now, pipeline: fee, rest }, series: done.map(s => ({ label: money(s.amount), pct: s.returned_pct, state: 'sold' })), brief: `a ${money(refSize.amount)} round trip returned ${pct(now)}`, ref: money(refSize.amount) });
    }
    // direct_call
    {
      const b = e.bypass || [];
      const accepted = b.filter(x => x.accepted);
      const rows = b.map(x => [x.attempt, x.accepted ? 'accepted' : `refused: ${failureText(x.failure)}`]);
      if (accepted.length) add('direct_call', 'warn', `A direct call to the strategy's swap, without the router, was accepted (${accepted[0].attempt}): trades can skip the Pipeline fee and leave no swap event.`, { rows });
      else add('direct_call', 'pass', `Both direct calls to the strategy's swap, without the router, were refused (${b.map(x => (x.failure || {}).name).filter(Boolean).join(', ')}).`, { rows });
    }
    // token_authorities
    {
      const p = e.powers || [];
      const otherMint = i => d.mints[i === 0 ? 1 : 0];
      const acted = [], skippedP = [], rows = [];
      for (const x of p) {
        const mint = d.mints[x.mint];
        if (x.not_run) { skippedP.push(x); rows.push([`${x.power} of ${short(mint.address)}`, `not run: ${x.not_run} (${short(x.authority)})`]); continue; }
        if (x.power === 'mint authority') {
          const om = otherMint(x.mint);
          const ou = om.address === WSOL ? 'SOL' : short(om.address);
          acted.push(`Acting as the mint authority of ${short(mint.address)}, Canary minted 100 times what the vault holds and sold it, which took ${pct(x.took_pct)} of the ${ou} in the other vault.`);
          rows.push([`mint authority of ${short(mint.address)} (${short(x.authority)})`, `mints and sells, takes ${pct(x.took_pct)} of the other vault`]);
        } else if (x.power === 'transfer fee authority') {
          const dead = x.after && x.after.bought === false;
          acted.push(`Acting as the transfer-fee authority of ${short(mint.address)}, Canary set the fee to 100%: a ${money(ref)} buy then ${dead ? 'took the money and delivered nothing' : 'still went through'}.`);
          rows.push([`transfer-fee authority of ${short(mint.address)} (${short(x.authority)})`, dead ? 'sets the fee to 100%; a buy then delivers nothing' : 'sets the fee to 100%']);
        } else {
          acted.push(`Acting as the ${x.power} of ${short(mint.address)} changed what a holder could do.`);
          rows.push([`${x.power} of ${short(mint.address)}`, 'acted']);
        }
      }
      const top = p.filter(x => x.took_pct != null).sort((a, b) => b.took_pct - a.took_pct)[0];
      const feeAuth = p.some(x => x.power === 'transfer fee authority' && !x.not_run);
      const brief = top ? `a mint authority could mint and take ${pct(top.took_pct)} of the other vault${feeAuth ? ', and a fee authority could set a 100% transfer fee' : ''}` : 'a token authority could change what holders can do';
      if (acted.length) add('token_authorities', 'warn', acted.join(' ') + ' This is what the authority can do, not something it has done.', { rows, brief });
      else if (skippedP.length) add('token_authorities', 'not run', `Not run: the ${skippedP[0].power} of ${short(d.mints[skippedP[0].mint].address)} is a program's address (${short(skippedP[0].authority)}), not a wallet, so only that program's own instructions can use it.`, { rows });
      else add('token_authorities', 'pass', 'No mint in this market has a mint, freeze, transfer-fee, permanent-delegate or pause authority.');
    }
  }
  // transaction_accounts, contained_mint, custom_instructions (these read the program, so they run in every state)
  const tda = d.transaction_describing_accounts || [];
  if (state === 'stranded') add('transaction_accounts', 'not run', notRunReason);
  else if (tda.length) add('transaction_accounts', 'warn', `The strategy asks for ${tda.join(', ')}, so it could tell a simulated trade from a real one and these results may not hold.`);
  else add('transaction_accounts', 'pass', 'The strategy asks for no account that describes the transaction (the Instructions, SlotHashes or RecentBlockhashes sysvars).');
  const hooked = d.mints.filter(m => (m.extensions || []).includes('TransferHook'));
  add('contained_mint', hooked.length ? 'warn' : 'not run', hooked.length ? `The mint ${short(hooked[0].address)} has a transfer hook that is not our containment hook.` : 'Not run: no mint in this market has a transfer hook.');
  const ci = d.control.custom_instructions || [];
  add('custom_instructions', 'noted', ci.length ? `${ci.length} instruction${ci.length === 1 ? '' : 's'} beyond Pipeline's own, found by name in the deployed program: ${ci.join(', ')}. Canary lists them and does not call them.` : "No instruction beyond Pipeline's own was found by name in the deployed program.", { list: ci });

  return { ...base, state, ordinary, notice, records, money_is_sol: state === 'trades' ? d.exits[0].money_is_sol : null };
}
function slimFailure(f) {
  if (!f) return undefined;
  return { kind: f.kind, who: f.who, program: f.program, name: f.name, code: f.code, message: f.message, origin: f.origin, stage: f.stage };
}

// ---------- main ----------
const [health, flags, strategiesRes, marketsRes] = await Promise.all([api('/health'), api('/v1/flags'), api('/v1/strategies'), api('/v1/markets?limit=500&sort=newest')]);
const strategies = strategiesRes.strategies, markets = marketsRes.markets;
console.log(`${strategies.length} strategies, ${markets.length} markets, finalized slot ${health.finalized_slot}`);

// trades and candles per market
await pool(markets, 5, async m => {
  const [t, c] = await Promise.all([api(`/v1/markets/${m.address}/trades?limit=200`), api(`/v1/markets/${m.address}/candles?interval=1h`)]);
  m.trades = t.trades.map(x => ({ t: x.block_time, slot: x.slot, sig: x.signature, trader: x.trader, in: x.input_mint, out: x.output_mint, sent: x.net_sent, got: x.received, pfee: x.pipeline_fee, ifee: x.integrator_fee, integrator: x.integrator }));
  m.candles = { base: c.base, quote: c.quote, interval: c.interval, rows: c.candles.map(k => [k.start, +k.open, +k.high, +k.low, +k.close, +k.volume, k.trades]) };
});
console.log('trades:', markets.reduce((a, m) => a + m.trades.length, 0));

// Canary records
const canaryFiles = git('ls-tree', '--full-tree', '--name-only', CANARY_REF).split('\n').filter(f => f.endsWith('.json'));
const canary = {};
for (const f of canaryFiles) {
  const raw = JSON.parse(git('show', `${CANARY_REF}/${f}`));
  if (!raw.market) continue;
  canary[raw.market] = canaryFor(raw);
}
let withCanary = 0;
for (const m of markets) { m.canary = canary[m.address] || null; if (m.canary) withCanary++; }
console.log(`canary results for ${withCanary} of ${markets.length} markets`);

// explainer samples
const logicSrc = git('show', `${EXPLAINER_REF}/logic.js`).replace(/^export\s+/gm, '');
const dataSrc = git('show', `${EXPLAINER_REF}/data.js`);
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(`${logicSrc}\n${dataSrc}\n;globalThis.__out = { SAMPLES, PIPELINE_RULES, PROMPT_VERSION };`, ctx);
const samples = JSON.parse(JSON.stringify(ctx.__out.SAMPLES));
const explanations = {};
let fixture = null;
for (const s of samples) {
  const e = { key: s.key, program: s.program, slot: s.version && s.version.slot, generated: s.generated, hasSource: !!s.hasSource, evidence: [...ctx.__out.PIPELINE_RULES, ...s.evidence].map(x => ({ id: x.id, group: x.group, label: x.label, value: x.value, source: x.source })), output: s.outputs.pass };
  if (strategies.some(x => x.program_id === s.program)) explanations[s.program] = e; else fixture = e;
}
console.log('explanations for', Object.keys(explanations).map(short).join(', '), fixture ? `and fixture ${fixture.key}` : '');

// token names: Token-2022 metadata from the API, Metaplex metadata for the rest, from the public devnet RPC
const mintMap = new Map();
for (const m of markets) for (const t of m.mints) mintMap.set(t.mint, t);
const tokens = {};
for (const [addr, t] of mintMap) {
  const tm = t.extensions && t.extensions.token_metadata;
  if (addr === WSOL) tokens[addr] = { symbol: 'SOL', name: 'Solana', ours: true };
  else if (addr === USDC) tokens[addr] = { symbol: 'USDC', name: 'USD Coin (Circle, devnet)', ours: true };
  else if (tm && (tm.symbol || tm.name)) tokens[addr] = { symbol: tm.symbol || '', name: tm.name || '', uri: tm.uri || '', from: 'token-2022 metadata' };
}
try {
  const META = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
  const need = [...mintMap.keys()].filter(a => !tokens[a]);
  const pdas = need.map(a => pda([Buffer.from('metadata'), b58decode(META), b58decode(a)], META));
  for (let i = 0; i < pdas.length; i += 100) {
    const res = await rpc('getMultipleAccounts', [pdas.slice(i, i + 100), { encoding: 'base64' }]);
    res.value.forEach((acc, j) => {
      if (!acc) return;
      const buf = Buffer.from(acc.data[0], 'base64');
      let o = 65;
      const str = () => { const n = buf.readUInt32LE(o); o += 4; const s = buf.subarray(o, o + n).toString('utf8').replace(/\0+$/, ''); o += n; return s; };
      const name = str(), symbol = str(), uri = str();
      if (name || symbol) tokens[need[i + j]] = { symbol, name, uri, from: 'metaplex metadata' };
    });
  }
} catch (e) { console.warn('token names from RPC failed:', e.message); }
console.log(`token names: ${Object.keys(tokens).length} of ${mintMap.size} mints`);

// version history: the signatures on each strategy's ProgramData account
for (const s of strategies) {
  try {
    const sigs = await rpc('getSignaturesForAddress', [s.program.program_data_address, { limit: 25 }]);
    s.history = sigs.filter(x => !x.err).map(x => ({ sig: x.signature, slot: x.slot, time: x.blockTime }));
  } catch (e) { console.warn('history failed for', short(s.program_id), e.message); s.history = null; }
  await sleep(250);
}

// the demo wallet: its swaps through Pipeline and its balances in mints that trade in Pipeline markets
const wallet = { address: DEMO_WALLET, trades: [], balances: [], sol: null };
try {
  const t = await api(`/v1/traders/${DEMO_WALLET}/trades?limit=200`);
  wallet.trades = t.trades.map(x => ({ t: x.block_time, slot: x.slot, sig: x.signature, market: x.market, in: x.input_mint, out: x.output_mint, sent: x.net_sent, got: x.received, pfee: x.pipeline_fee, ifee: x.integrator_fee }));
  wallet.sol = (await rpc('getBalance', [DEMO_WALLET])).value;
  for (const prog of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    const r = await rpc('getTokenAccountsByOwner', [DEMO_WALLET, { programId: prog }, { encoding: 'jsonParsed' }]);
    for (const a of r.value) {
      const i = a.account.data.parsed.info;
      wallet.balances.push({ mint: i.mint, amount: i.tokenAmount.amount, decimals: i.tokenAmount.decimals, account: a.pubkey, inPipeline: mintMap.has(i.mint) });
    }
    await sleep(250);
  }
} catch (e) { console.warn('demo wallet failed:', e.message); }
console.log(`demo wallet: ${wallet.trades.length} swaps, ${wallet.balances.length} token accounts, ${wallet.sol} lamports`);

const DATA = {
  built_at: new Date().toISOString(),
  api: API,
  health: { cluster: health.cluster, finalized_slot: health.finalized_slot, last_indexed_slot: health.last_indexed_slot, last_indexed_at: health.last_indexed_at, router: health.router },
  flags: Object.fromEntries(flags.flags.map(f => [f.flag, f.description])),
  strategies, markets, tokens, explanations, explainer_fixture: fixture, wallet,
  canary_run: { date: '2026-11-10', slots: '520,628,944 to 520,629,552', pipeline: '5ad130d' },
};
const out = `// PROTOTYPE data, generated by build-data.mjs on ${DATA.built_at}. Real devnet data; do not edit by hand.\nwindow.PIPESCOPE_DATA = ${JSON.stringify(DATA)};\n`;
writeFileSync(path.join(HERE, 'data.js'), out);
console.log(`wrote data.js, ${(out.length / 1024).toFixed(0)} KB`);
