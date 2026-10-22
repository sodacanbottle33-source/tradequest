// MKT-21 … MKT-32 — one cash balance, ten positions (docs/rules.md §12.5).
import { describe, expect, it } from 'vitest';
import {
  buyFill,
  EMPTY_POSITION,
  holdingsValue,
  initialPortfolio,
  MARKET_START_CASH,
  portfolioEquity,
  positionAverageEntry,
  positionMarketValue,
  positionUnrealizedPnl,
  sellFill,
  TICKERS,
  totalRealizedPnl,
  totalUnrealizedPnl,
  type Portfolio,
} from '../src/engine';

const marks = (price: number | Record<string, number>): Record<string, number> =>
  Object.fromEntries(TICKERS.map((t) => [t, typeof price === 'number' ? price : (price[t] ?? 1000)]));

describe('Portfolio accounting (§12.5)', () => {
  it('MKT-21: a new portfolio has $10,000 and no shares of any stock', () => {
    const p = initialPortfolio();
    expect(p.cash).toBe(MARKET_START_CASH);
    expect(Object.keys(p.positions).sort()).toEqual([...TICKERS].sort());
    for (const t of TICKERS) expect(p.positions[t]).toEqual(EMPTY_POSITION);
  });

  it('MKT-22: a buy takes the cost from the ONE cash balance and adds shares to that stock only', () => {
    const p0 = initialPortfolio();
    const { portfolio: p1, cost } = buyFill(p0, 'NVRA', 7, 8_000);
    expect(cost).toBe(56_000);
    expect(p1.cash).toBe(MARKET_START_CASH - 56_000);
    expect(p1.positions.NVRA).toEqual({ shares: 7, costBasis: 56_000, realizedPnl: 0 });
    for (const t of TICKERS) if (t !== 'NVRA') expect(p1.positions[t]).toEqual(EMPTY_POSITION);
  });

  it('MKT-23: buys of different stocks all draw on the same cash balance', () => {
    let p: Portfolio = initialPortfolio();
    p = buyFill(p, 'NVRA', 10, 8_000).portfolio; // 80,000
    p = buyFill(p, 'BRLF', 100, 1_000).portfolio; // 100,000
    p = buyFill(p, 'HLQN', 5, 2_500).portfolio; // 12,500
    expect(p.cash).toBe(MARKET_START_CASH - 80_000 - 100_000 - 12_500);
    expect(p.positions.NVRA?.shares).toBe(10);
    expect(p.positions.BRLF?.shares).toBe(100);
    expect(p.positions.HLQN?.shares).toBe(5);
  });

  it('MKT-24: buying the same stock twice averages the cost basis', () => {
    let p = initialPortfolio();
    p = buyFill(p, 'QLRX', 10, 3_000).portfolio;
    p = buyFill(p, 'QLRX', 10, 4_000).portfolio;
    expect(p.positions.QLRX).toEqual({ shares: 20, costBasis: 70_000, realizedPnl: 0 });
    expect(positionAverageEntry(p.positions.QLRX ?? EMPTY_POSITION)).toBe(3_500);
  });

  it('MKT-25: a partial sell removes a proportional share of the cost basis (rounded half up) and books the P&L', () => {
    let p = initialPortfolio();
    p = buyFill(p, 'QLRX', 3, 1_000).portfolio; // basis 3,000
    p = buyFill(p, 'QLRX', 4, 1_001).portfolio; // basis 7,004 for 7 shares
    const sold = sellFill(p, 'QLRX', 3, 1_200);
    // removed basis = round(7004 × 3 / 7) = round(3001.714…) = 3002
    expect(sold.proceeds).toBe(3_600);
    expect(sold.tradePnl).toBe(3_600 - 3_002);
    expect(sold.portfolio.positions.QLRX).toEqual({ shares: 4, costBasis: 7_004 - 3_002, realizedPnl: 598 });
    expect(sold.portfolio.cash).toBe(p.cash + 3_600);
  });

  it('MKT-26: selling a whole position removes the whole cost basis', () => {
    let p = initialPortfolio();
    p = buyFill(p, 'SKVR', 9, 11_111).portfolio;
    const sold = sellFill(p, 'SKVR', 9, 11_000);
    expect(sold.portfolio.positions.SKVR).toEqual({ shares: 0, costBasis: 0, realizedPnl: 9 * 11_000 - 9 * 11_111 });
    expect(positionAverageEntry(sold.portfolio.positions.SKVR ?? EMPTY_POSITION)).toBeNull();
  });

  it('MKT-27: selling one stock never changes another stock\'s position', () => {
    let p = initialPortfolio();
    p = buyFill(p, 'ZYRA', 10, 2_000).portfolio;
    p = buyFill(p, 'TVLM', 10, 3_000).portfolio;
    const after = sellFill(p, 'ZYRA', 4, 2_500).portfolio;
    expect(after.positions.TVLM).toBe(p.positions.TVLM);
    for (const t of TICKERS) if (t !== 'ZYRA') expect(after.positions[t]).toEqual(p.positions[t]);
  });

  it('MKT-28: fills do not change the portfolio they were given (pure functions)', () => {
    const p = initialPortfolio();
    const snapshot = JSON.stringify(p);
    const bought = buyFill(p, 'PLNB', 3, 5_000).portfolio;
    sellFill(bought, 'PLNB', 1, 5_500);
    expect(JSON.stringify(p)).toBe(snapshot);
  });

  it('MKT-29: programming errors throw: unknown ticker, unaffordable buy, selling more than held', () => {
    const p = initialPortfolio();
    expect(() => buyFill(p, 'NOPE', 1, 1_000)).toThrow();
    expect(() => sellFill(p, 'NOPE', 1, 1_000)).toThrow();
    expect(() => buyFill(p, 'NVRA', 1_000, 8_000)).toThrow();
    expect(() => sellFill(p, 'NVRA', 1, 8_000)).toThrow();
    expect(() => buyFill(p, 'NVRA', 0, 8_000)).toThrow();
    expect(() => buyFill(p, 'NVRA', 1.5, 8_000)).toThrow();
  });

  it('MKT-30: holdings value and equity add up across all stocks at the given marks', () => {
    let p = initialPortfolio();
    p = buyFill(p, 'NVRA', 10, 8_000).portfolio;
    p = buyFill(p, 'BRLF', 50, 1_000).portfolio;
    const m = marks({ NVRA: 9_000, BRLF: 900 });
    expect(holdingsValue(p, m)).toBe(10 * 9_000 + 50 * 900);
    expect(portfolioEquity(p, m)).toBe(p.cash + 10 * 9_000 + 50 * 900);
  });

  it('MKT-31: unrealized and realized P&L add up across stocks', () => {
    let p = initialPortfolio();
    p = buyFill(p, 'NVRA', 10, 8_000).portfolio;
    p = buyFill(p, 'BRLF', 50, 1_000).portfolio;
    p = sellFill(p, 'BRLF', 20, 1_100).portfolio; // +2,000
    const m = marks({ NVRA: 9_000, BRLF: 900 });
    expect(totalRealizedPnl(p)).toBe(2_000);
    expect(totalUnrealizedPnl(p, m)).toBe(10 * 1_000 + 30 * -100);
    expect(positionUnrealizedPnl(p.positions.NVRA ?? EMPTY_POSITION, 9_000)).toBe(10_000);
    expect(positionMarketValue(p.positions.BRLF ?? EMPTY_POSITION, 900)).toBe(27_000);
    // equity − start = realized + unrealized
    expect(portfolioEquity(p, m) - MARKET_START_CASH).toBe(totalRealizedPnl(p) + totalUnrealizedPnl(p, m));
  });

  it('MKT-32: asking for a mark price that is missing is a programming error, not a silent zero', () => {
    const p = initialPortfolio();
    const incomplete = { NVRA: 100 };
    expect(() => holdingsValue(p, incomplete)).toThrow();
    expect(() => portfolioEquity(p, incomplete)).toThrow();
  });
});
