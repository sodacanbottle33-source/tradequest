// The ten fictional stocks of market mode — see docs/rules.md §12.2.
// Every company, name and ticker is invented. Tickers were web-checked on 2026-10-15 (rules.md §12.2);
// recheck before any public launch. Changing any value here changes the market for a given seed
// and requires bumping MARKET_ENGINE_VERSION (rules.md §12.9).

import type { CandleParams } from './candles';

export interface StockSpec extends CandleParams {
  readonly ticker: string;
  readonly name: string;
  readonly sector: string;
}

// All prices are cents. Sigmas are per-candle fractions.
// Movement personalities: utilities barely move, biotech gaps and swings hard, the rest sit between.
export const STOCKS: readonly StockSpec[] = [
  { ticker: 'QLRX', name: 'Quellaris Energy', sector: 'Energy', startMin: 2000, startMax: 5000, drift: 0, bodySigma: 0.015, gapSigma: 0.002, maxMove: 0.1, maxGap: 0.02, wickMax: 0.01 },
  { ticker: 'NVRA', name: 'Novera Systems', sector: 'Software', startMin: 6000, startMax: 12000, drift: 0, bodySigma: 0.022, gapSigma: 0.004, maxMove: 0.12, maxGap: 0.03, wickMax: 0.012 },
  { ticker: 'BRLF', name: 'Brookleaf Foods', sector: 'Consumer staples', startMin: 800, startMax: 1500, drift: 0, bodySigma: 0.006, gapSigma: 0.001, maxMove: 0.05, maxGap: 0.01, wickMax: 0.006 },
  { ticker: 'HLQN', name: 'Helioquin Biotech', sector: 'Biotech', startMin: 1200, startMax: 4000, drift: 0, bodySigma: 0.035, gapSigma: 0.01, maxMove: 0.15, maxGap: 0.04, wickMax: 0.02 },
  { ticker: 'MRDL', name: 'Mardell Rail & Freight', sector: 'Industrials', startMin: 3500, startMax: 7000, drift: 0, bodySigma: 0.01, gapSigma: 0.002, maxMove: 0.07, maxGap: 0.015, wickMax: 0.008 },
  { ticker: 'ZYRA', name: 'Zyra Airways', sector: 'Airlines', startMin: 1500, startMax: 3500, drift: 0, bodySigma: 0.02, gapSigma: 0.005, maxMove: 0.12, maxGap: 0.03, wickMax: 0.012 },
  { ticker: 'TVLM', name: 'Tavelum Metals', sector: 'Materials', startMin: 2500, startMax: 5500, drift: 0, bodySigma: 0.017, gapSigma: 0.003, maxMove: 0.1, maxGap: 0.025, wickMax: 0.01 },
  { ticker: 'SKVR', name: 'Skyvere Aerospace', sector: 'Aerospace & defense', startMin: 8000, startMax: 15000, drift: 0, bodySigma: 0.013, gapSigma: 0.003, maxMove: 0.08, maxGap: 0.02, wickMax: 0.009 },
  { ticker: 'PLNB', name: 'Pellmont Bancorp', sector: 'Financials', startMin: 4500, startMax: 9500, drift: 0, bodySigma: 0.009, gapSigma: 0.002, maxMove: 0.06, maxGap: 0.015, wickMax: 0.007 },
  { ticker: 'VRDW', name: 'Verdane Water Utilities', sector: 'Utilities', startMin: 1800, startMax: 3200, drift: 0, bodySigma: 0.004, gapSigma: 0.0008, maxMove: 0.03, maxGap: 0.008, wickMax: 0.005 },
];

export const TICKERS: readonly string[] = STOCKS.map((s) => s.ticker);

export function stockByTicker(ticker: string): StockSpec | undefined {
  return STOCKS.find((s) => s.ticker === ticker);
}
