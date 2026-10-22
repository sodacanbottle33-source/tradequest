"""
TradeQuest market mode (engine v2) — independent reference implementation.

Purpose: produce golden values for the TypeScript tests WITHOUT running the TypeScript code under test
(docs/rules.md §12.9). It is written from docs/rules.md §12 in a different language and contains:

  1. the ten-stock table (copied from rules.md §12.2),
  2. derived per-stock seeds and the parameterised candle generator,
  3. a second, separate implementation of the market round rules (orders, fills, accounting),
  4. randomised trading sessions ("scenarios") whose final state the TypeScript engine must reproduce
     exactly when given the same actions.

If the TypeScript engine and this script disagree, one of them has a bug: investigate, don't just
regenerate the fixture. Regenerate only with a MARKET_ENGINE_VERSION bump.

Usage (Python 3.8+, no packages needed):
    python tools/reference_market.py > tests/fixtures/reference-market-v2.json
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# Only the already-verified RNG and rounding helpers are shared with the v1 reference.
from reference_engine import Mulberry32, normal_z, round_half_up, clamp, imul, MASK32  # noqa: E402

MARKET_ENGINE_VERSION = 2
START_CASH = 1_000_000  # $10,000.00 in cents
TOTAL_CANDLES = 70
HISTORY_LENGTH = 10
LAST_INDEX = 70
MIN_PRICE = 100
MAX_ORDER_QTY = 1_000_000

# (ticker, name, startMin, startMax, bodySigma, gapSigma, maxMove, maxGap, wickMax); drift is 0 for all.
STOCKS = [
    ("QLRX", "Quellaris Energy", 2000, 5000, 0.015, 0.002, 0.10, 0.02, 0.01),
    ("NVRA", "Novera Systems", 6000, 12000, 0.022, 0.004, 0.12, 0.03, 0.012),
    ("BRLF", "Brookleaf Foods", 800, 1500, 0.006, 0.001, 0.05, 0.01, 0.006),
    ("HLQN", "Helioquin Biotech", 1200, 4000, 0.035, 0.01, 0.15, 0.04, 0.02),
    ("MRDL", "Mardell Rail & Freight", 3500, 7000, 0.01, 0.002, 0.07, 0.015, 0.008),
    ("ZYRA", "Zyra Airways", 1500, 3500, 0.02, 0.005, 0.12, 0.03, 0.012),
    ("TVLM", "Tavelum Metals", 2500, 5500, 0.017, 0.003, 0.10, 0.025, 0.01),
    ("SKVR", "Skyvere Aerospace", 8000, 15000, 0.013, 0.003, 0.08, 0.02, 0.009),
    ("PLNB", "Pellmont Bancorp", 4500, 9500, 0.009, 0.002, 0.06, 0.015, 0.007),
    ("VRDW", "Verdane Water Utilities", 1800, 3200, 0.004, 0.0008, 0.03, 0.008, 0.005),
]
TICKERS = [s[0] for s in STOCKS]


def derive_seed(seed, index):
    h = (seed + imul(index + 1, 0x9E3779B1)) & MASK32
    h ^= h >> 16
    h = imul(h, 0x85EBCA6B)
    h ^= h >> 13
    h = imul(h, 0xC2B2AE35)
    h ^= h >> 16
    return h & MASK32


def generate(rng, spec, count=TOTAL_CANDLES):
    _t, _n, start_min, start_max, body_sigma, gap_sigma, max_move, max_gap, wick_max = spec
    start = start_min + math.floor(rng.next() * (start_max - start_min + 1))
    out = []
    prev_close = None
    for i in range(1, count + 1):
        z_gap = normal_z(rng)
        z_body = normal_z(rng)
        u_up = rng.next()
        u_down = rng.next()
        if i == 1:
            o = start
        else:
            gap = clamp(gap_sigma * z_gap, -max_gap, max_gap)
            o = max(MIN_PRICE, round_half_up(prev_close * (1 + gap)))
        ret = clamp(0 + body_sigma * z_body, -max_move, max_move)
        c = max(MIN_PRICE, round_half_up(o * (1 + ret)))
        h = round_half_up(max(o, c) * (1 + u_up * wick_max))
        lo = max(MIN_PRICE, round_half_up(min(o, c) * (1 - u_down * wick_max)))
        out.append([o, h, lo, c])  # [open, high, low, close]
        prev_close = c
    return out


def generate_market(seed):
    market = {}
    for i, spec in enumerate(STOCKS):
        market[spec[0]] = generate(Mulberry32(derive_seed(seed, i)), spec)
    return market


# ---------------------------------------------------------------------------------------------
# A second implementation of the market round rules (rules.md §12.4–12.8)
# ---------------------------------------------------------------------------------------------

def round_half_up_ratio(a, b):
    return (2 * a + b) // (2 * b)


def parse_quantity(text):
    if not text or text[0] not in "123456789" or not text.isascii() or not text.isdigit():
        return None
    if len(text) > 7 or int(text) > MAX_ORDER_QTY:
        return None
    return int(text)


class Sim:
    def __init__(self, seed):
        self.seed = seed
        self.candles = generate_market(seed)
        self.reset()

    def reset(self):
        self.k = HISTORY_LENGTH
        self.status = "PLAYING"
        self.cash = START_CASH
        self.pos = {t: [0, 0, 0] for t in TICKERS}  # shares, cost basis, realized pnl
        self.pending = []  # dicts: ticker, side, qty, seq
        self.trades = []
        self.next_seq = 1

    def mark(self, ticker):
        return self.candles[ticker][self.k - 1][3]  # close of candle k

    def reserved(self, except_ticker=None):
        total = 0
        for o in self.pending:
            if o["side"] == "BUY" and o["ticker"] != except_ticker:
                total += o["qty"] * self.mark(o["ticker"])
        return total

    def max_affordable(self, ticker):
        power = max(0, self.cash - self.reserved(ticker))
        return power // self.mark(ticker)

    # --- actions ---
    def submit(self, ticker, side, text):
        if self.status != "PLAYING" or self.k >= LAST_INDEX or ticker not in self.pos:
            return
        qty = parse_quantity(text)
        if qty is None:
            return
        if side == "SELL":
            held = self.pos[ticker][0]
            if held == 0 or qty > held:
                return
        else:
            mark = self.mark(ticker)
            power = max(0, self.cash - self.reserved(ticker))
            if qty * mark > power:
                return
        self.pending = [o for o in self.pending if o["ticker"] != ticker]
        self.pending.append({"ticker": ticker, "side": side, "qty": qty, "seq": self.next_seq})
        self.next_seq += 1

    def cancel(self, ticker):
        if self.status != "PLAYING":
            return
        self.pending = [o for o in self.pending if o["ticker"] != ticker]

    def buy(self, ticker, qty, price):
        cost = qty * price
        p = self.pos[ticker]
        self.cash -= cost
        p[0] += qty
        p[1] += cost
        return cost

    def sell(self, ticker, qty, price):
        p = self.pos[ticker]
        proceeds = qty * price
        removed = round_half_up_ratio(p[1] * qty, p[0])
        pnl = proceeds - removed
        self.cash += proceeds
        p[0] -= qty
        p[1] -= removed
        p[2] += pnl
        return proceeds, pnl

    def record(self, typ, ticker, side, candle_index, qty, price, amount, pnl):
        self.trades.append([len(self.trades) + 1, typ, ticker, side, candle_index, qty, price, amount, pnl,
                            self.cash, self.pos[ticker][0]])

    def advance(self):
        if self.status != "PLAYING" or self.k >= LAST_INDEX:
            return
        nxt = self.k + 1
        ordered = sorted(self.pending, key=lambda o: (0 if o["side"] == "SELL" else 1, o["seq"]))
        for o in ordered:
            t, qty = o["ticker"], o["qty"]
            price = self.candles[t][nxt - 1][0]  # open of the next candle
            if o["side"] == "BUY":
                if qty * price <= self.cash:
                    cost = self.buy(t, qty, price)
                    self.record("player", t, "BUY", nxt, qty, price, cost, None)
            elif qty <= self.pos[t][0]:
                proceeds, pnl = self.sell(t, qty, price)
                self.record("player", t, "SELL", nxt, qty, price, proceeds, pnl)
        self.pending = []
        self.k = nxt

    def finish(self):
        if self.status != "PLAYING" or self.k != LAST_INDEX:
            return
        for t in TICKERS:
            held = self.pos[t][0]
            if held > 0:
                price = self.candles[t][LAST_INDEX - 1][3]
                proceeds, pnl = self.sell(t, held, price)
                self.record("liquidation", t, "SELL", LAST_INDEX, held, price, proceeds, pnl)
        self.status = "FINISHED"
        self.pending = []

    def snapshot(self):
        return {
            "k": self.k,
            "status": self.status,
            "cash": self.cash,
            "positions": {t: list(self.pos[t]) for t in TICKERS},
            "pending": [[o["ticker"], o["side"], o["qty"], o["seq"]] for o in self.pending],
            "trades": self.trades,
        }


INVALID_TEXT = ["0", "-3", "1.5", "", " ", "abc", "1e3", "+5", " 5", "05", "1000001", "99999999"]


def random_scenario(seed, steps):
    """A scripted random session. Every action is recorded so the TypeScript engine can replay it."""
    sim = Sim(seed)
    rng = Mulberry32((seed ^ 0x5BD1E995) & MASK32)
    actions = []
    cash_after_advance = []
    finishes = []  # [cash, total realized pnl, number of trades] after each finish
    replays = 0
    for _ in range(steps):
        r = rng.next()
        if sim.status == "FINISHED":
            # Mostly start a new round; sometimes poke a finished round to check that nothing changes.
            if r < 0.6:
                actions.append(["replay"])
                sim.reset()
                replays += 1
            elif r < 0.75:
                actions.append(["advance"])
                sim.advance()
                cash_after_advance.append(sim.cash)
            elif r < 0.9:
                ticker = TICKERS[int(rng.next() * len(TICKERS))]
                actions.append(["submit", ticker, "BUY", "1"])
                sim.submit(ticker, "BUY", "1")
            else:
                actions.append(["finish"])
                sim.finish()
        elif sim.k == LAST_INDEX and r < 0.3:
            actions.append(["finish"])
            sim.finish()
            finishes.append([sim.cash, sum(sim.pos[t][2] for t in TICKERS), len(sim.trades)])
        elif r < 0.17:
            actions.append(["advance"])
            sim.advance()
            cash_after_advance.append(sim.cash)
        elif r < 0.80:
            ticker = TICKERS[int(rng.next() * len(TICKERS))]
            side = "BUY" if rng.next() < 0.55 else "SELL"
            q = rng.next()
            cap = sim.max_affordable(ticker) if side == "BUY" else sim.pos[ticker][0]
            if q < 0.08:
                text = INVALID_TEXT[int(rng.next() * len(INVALID_TEXT))]
            elif q < 0.30:
                text = str(max(1, cap))
            else:
                text = str(1 + int(rng.next() * (cap + 3)))
            actions.append(["submit", ticker, side, text])
            sim.submit(ticker, side, text)
        elif r < 0.93:
            ticker = TICKERS[int(rng.next() * len(TICKERS))]
            actions.append(["cancel", ticker])
            sim.cancel(ticker)
        elif r < 0.999:
            actions.append(["advance"])
            sim.advance()
            cash_after_advance.append(sim.cash)
        else:
            actions.append(["replay"])  # rare: restart in the middle of a round
            sim.reset()
            replays += 1
    return {
        "seed": seed,
        "actions": actions,
        "cashAfterAdvance": cash_after_advance,
        "finishes": finishes,
        "replays": replays,
        "final": sim.snapshot(),
    }


def main():
    candle_seeds = [12345, 1, 4294967295]
    scenario_seeds = [12345, 1, 4294967295, 0, 987654321, 42, 2026, 3141592653]

    derived = {str(s): [derive_seed(s, i) for i in range(len(STOCKS))] for s in candle_seeds + [0]}
    candles = {str(s): generate_market(s) for s in candle_seeds}
    scenarios = [random_scenario(s, 1000) for s in scenario_seeds]

    print(json.dumps({
        "marketEngineVersion": MARKET_ENGINE_VERSION,
        "generatedBy": "tools/reference_market.py (independent Python reference)",
        "startCash": START_CASH,
        "tickers": TICKERS,
        "derivedSeeds": derived,
        "candles": candles,  # [open, high, low, close] per candle, 70 per stock
        "scenarios": scenarios,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
