"""Prints the worked example of docs/spec/pool4-for-solana.md, and the pump test beside it."""
import copy

from pool4_model import BPS, Params, check, place_wall, price, seed, settle, swap, wall_converted

T = 1_000_000 * 10**6
P = Params(fee_bps=100, wall_split_bps=5000, reward_share_bps=1500,
           cap_floor=T * 2000 // BPS, cap_decay_per_day=T * 2000 // BPS)


def show(m, label):
    print(f"{label}: sqrt_price={m.sqrt_price:,} liquidity={m.liquidity:,} cap={m.cap:,} "
          f"pool_tokens={m.pool_tokens:,} pool_sol={m.pool_sol:,} idle_sol={m.idle_sol:,} "
          f"retired={m.retired_tokens:,} rewards_owed={m.rewards_owed:,} "
          f"fees={m.fees_recipient:,}/{m.fees_designer:,}/{m.fees_suite:,} "
          f"wall_liquidity={m.wall_liquidity:,} wall_top={m.wall_top:,} wall_sol_placed={m.wall_sol_placed:,}")


def main():
    now, slot = 1_800_000_000, 100
    m = seed(P, T, 10 * 10**9, now, slot)
    check(m)
    show(m, 'seed')

    now += 3600
    slot += 9000
    _, fee, _, _ = price(m, False, 10**9)
    out = swap(m, False, 10**9, now, slot)
    print(f"buy 1 SOL: fee={fee:,} out={out:,}")
    show(m, 'after the buy')

    now += 60
    slot += 150
    o, fee, _, gross = price(m, True, out)
    retired, idle = m.retired_tokens, m.idle_sol
    swap(m, True, out, now, slot)
    print(f"sell them back: gross={gross:,} fee={fee:,} out={o:,} "
          f"trimmed_tokens={m.retired_tokens - retired:,} idle_gain={m.idle_sol - idle:,}")
    show(m, 'after the sell')

    tip = place_wall(m)
    print(f"place_wall: tip={tip:,}")
    show(m, 'after place_wall')

    burned = settle(m)
    print(f"settle: burned={burned:,}")

    now += 60
    slot += 150
    o, fee, _, gross = price(m, True, 20_000 * 10**6)
    swap(m, True, 20_000 * 10**6, now, slot)
    check(m)
    print(f"sell 20,000 tokens: gross={gross:,} fee={fee:,} out={o:,} "
          f"wall_spent={wall_converted(m):,} wall_bought={m.wall_tokens():,}")
    show(m, 'after the wall sell')

    # pump, place the wall in the same slot, dump: must lose
    a = seed(P, T, 10 * 10**9, now, slot)
    a.idle_sol = 5 * 10**9
    start = a.sqrt_price
    b = copy.deepcopy(a)
    spent = 30 * 10**9
    tokens = swap(b, False, spent, now, slot)
    tip = place_wall(b)
    back = swap(b, True, tokens, now, slot)
    print(f"pump test: net={back + tip - spent:,} lamports, wall top at or below the starting price: {b.wall_top <= start}")


if __name__ == '__main__':
    main()
