// Small display helpers shared by components (kept separate so they can be unit-tested).

/** Round counter text (FLOW-17): "Round starts next candle" at k = 10, then "Candle r of 60". */
export function roundCounterLabel(view: { readonly roundNumber: number; readonly roundLength: number }): string {
  return view.roundNumber === 0 ? 'Round starts next candle' : `Candle ${view.roundNumber} of ${view.roundLength}`;
}

/** Label for a trade's candle in the history table. */
export function tradeCandleLabel(candleIndex: number, type: 'player' | 'liquidation'): string {
  const r = candleIndex - 10;
  return type === 'liquidation' ? `${r} (close)` : `${r} (open)`;
}

/** "pos" / "neg" / "" — the colour class for a profit-and-loss number. */
export function tone(value: number): string {
  if (value > 0) return 'pos';
  if (value < 0) return 'neg';
  return '';
}

/** What the chart header says about a candle: forming (n of 10 ticks), finished, and whether it is from before your session. */
export function candleStateLabel(
  candle: { readonly index: number; readonly ticks: number; readonly complete: boolean },
  ticksPerCandle: number,
  sessionStartIndex: number,
): string {
  if (!candle.complete) return `forming, ${candle.ticks} of ${ticksPerCandle} ticks`;
  return candle.index < sessionStartIndex ? `history, ${ticksPerCandle} ticks` : `finished, ${ticksPerCandle} ticks`;
}
