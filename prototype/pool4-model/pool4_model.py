"""Integer model of Pool4 for Solana's step function, to check the spec's formulas.

Token index 0 is the token (x), index 1 is wSOL (y). Price is lamports per token unit.
Square-root prices are Q64.64 integers. Everything is integer arithmetic, rounded in the
market's favour, exactly as the program would compute it.
"""
from dataclasses import dataclass
from math import isqrt

Q = 1 << 64
BPS = 10_000
DAY = 86_400
MIN_SQRT = 1 << 32            # lowest square-root price a trade may reach
MAX_SQRT = 1 << 96            # highest
MIN_LIQUIDITY = 1_000_000
U64 = (1 << 64) - 1


def mul_div(a, b, d, up=False):
    n = a * b
    q, r = divmod(n, d)
    return q + (1 if up and r else 0)


def amount0_delta(sa, sb, liq, up):
    """Tokens between two square-root prices (sa <= sb) at liquidity liq."""
    if sa > sb:
        sa, sb = sb, sa
    num = liq * Q * (sb - sa)
    den = sb * sa
    q, r = divmod(num, den)
    return q + (1 if up and r else 0)


def amount1_delta(sa, sb, liq, up):
    """Lamports between two square-root prices at liquidity liq."""
    if sa > sb:
        sa, sb = sb, sa
    return mul_div(liq, sb - sa, Q, up)


def next_sqrt_from_tokens_in(s, liq, dx):
    """Price after dx tokens come in; rounded up, so the price falls no further than it should."""
    num = liq * Q
    return mul_div(num, s, num + dx * s, up=True)


def next_sqrt_from_sol_in(s, liq, dy):
    """Price after dy lamports come in; rounded down, so the price rises no further than it should."""
    return s + (dy * Q) // liq


class Refused(Exception):
    pass


@dataclass
class Params:
    fee_bps: int = 100
    designer_bps: int = 1000      # of the fee
    suite_bps: int = 1000         # of the fee
    wall_split_bps: int = 0       # of the market's part of the fee, to the buy wall
    reward_share_bps: int = 1500  # of retired tokens
    cap_floor: int = 0
    cap_decay_per_day: int = 0
    wall_threshold: int = 10_000_000
    tip_cap: int = 2_000_000
    floor_crawl_bps_per_day: int = 400     # in price terms; half of it on the square root
    ref_step_bps: int = 200                # in price terms, per 12 s
    ref_step_window: int = 12


@dataclass
class Market:
    p: Params
    sqrt_price: int = 0
    liquidity: int = 0
    wall_liquidity: int = 0
    wall_top: int = 0
    wall_sol_placed: int = 0
    # ledgers, in token units and lamports
    pool_tokens: int = 0
    pool_sol: int = 0
    retired_tokens: int = 0
    rewards_owed: int = 0
    idle_sol: int = 0
    fees_recipient: int = 0
    fees_designer: int = 0
    fees_suite: int = 0
    # cap
    cap: int = 0
    decay_credit: int = 0          # token-seconds: tokens of allowance times 86,400
    decay_time: int = 0
    # wall guard
    ref_sqrt: int = 0
    ref_time: int = 0
    floor_sqrt: int = 0
    floor_time: int = 0
    last_slot: int = 0
    last_close: int = 0
    # counters
    volume_sol: int = 0
    burned: int = 0
    paid_rewards: int = 0
    tips: int = 0

    # ---- derived holdings ----
    def curve_tokens(self, up=False):
        return mul_div(self.liquidity, Q, self.sqrt_price, up)

    def curve_sol(self, up=False):
        return mul_div(self.liquidity, self.sqrt_price, Q, up)

    def wall_sol(self, up=False):
        if not self.wall_liquidity:
            return 0
        return mul_div(self.wall_liquidity, min(self.sqrt_price, self.wall_top), Q, up)

    def wall_tokens(self, up=False):
        if not self.wall_liquidity or self.sqrt_price >= self.wall_top:
            return 0
        return amount0_delta(self.sqrt_price, self.wall_top, self.wall_liquidity, up)


