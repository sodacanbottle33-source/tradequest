"""
TradeQuest — independent reference implementation of the price engine.

Purpose: produce the golden values used by the TypeScript tests (RNG-05, ENG-04)
WITHOUT running the TypeScript code under test (docs/rules.md §5.6).

It is written directly from docs/rules.md §5 in a different language. If the
TypeScript engine and this script disagree, one of them has a bug: investigate,
don't just regenerate the fixture. Regenerate only with an ENGINE_VERSION bump.

Usage (Python 3.8+, no packages needed):
    python tools/reference_engine.py > tests/fixtures/reference-v1.json
"""

import json
import math

ENGINE_VERSION = 1

TOTAL_CANDLES = 70
START_PRICE_MIN = 2000
START_PRICE_MAX = 5000
MIN_PRICE = 100
DRIFT = 0
BODY_SIGMA = 0.015
GAP_SIGMA = 0.002
MAX_MOVE = 0.10
MAX_GAP = 0.02
WICK_MAX = 0.01

MASK32 = 0xFFFFFFFF


def imul(a, b):
    """Low 32 bits of a * b (what JavaScript's Math.imul returns, as an unsigned bit pattern)."""
    return (a * b) & MASK32


class Mulberry32:
    """mulberry32, keeping every value as an unsigned 32-bit integer."""

    def __init__(self, seed):
        assert 0 <= seed <= MASK32
        self.state = seed
        self.draws = 0

    def next(self):
        self.draws += 1
        self.state = (self.state + 0x6D2B79F5) & MASK32
        s = self.state
        t = imul(s ^ (s >> 15), 1 | s)
        t = ((t + imul(t ^ (t >> 7), 61 | t)) & MASK32) ^ t
        return ((t ^ (t >> 14)) & MASK32) / 4294967296


def normal_z(rng):
    total = 0.0
    for _ in range(12):
        total += rng.next()
    return total - 6


def round_half_up(x):
    return math.floor(x + 0.5)


def clamp(x, lo, hi):
    return min(max(x, lo), hi)


def generate(rng, count=TOTAL_CANDLES):
    start = START_PRICE_MIN + math.floor(rng.next() * (START_PRICE_MAX - START_PRICE_MIN + 1))
    candles = []
    prev_close = None
    for i in range(1, count + 1):
        z_gap = normal_z(rng)
        z_body = normal_z(rng)
        u_up = rng.next()
        u_down = rng.next()
        if i == 1:
            o = start
        else:
            gap = clamp(GAP_SIGMA * z_gap, -MAX_GAP, MAX_GAP)
            o = max(MIN_PRICE, round_half_up(prev_close * (1 + gap)))
        ret = clamp(DRIFT + BODY_SIGMA * z_body, -MAX_MOVE, MAX_MOVE)
        c = max(MIN_PRICE, round_half_up(o * (1 + ret)))
        h = round_half_up(max(o, c) * (1 + u_up * WICK_MAX))
        lo = max(MIN_PRICE, round_half_up(min(o, c) * (1 - u_down * WICK_MAX)))
        candles.append({"index": i, "open": o, "high": h, "low": lo, "close": c})
        prev_close = c
    return candles


def main():
    rng_seeds = [12345, 0, 4294967295]
    candle_seeds = [12345, 1, 4294967295]

    rng_outputs = {}
    for seed in rng_seeds:
        r = Mulberry32(seed)
        rng_outputs[str(seed)] = [r.next() for _ in range(5)]

    candles = {}
    draw_counts = {}
    for seed in candle_seeds:
        r = Mulberry32(seed)
        candles[str(seed)] = generate(r)
        draw_counts[str(seed)] = r.draws

    print(json.dumps({
        "engineVersion": ENGINE_VERSION,
        "generatedBy": "tools/reference_engine.py (independent Python reference)",
        "rngFirstFive": rng_outputs,
        "drawCounts": draw_counts,
        "candles": candles,
    }, indent=1))


if __name__ == "__main__":
    main()
