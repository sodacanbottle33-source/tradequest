"""
TradeQuest live market mode (engine v3) — independent reference implementation.

Purpose: produce golden values for the TypeScript tests WITHOUT running the TypeScript code under test
(docs/rules.md §13.10). It is written from docs/rules.md §13 in a different language. Differences that matter:

  * Prices are drawn ONE AFTER ANOTHER from a normal sequential Mulberry32 (the TypeScript engine reads
    any draw directly with a closed-form shortcut), so the shortcut is checked independently.
  * Candles are rebuilt from the plain price list with straightforward loops.
  * Trading and time are a second, separate implementation of §13.4-13.5.

If the TypeScript engine and this script disagree, one of them has a bug: investigate, don't just
regenerate the fixture. Regenerate only with a LIVE_ENGINE_VERSION bump.

Usage (Python 3.8+, no packages needed):
    python tools/reference_live.py > tests/fixtures/reference-live-v3.json
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reference_engine import Mulberry32, normal_z, round_half_up, clamp, MASK32  # noqa: E402
from reference_market import STOCKS, TICKERS, derive_seed, round_half_up_ratio, parse_quantity  # noqa: E402

LIVE_ENGINE_VERSION = 3
TICKS_PER_CANDLE = 10
HISTORY_TICKS = 100
START_CASH = 100_000  # $1,000.00 in cents
MIN_PRICE = 100
TICK_SIGMA_SCALE = 0.31622776601683794


class Prices:
    """The ten stocks' prices, drawn sequentially and extended on demand."""

    def __init__(self, seed):
        self.rngs = {}
        self.series = {}
        for i, spec in enumerate(STOCKS):
            rng = Mulberry32(derive_seed(seed, i))
            start_min, start_max = spec[2], spec[3]
            start = start_min + math.floor(rng.next() * (start_max - start_min + 1))
            self.rngs[spec[0]] = rng
            self.series[spec[0]] = [start]

    def at(self, ticker, tick):
        spec = next(s for s in STOCKS if s[0] == ticker)
        body_sigma, max_move = spec[4], spec[6]
        series = self.series[ticker]
        while len(series) <= tick:
            z = normal_z(self.rngs[ticker])
            sigma = body_sigma * TICK_SIGMA_SCALE
            limit = max_move * 0.5
            move = clamp(0 + sigma * z, -limit, limit)
            series.append(max(MIN_PRICE, round_half_up(series[-1] * (1 + move))))
        return series[tick]


def candle(prices, ticker, index, tick):
    """[index, ticks, open, high, low, close] of candle `index` as it stands at `tick`."""
    open_tick = (index - 1) * TICKS_PER_CANDLE
    ticks = max(0, min(tick - open_tick, TICKS_PER_CANDLE))
    seq = [prices.at(ticker, t) for t in range(open_tick, open_tick + ticks + 1)]
    return [index, ticks, seq[0], max(seq), min(seq), seq[-1]]