def seed(p: Params, tokens: int, sol: int, now: int, slot: int) -> Market:
    m = Market(p)
    m.sqrt_price = isqrt((sol * Q * Q) // tokens)
    m.liquidity = min(tokens * m.sqrt_price // Q, sol * Q // m.sqrt_price)
    assert (1 << 40) <= m.sqrt_price <= (1 << 88) and m.liquidity >= MIN_LIQUIDITY
    m.pool_tokens, m.pool_sol = tokens, sol
    m.cap = tokens
    m.decay_time = now
    m.ref_sqrt = m.floor_sqrt = m.last_close = m.sqrt_price
    m.ref_time = m.floor_time = now
    m.last_slot = slot
    return m


def price(m: Market, sell: bool, amount: int):
    """The pure pricing function shared by quote and swap.

    Returns (amount_out, fee, new_sqrt_price, gross_sol). Changes nothing.
    """
    if amount == 0:
        raise Refused("zero input")
    fee_bps = m.p.fee_bps
    s = m.sqrt_price
    has_wall = m.wall_liquidity > 0
    if sell:
        remaining, gross = amount, 0
        for _ in range(2):
            in_wall = has_wall and s <= m.wall_top
            liq = m.liquidity + (m.wall_liquidity if in_wall else 0)
            target = MIN_SQRT if (in_wall or not has_wall) else m.wall_top
            need = amount0_delta(target, s, liq, up=True)
            if remaining >= need:
                nxt, used = target, need
            else:
                nxt, used = next_sqrt_from_tokens_in(s, liq, remaining), remaining
            gross += amount1_delta(nxt, s, liq, up=False)
            remaining -= used
            s = nxt
            if remaining == 0:
                break
        if remaining:
            raise Refused("price limit")
        fee = mul_div(gross, fee_bps, BPS, up=True)
        out = gross - fee
        if out == 0:
            raise Refused("nothing out")
        return out, fee, s, gross
    fee = mul_div(amount, fee_bps, BPS, up=True)
    remaining, out = amount - fee, 0
    if remaining == 0:
        raise Refused("nothing in after the fee")
    for _ in range(2):
        in_wall = has_wall and s < m.wall_top
        liq = m.liquidity + (m.wall_liquidity if in_wall else 0)
        target = m.wall_top if in_wall else MAX_SQRT
        need = amount1_delta(s, target, liq, up=True)
        if remaining >= need:
            nxt, used = target, need
        else:
            nxt, used = next_sqrt_from_sol_in(s, liq, remaining), remaining
        out += amount0_delta(s, nxt, liq, up=False)
        remaining -= used
        s = nxt
        if remaining == 0:
            break
    if remaining:
        raise Refused("price limit")
    if out == 0:
        raise Refused("nothing out")
    return out, fee, s, amount


def quote(m: Market, sell: bool, amount: int) -> int:
    return price(m, sell, amount)[0]


def swap(m: Market, sell: bool, amount: int, now: int, slot: int) -> int:
    out, fee, s, gross = price(m, sell, amount)
    p = m.p
    # 1. observe: the reference follows the previous slot's close, never this slot's trades
    if slot > m.last_slot:
        dt = min(now - m.ref_time, p.ref_step_window)
        step = mul_div(m.ref_sqrt, p.ref_step_bps * dt, 2 * BPS * p.ref_step_window)
        target = m.last_close
        m.ref_sqrt = max(m.ref_sqrt - step, min(m.ref_sqrt + step, target))
        m.ref_time = now
        m.last_slot = slot
    # 2. books
    if sell:
        m.pool_tokens += amount
        m.pool_sol -= gross
    else:
        m.pool_sol += amount - fee
        m.pool_tokens -= out
    designer = mul_div(fee, p.designer_bps, BPS)
    suite = mul_div(fee, p.suite_bps, BPS)
    market_part = fee - designer - suite
    to_wall = mul_div(market_part, p.wall_split_bps, BPS)
    m.fees_designer += designer
    m.fees_suite += suite
    m.fees_recipient += market_part - to_wall
    m.idle_sol += to_wall
    m.volume_sol += gross
    m.sqrt_price = s
    m.last_close = s
    # 3. the wall's floor: down at once, up slowly toward the reference
    if m.floor_sqrt < m.ref_sqrt:
        dt = min(now - m.floor_time, DAY)
        rise = mul_div(m.floor_sqrt, p.floor_crawl_bps_per_day * dt, 2 * BPS * DAY)
        m.floor_sqrt = min(m.ref_sqrt, m.floor_sqrt + rise)
    m.floor_time = now
    m.floor_sqrt = min(m.floor_sqrt, s)
    # 4. decay allowance, at most one day's worth
    m.decay_credit = min(m.decay_credit + p.cap_decay_per_day * (now - m.decay_time), p.cap_decay_per_day * DAY)
    m.decay_time = now
    # 5. cap: ratchet below it, trim above it
    held = m.curve_tokens()
    if held < m.cap:
        allowance = m.decay_credit // DAY
        nxt = max(held, m.cap - allowance, min(p.cap_floor, m.cap))
        m.decay_credit -= (m.cap - nxt) * DAY
        m.cap = nxt
    elif held > m.cap:
        new_liq = max(mul_div(m.cap, m.sqrt_price, Q), MIN_LIQUIDITY)
        if new_liq < m.liquidity:
            sol_before = m.curve_sol()
            m.liquidity = new_liq
            removed_tokens = held - m.curve_tokens(up=True)
            removed_sol = max(0, sol_before - m.curve_sol(up=True))
            m.pool_tokens -= removed_tokens
            m.pool_sol -= removed_sol
            m.retired_tokens += removed_tokens
            m.idle_sol += removed_sol
    return out


def wall_converted(m: Market) -> int:
    return m.wall_sol_placed - m.wall_sol() if m.wall_liquidity else 0


def place_wall(m: Market) -> int:
    p = m.p
    converted = wall_converted(m)
    idle_before = m.idle_sol
    idle_ready = idle_before >= p.wall_threshold
    if not (idle_ready or converted >= p.wall_threshold):
        raise Refused("nothing to do")
    # close the old wall at the current price
    if m.wall_liquidity:
        sol_now, tokens_now = m.wall_sol(), m.wall_tokens()
        m.wall_liquidity = 0
        m.pool_sol -= sol_now
        m.pool_tokens -= tokens_now
        m.idle_sol += sol_now
        m.retired_tokens += tokens_now
    # the curve keeps exactly what it needs; rounding dust joins the wall and the burn
    spare_sol = m.pool_sol - m.curve_sol(up=True)
    spare_tokens = m.pool_tokens - m.curve_tokens(up=True)
    m.pool_sol -= spare_sol
    m.idle_sol += spare_sol
    m.pool_tokens -= spare_tokens
    m.retired_tokens += spare_tokens
    work = max(idle_before if idle_ready else 0, converted)
    tip = min(p.tip_cap, mul_div(work, p.fee_bps, BPS), m.idle_sol)
    m.idle_sol -= tip
    m.tips += tip
    top = min(m.sqrt_price, m.floor_sqrt)
    m.wall_top = top
    m.wall_liquidity = mul_div(m.idle_sol, Q, top)
    m.wall_sol_placed = m.wall_sol()
    m.pool_sol += m.idle_sol
    m.idle_sol = 0
    return tip


def settle(m: Market) -> int:
    reward = mul_div(m.retired_tokens, m.p.reward_share_bps, BPS)
    burn = m.retired_tokens - reward
    m.rewards_owed += reward
    m.retired_tokens = 0
    m.burned += burn
    return burn


def check(m: Market):
    """Solvency: the pool's books always cover everything the curve and wall can pay.

    The curve and the wall are one position while the price is inside the wall, so the
    requirement is on their sum, rounded up once.
    """
    from fractions import Fraction as F
    s = m.sqrt_price
    need_sol = F(m.liquidity * s, Q)
    need_tokens = F(m.liquidity * Q, s)
    if m.wall_liquidity:
        e = min(s, m.wall_top)
        need_sol += F(m.wall_liquidity * e, Q)
        need_tokens += F(m.wall_liquidity * Q, e) - F(m.wall_liquidity * Q, m.wall_top)
    assert m.pool_sol >= need_sol, "SOL books short"
    assert m.pool_tokens >= need_tokens, "token books short"
    for v in (m.pool_tokens, m.pool_sol, m.retired_tokens, m.idle_sol, m.fees_recipient,
              m.fees_designer, m.fees_suite, m.cap, m.rewards_owed):
        assert 0 <= v <= U64
