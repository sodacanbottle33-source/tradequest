// The price chart of one company on the shared market: 10-second candles (exactly 10 ticks), hourly or daily candles.
// The server owns every finished candle. The browser loads them once, then folds each new tick into the forming candle.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveCandle } from '../engine';
import { LiveChart } from '../ui/LiveChart';
import { api } from './api';
import { CANDLE_TICKS, candleIndexOf, foldMore, missedTicks, toChartCandles, type FoldState } from './candles';
import { useShared } from './store';
import type { Resolution, ServerCandle } from './types';

const RES_LABEL: Record<Resolution, string> = { c10: '10-tick candles', h1: '1 hour', d1: '1 day' };
const LIMIT = 150;
const NO_TRADES: never[] = [];

interface Props {
  ticker: string;
  name: string;
  /** Current price (cents) of this company, from the live tick stream. */
  price: number;
}

export function CompanyChart({ ticker, name, price }: Props) {
  const { tick, tickMs } = useShared();
  const [res, setRes] = useState<Resolution>('c10');
  const [loaded, setLoaded] = useState<{ ticker: string; res: Resolution; candles: readonly ServerCandle[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  // Load when the company or the resolution changes, and now and then so volume stays right.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .candles(ticker, res, LIMIT)
      .then((r) => {
        if (!cancelled) setLoaded({ ticker, res, candles: r.candles });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, res, reloads]);

  useEffect(() => {
    const id = setInterval(() => setReloads((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const current = loaded && loaded.ticker === ticker && loaded.res === res ? loaded.candles : null;
  const lastIndex = current && current.length > 0 ? (current[current.length - 1] as ServerCandle).index : 0;
  const nowIndex = tick > 0 ? candleIndexOf(tick, res) : 0;

  // More than one candle has passed since we loaded: ask the server again instead of guessing the missing ones.
  useEffect(() => {
    if (current && lastIndex > 0 && nowIndex > lastIndex + 1) setReloads((n) => n + 1);
  }, [current, lastIndex, nowIndex]);

  // Every tick is folded into what was folded before (see foldMore), so a spike inside the forming candle stays in its wick.
  const foldState = useRef<FoldState | null>(null);
  const folded = useMemo(() => {
    if (!current || price <= 0) {
      foldState.current = null;
      return current;
    }
    foldState.current = foldMore(foldState.current, current, tick, price, res);
    return foldState.current.candles;
  }, [current, tick, price, res]);

  // Ticks went by without being folded in (the page was asleep): ask the server for the real candles.
  const lastFolded = useRef(0);
  useEffect(() => {
    if (current && missedTicks(lastFolded.current, tick)) setReloads((n) => n + 1);
    lastFolded.current = tick;
  }, [tick, current]);
  const chart = useMemo(() => (folded && folded.length > 0 ? toChartCandles(folded, res) : null), [folded, res]);

  const describe = useMemo(() => {
    return (c: LiveCandle): string => {
      const startMs = tickMs + (c.openTick + 1 - tick) * 1000;
      const d = new Date(startMs);
      const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: res === 'c10' ? '2-digit' : undefined });
      const label = res === 'd1' ? day : `${day} ${time}`;
      return `${label}${c.complete ? '' : ' · forming'}`;
    };
  }, [tick, tickMs, res]);

  return (
    <div className="company-chart">
      <div className="segmented res-tabs" role="group" aria-label="Candle size">
        {(Object.keys(RES_LABEL) as Resolution[]).map((r) => (
          <button key={r} type="button" className={r === res ? 'seg active' : 'seg'} aria-pressed={r === res} onClick={() => setRes(r)}>
            {RES_LABEL[r]}
          </button>
        ))}
      </div>
      {error && (
        <p className="notice error" role="alert">
          Could not load the chart: {error}
        </p>
      )}
      {!chart && !error && <p className="hint">Loading chart…</p>}
      {chart && (
        <LiveChart
          ticker={ticker}
          name={name}
          candles={chart.candles}
          price={price}
          ticksPerCandle={CANDLE_TICKS[res]}
          trades={NO_TRADES}
          sessionStartIndex={null}
          describe={describe}
          penKey={ticker}
        />
      )}
    </div>
  );
}
