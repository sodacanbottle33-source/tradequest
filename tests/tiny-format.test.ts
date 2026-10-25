// How tiny prices are shown and typed (src/shared/format.ts, src/engine/format.ts, src/ui/chartScale.ts): a coin that costs a tiny fraction of a cent must
// read as a normal dollar price, a big token count must be typeable ("5k", "1.5m", "2b", "1t"), and a chart of a coin with a price like $0.000000000064
// needs an axis with sensible labels. Prices from before (whole cents) must read exactly as they always did.
import { describe, expect, it } from 'vitest';
import { formatAxisPrice, formatCents as engineFormatCents, formatFineCents } from '../src/engine/format';
import { bidFrom, formatCents, formatCount, formatPrice, formatShares, parseQty, MAX_QTY_TEXT_VALUE } from '../src/shared/format';
import { gridPricesOf, priceDomain } from '../src/ui/chartScale';

describe('prices', () => {
  it('TFMT-01: a price of a launched coin is written in dollars with all its digits, down to the lowest price there is', () => {
    expect(formatCents(6.4e-9)).toBe('$0.000000000064'); // a free launch
    expect(formatCents(1.6e-5)).toBe('$0.00000016'); // the $5,000 launch
    expect(formatCents(0.044)).toBe('$0.00044'); // the $10 million launch
    expect(formatCents(1e-12)).toBe('$0.00000000000001'); // the lowest price: a rugged coin
    expect(formatCents(0.5)).toBe('$0.005');
    expect(formatPrice(6.4e-9)).toBe('$0.000000000064');
  });

  it('TFMT-02: prices that are whole cents read exactly as before', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(100)).toBe('$1.00');
    expect(formatCents(12345)).toBe('$123.45');
    expect(formatCents(-1467)).toBe('−$14.67');
    expect(formatCents(123_456_789)).toBe('$1,234,567.89');
    expect(engineFormatCents(12345)).toBe('$123.45');
  });

  it('TFMT-03: the engine formatter does not throw on a price in fractions of a cent', () => {
    expect(() => engineFormatCents(6.4e-9)).not.toThrow();
    expect(engineFormatCents(6.4e-9)).toBe('$0.000000000064');
    expect(formatFineCents(-0.5)).toBe('−$0.005');
  });
});

describe('quantities', () => {
  it('TFMT-04: a token count is shown in full below a billion and shortened above', () => {
    expect(formatShares(5)).toBe('5');
    expect(formatShares(999_999_999)).toBe('999999999'); // (written out the way it always was)
    expect(formatShares(1e9)).toBe('1.00B');
    expect(formatShares(31_250_000_000)).toBe('31.25B');
    expect(formatCount(1.5e12)).toBe('1.50T');
    expect(formatCount(1e12)).toBe('1.00T');
  });

  it('TFMT-05: the quantity box takes plain numbers and k / m / b / t, and nothing else', () => {
    const ok: Array<[string, number]> = [['250', 250], ['1,000,000', 1_000_000], ['5k', 5000], ['1.5m', 1_500_000], ['2b', 2_000_000_000], ['1t', 1_000_000_000_000], ['1.1m', 1_100_000], ['1.5k', 1500], ['2.55k', 2550], ['10t', 10_000_000_000_000]];
    for (const [text, n] of ok) expect(parseQty(text)).toBe(n);
    for (const text of ['1.5', '1e3', 'abc', '', '1.0000000001m', '12345678901234', '-5', '5x', '1..5k']) expect(parseQty(text)).toBeNull();
    expect(MAX_QTY_TEXT_VALUE).toBe(10_000_000_000_000);
  });

  it('TFMT-06: parsing is exact: a number past what floating point does exactly is still the exact whole number', () => {
    expect(parseQty('1234567890123')).toBe(1_234_567_890_123);
    expect(parseQty('9999999999999')).toBe(9_999_999_999_999);
    expect(parseQty('1.234567m')).toBe(1_234_567);
    expect(parseQty('0.1t')).toBe(100_000_000_000);
    expect(parseQty('0.3k')).toBe(300); // 0.3 × 1000 is 300.00000000000006 in floating point
  });
});

describe('the price axis', () => {
  it('TFMT-07: axis labels of a tiny price keep their significant digits (the zeros are counted, not written out)', () => {
    expect(formatAxisPrice(6.4e-9)).toBe('0.0₁₀64');
    expect(formatAxisPrice(1e-12)).toBe('0.0₁₃1');
    expect(formatAxisPrice(0.5)).toBe('0.005');
    expect(formatAxisPrice(1234)).toBe('12.34');
    expect(formatAxisPrice(99.99)).toBe('1.00');
  });

  it('TFMT-08: the chart domain of a fraction-of-a-cent price has a step that fits it, and its grid has distinct, increasing labels', () => {
    const d = priceDomain([{ low: 6.3e-9, high: 6.5e-9 }, { low: 6.4e-9, high: 6.6e-9 }]);
    expect(d.lo).toBeLessThanOrEqual(6.3e-9);
    expect(d.hi).toBeGreaterThanOrEqual(6.6e-9);
    expect(d.step).toBeGreaterThan(0);
    expect(d.step).toBeLessThan(1e-9);
    const grid = gridPricesOf(d.lo, d.hi, d.step);
    expect(grid.length).toBeGreaterThanOrEqual(3);
    expect(grid.length).toBeLessThanOrEqual(12);
    const labels = grid.map((p) => formatAxisPrice(p));
    expect(new Set(labels).size).toBe(labels.length);
    for (let i = 1; i < grid.length; i += 1) expect(grid[i]).toBeGreaterThan(grid[i - 1] as number);
  });

  it('TFMT-09: a chart of a coin that sits at one price (a rugged coin) still has a domain around it', () => {
    const d = priceDomain([{ low: 1e-12, high: 1e-12 }]);
    expect(d.lo).toBeLessThan(1e-12);
    expect(d.hi).toBeGreaterThan(1e-12);
    expect(d.step).toBeGreaterThan(0);
  });

  it('TFMT-10: a chart of whole-cent prices is the same as before', () => {
    expect(priceDomain([{ low: 5, high: 9 }])).toEqual({ lo: 0, hi: 15, step: 5 });
    expect(priceDomain([{ low: 2500, high: 2500 }])).toEqual({ lo: 2495, hi: 2505, step: 5 });
  });

  it('TFMT-11: the bid of a coin that costs a tiny fraction of a cent is a tiny price too (not one cent), and a stock keeps its one-cent minimum', () => {
    // Real screen bug: a coin at $0.000000003 showed "Bid $0.01" and a spread of -358,668,378 %, because the bid was never allowed below one cent.
    const price = 3.2e-7; // cents
    const bid = bidFrom(price, price * 0.0067);
    expect(bid).toBeCloseTo(price * (1 - 0.0067), 12);
    expect(bid).toBeLessThan(price);
    expect(formatCents(bid)).toBe('$0.000000003179'); // a tiny price, never "$0.01"
    expect(formatCents(bid)).not.toBe('$0.01');
    // a gap wider than the price itself still leaves a bid above 0 (half the price)
    expect(bidFrom(price, price * 3)).toBeCloseTo(price / 2, 15);
    // from one cent up nothing changes: whole cents, never below 1
    expect(bidFrom(2500, 4)).toBe(2496);
    expect(bidFrom(100, 150)).toBe(1);
    expect(bidFrom(1, 5)).toBe(1);
  });
});
