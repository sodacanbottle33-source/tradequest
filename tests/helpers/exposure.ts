// FLOW-02: checks that the UI-facing view never contains future candles.
import type { RoundState, RoundView } from '../../src/engine';

function isCandleLike(v: unknown): v is { index: number } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).index === 'number' &&
    'open' in v &&
    'close' in v
  );
}

/** Throws if anything in `view` reveals a candle after k. */
export function assertNoFutureCandles(view: RoundView, state: RoundState): void {
  const k = state.k;
  const future = new Set<unknown>(state.candles.slice(k));
  if (view.candles.length !== k) throw new Error(`view has ${view.candles.length} candles, expected ${k}`);

  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    if (future.has(value)) throw new Error(`future candle object exposed at ${path}`);
    if (value === state.candles) throw new Error(`full candle list exposed at ${path}`);
    if (isCandleLike(value) && value.index > k) throw new Error(`candle ${value.index} exposed at ${path} (k = ${k})`);
    if (Array.isArray(value) && value.length > k && value.some(isCandleLike)) {
      throw new Error(`list of ${value.length} candles exposed at ${path}`);
    }
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
  };
  walk(view, 'view');
}