def candles_at(prices, ticker, tick):
    return [candle(prices, ticker, i, tick) for i in range(1, tick // TICKS_PER_CANDLE + 2)]


class Live:
    def __init__(self, seed, start_cash=START_CASH, duration=None):
        self.seed = seed
        self.prices = Prices(seed)
        self.start_cash = start_cash
        self.duration = duration
        self.reset()

    def reset(self):
        self.tick = HISTORY_TICKS
        self.end_tick = None if self.duration is None else HISTORY_TICKS + self.duration
        self.running = True
        self.cash = self.start_cash
        self.pos = {t: [0, 0, 0] for t in TICKERS}  # shares, cost basis, realized pnl
        self.trades = []

    def price(self, ticker):
        return self.prices.at(ticker, self.tick)

    def equity(self):
        return self.cash + sum(self.pos[t][0] * self.price(t) for t in TICKERS)

    # --- time ---
    def advance(self, count):
        if not self.running:
            return
        target = self.tick + count
        if self.end_tick is not None:
            target = min(target, self.end_tick)
        self.tick = target
        if self.end_tick is not None and self.tick >= self.end_tick:
            self.running = False

    def skip(self):
        self.advance(TICKS_PER_CANDLE - (self.tick % TICKS_PER_CANDLE))

    # --- trading ---
    def submit(self, ticker, side, text):
        if not self.running or ticker not in self.pos:
            return
        qty = parse_quantity(text)
        if qty is None:
            return
        price = self.price(ticker)
        p = self.pos[ticker]
        if side == "SELL":
            if p[0] == 0 or qty > p[0]:
                return
            proceeds = qty * price
            removed = round_half_up_ratio(p[1] * qty, p[0])
            pnl = proceeds - removed
            self.cash += proceeds
            p[0] -= qty
            p[1] -= removed
            p[2] += pnl
            self.record(ticker, "SELL", qty, price, proceeds, pnl)
        else:
            cost = qty * price
            if cost > self.cash:
                return
            self.cash -= cost
            p[0] += qty
            p[1] += cost
            self.record(ticker, "BUY", qty, price, cost, None)

    def record(self, ticker, side, qty, price, amount, pnl):
        self.trades.append([len(self.trades) + 1, ticker, side, self.tick, self.tick // TICKS_PER_CANDLE + 1,
                            qty, price, amount, pnl, self.cash, self.pos[ticker][0]])

    def snapshot(self):
        return {
            "tick": self.tick,
            "status": "RUNNING" if self.running else "ENDED",
            "cash": self.cash,
            "positions": {t: list(self.pos[t]) for t in TICKERS},
            "trades": self.trades,
            "equity": self.equity(),
        }


INVALID_TEXT = ["0", "-3", "1.5", "", " ", "abc", "1e3", "+5", " 5", "05", "1000001", "99999999"]


def random_scenario(seed, steps, duration=None, start_cash=START_CASH):
    """A scripted random session. Every action is recorded so the TypeScript engine can replay it."""
    sim = Live(seed, start_cash, duration)
    rng = Mulberry32((seed ^ 0x5BD1E995) & MASK32)
    actions = []
    after_time = []  # [tick, cash, equity] after every advance/skip action
    trace = []  # [tick, cash, number of trades] after EVERY action
    resets = 0
    total_trades = 0  # trades over the whole script, including those wiped by a reset
    actions_while_ended = 0
    for _ in range(steps):
        r = rng.next()
        if not sim.running:
            actions_while_ended += 1
        if r < 0.10:
            n = 1 + int(rng.next() * 12)
            actions.append(["advance", n])
            sim.advance(n)
            after_time.append([sim.tick, sim.cash, sim.equity()])
        elif r < 0.14:
            actions.append(["skip"])
            sim.skip()
            after_time.append([sim.tick, sim.cash, sim.equity()])
        elif r < 0.143 + (0.03 if not sim.running else 0):
            actions.append(["reset"])
            total_trades += len(sim.trades)
            sim.reset()
            resets += 1
        else:
            ticker = TICKERS[int(rng.next() * len(TICKERS))]
            side = "BUY" if rng.next() < 0.5 else "SELL"
            q = rng.next()
            price = sim.price(ticker)
            cap = sim.cash // price if side == "BUY" else sim.pos[ticker][0]
            if q < 0.08:
                text = INVALID_TEXT[int(rng.next() * len(INVALID_TEXT))]
            elif q < 0.30:
                text = str(max(1, cap))
            elif q < 0.38:
                text = str(cap + 1)
            else:
                text = str(1 + int(rng.next() * (cap + 3)))
            actions.append(["submit", ticker, side, text])
            sim.submit(ticker, side, text)
        trace.append([sim.tick, sim.cash, len(sim.trades)])
    total_trades += len(sim.trades)
    return {
        "seed": seed,
        "startCash": start_cash,
        "duration": duration,
        "actions": actions,
        "afterTime": after_time,
        "trace": trace,
        "resets": resets,
        "totalTrades": total_trades,
        "actionsWhileEnded": actions_while_ended,
        "final": sim.snapshot(),
    }


def main():
    price_seeds = [12345, 1, 4294967295, 0]
    scenario_specs = [
        (12345, None, START_CASH),
        (1, None, START_CASH),
        (4294967295, 180, START_CASH),
        (0, None, START_CASH),
        (987654321, 180, START_CASH),
        (42, None, 5_000_000),
        (2026, 60, START_CASH),
        (3141592653, None, START_CASH),
    ]
    check_ticks = [100, 101, 103, 109, 110, 111, 119, 120, 250, 399, 400, 407]

    prices = {}
    candles = {}
    for s in price_seeds:
        p = Prices(s)
        prices[str(s)] = {t: [p.at(t, n) for n in range(0, 401)] for t in TICKERS}
        candles[str(s)] = {str(k): {t: candles_at(p, t, k) for t in TICKERS} for k in check_ticks}

    print(json.dumps({
        "liveEngineVersion": LIVE_ENGINE_VERSION,
        "generatedBy": "tools/reference_live.py (independent Python reference)",
        "startCash": START_CASH,
        "ticksPerCandle": TICKS_PER_CANDLE,
        "historyTicks": HISTORY_TICKS,
        "tickers": TICKERS,
        "priceSeeds": price_seeds,
        "checkTicks": check_ticks,
        "prices": prices,  # tick 0..400 per stock
        "candles": candles,  # [index, ticks, open, high, low, close] per candle, per check tick
        "scenarios": [random_scenario(s, 1000, d, c) for s, d, c in scenario_specs],
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
