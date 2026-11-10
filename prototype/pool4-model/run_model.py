"""Random runs of the Pool4 for Solana model, checking its invariants after every step."""
import copy
import random
import sys

from pool4_model import (BPS, DAY, MIN_LIQUIDITY, Params, Refused, check, place_wall, price,
                         quote, seed, settle, swap, wall_converted)


def run(seed_no: int, steps: int, verbose=False):
    rng = random.Random(seed_no)
    decimals = rng.choice([6, 9])
    tokens = rng.choice([211_111_111, 5_000, 800_000_000]) * 10 ** decimals
    sol = rng.choice([5_045_600_000, 4_000_000_000, 85_000_000_000, 100_000_000])
    p = Params(
        fee_bps=rng.choice([25, 100, 300]),
        wall_split_bps=rng.choice([0, 5000, 10_000]),
        reward_share_bps=rng.choice([0, 1500, 3000]),
        cap_floor=tokens * rng.choice([10, 2000, 10_000]) // BPS,
        cap_decay_per_day=tokens * rng.choice([0, 10, 2000, 10_000]) // BPS,
    )
    now, slot = 1_800_000_000, 1000
    m = seed(p, tokens, sol, now, slot)
    check(m)
    token_vault, sol_vault = tokens, sol
    wallet_tokens = 0          # one trader's holdings, to test round trips
    stats = dict(swaps=0, refused=0, trims=0, walls=0, wall_fills=0, ratchets=0)
    for _ in range(steps):
        now += rng.choice([0, 0, 1, 2, 30, 600, 7200, 3 * DAY])
        slot += rng.choice([0, 1, 1, 3, 100])
        act = rng.random()
        try:
            if act < 0.45:      # buy
                amt = int(sol * rng.choice([1e-9, 1e-5, 1e-3, 0.02, 0.3]) * rng.random()) + 1
                q = quote(m, False, amt)
                before = copy.deepcopy(m)
                out = swap(m, False, amt, now, slot)
                assert out == q
                sol_vault += amt
                token_vault -= out
                wallet_tokens += out
                stats['ratchets'] += m.cap < before.cap
                # immediate sell-back never profits
                back = None
                try:
                    back = quote(m, True, out)
                except Refused:
                    pass
                assert back is None or back < amt, (back, amt)
            elif act < 0.85:    # sell
                if wallet_tokens == 0:
                    continue
                amt = max(1, int(wallet_tokens * rng.choice([1e-6, 0.01, 0.3, 1.0]) * rng.random()))
                q = quote(m, True, amt)
                before = copy.deepcopy(m)
                out = swap(m, True, amt, now, slot)
                assert out == q
                token_vault += amt
                sol_vault -= out
                wallet_tokens -= amt
                stats['trims'] += m.retired_tokens > before.retired_tokens
                stats['wall_fills'] += wall_converted(m) > wall_converted(before)
                # a trim never moves the price
                assert m.sqrt_price == price(before, True, amt)[2]
                assert m.curve_tokens() <= m.cap or m.liquidity == MIN_LIQUIDITY
            elif act < 0.95:
                tip = place_wall(m)
                sol_vault -= tip
                stats['walls'] += 1
                assert m.wall_top <= m.sqrt_price and m.wall_top <= m.floor_sqrt
            else:
                burned = settle(m)
                token_vault -= burned
            stats['swaps'] += act < 0.85
        except Refused:
            stats['refused'] += 1
        check(m)
        # the vaults cover every ledger
        assert token_vault == m.pool_tokens + m.retired_tokens + m.rewards_owed, 'token vault'
        assert sol_vault == m.pool_sol + m.idle_sol + m.fees_recipient + m.fees_designer + m.fees_suite, 'sol vault'
        assert m.cap >= min(p.cap_floor, tokens)
        assert m.floor_sqrt <= m.sqrt_price
    if verbose:
        print(seed_no, stats, 'cap', m.cap * 100 // tokens, '% of seed')
    return stats


if __name__ == '__main__':
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    total = {}
    for i in range(n):
        s = run(i, 400, verbose=i < 5)
        for k, v in s.items():
            total[k] = total.get(k, 0) + v
    print('runs', n, total)
