// Animated candlestick chart for live market mode — see docs/rules.md §13.3.
// Hand-made SVG, no chart library. It draws only what the view contains (finished candles + the one forming).
//   * The forming candle's body and wicks follow every tick; they are transforms with a CSS transition, so
//     they visibly slide to their new size.
//   * When a new candle begins the whole chart slides one slot left (a transition on the candle layer).
//   * Players can look back: Older / Newer / Live buttons, the scroll bar, the arrow keys, and hovering or
//     tapping a candle shows its open, high, low and close.
//   * Every price move gives the chart a little life (looks only; see docs/world.md §12.3): the forming candle glows green or red,
//     a live dot at its tip sends out a ring, the price tag flashes and a "+0.8%" floats up from it. A move of 1% or more glows
//     harder. All of it stops when the player's system asks for reduced motion.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { formatCents, formatSignedPercent, LIVE_HISTORY_CANDLES, type LiveCandle, type LiveTrade } from '../engine';
import { priceDomain } from './chartScale';
import { moveLabel } from './hype';
import { PenLayer, PenToolbar } from './PenLayer';
import { candleStateLabel, tone } from './labels';
import { usePens } from './usePens';
import { pulseClass, usePulse } from './usePulse';

const H = 340;
const PAD = { top: 14, right: 62, bottom: 24, left: 6 };
const PLOT_H = H - PAD.top - PAD.bottom;
const MIN_SLOT = 16; // narrowest a candle slot may get (screen pixels)
const GAP_SLOTS = 2; // empty slots to the right of the forming candle while following the market
const DEFAULT_WIDTH = 720;

interface Props {
  ticker: string;
  name: string;
  /** Finished candles, then the forming one. Never anything later. */
  candles: readonly LiveCandle[];
  price: number;
  ticksPerCandle: number;
  /** Your trades in THIS stock, drawn as markers. */
  trades: readonly LiveTrade[];
  /** Candle number where "your session" starts (the practice market). `null`: there is no session divider (the shared market). */
  sessionStartIndex?: number | null;
  /** Replaces the "Candle 123 · finished, 10 ticks" text of the header (the shared market shows clock times instead). */
  describe?: (candle: LiveCandle) => string;
  /**
   * Turns the pens on: the drawings of this chart are kept under this key (one per company). Without it the chart has no pens.
   * With `penPersist: false` the drawings only last until the page is closed (the practice market, whose candles start over).
   */
  penKey?: string | null;
  penPersist?: boolean;
}

export function LiveChart({ ticker, name, candles, price, ticksPerCandle, trades, sessionStartIndex, describe, penKey, penPersist }: Props) {
  const clipId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  // null = follow the market; a number = the right edge (in candle slots) of the window the player scrolled to.
  const [panEnd, setPanEnd] = useState<number | null>(null);
  const [inspected, setInspected] = useState<number | null>(null);
  const pens = usePens(penKey, penPersist ?? true);
  const pulse = usePulse(price, ticker);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => setWidth(Math.max(280, Math.floor(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Another stock has its own candles: start by following the market again.
  useEffect(() => {
    setPanEnd(null);
    setInspected(null);
  }, [ticker]);

  const n = candles.length;
  const plotW = width - PAD.left - PAD.right;
  const slots = Math.max(16, Math.min(90, Math.floor(plotW / MIN_SLOT)));
  const slotW = plotW / slots;
  const bodyW = Math.max(3, slotW * 0.64);

  const liveEnd = n + GAP_SLOTS;
  const minEnd = Math.min(slots, liveEnd);
  const end = panEnd === null ? liveEnd : Math.min(Math.max(panEnd, minEnd), liveEnd);
  const following = end >= liveEnd;
  const start = Math.max(0, end - slots);
  const maxStart = Math.max(0, liveEnd - slots);

  const visible = candles.filter((c) => c.index > start && c.index <= start + slots);
  const { lo, hi, step } = priceDomain(visible.length > 0 ? visible : candles.slice(-1));
  const y = (p: number) => PAD.top + ((hi - p) / (hi - lo)) * PLOT_H;
  const gridPrices: number[] = [];
  for (let p = lo; p <= hi + 0.001; p += step) gridPrices.push(p);

  const drawn = candles.filter((c) => c.index >= start && c.index <= start + slots + 1);
  const forming = candles[n - 1];
  const shown = inspected !== null ? (candles[inspected - 1] ?? forming) : forming;
  const sessionStart = sessionStartIndex === undefined ? LIVE_HISTORY_CANDLES + 1 : (sessionStartIndex ?? 0);
  // The look of the last price move: which way, whether it was big (1% or more), and the floating label.
  const bigMove = pulse.dir !== null && pulse.from > 0 && Math.abs(price - pulse.from) / pulse.from >= 0.01;
  const floating = pulse.dir ? moveLabel(pulse.from, price) : null;
  const liveX = forming ? (forming.index - 0.5) * slotW : 0;

  const scrollTo = (nextStart: number) => {
    const clamped = Math.min(Math.max(Math.round(nextStart), 0), maxStart);
    setPanEnd(clamped >= maxStart ? null : clamped + slots);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (pens.enabled && e.key === 'Escape' && pens.tool !== 'off') pens.setTool('off');
    else if (pens.enabled && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') pens.undo();
    else if (e.key === 'ArrowLeft') scrollTo(start - 1);
    else if (e.key === 'ArrowRight') scrollTo(start + 1);
    else if (e.key === 'End') scrollTo(maxStart);
    else if (e.key === 'Home') scrollTo(0);
    else return;
    e.preventDefault();
  };

  const markerX = (t: LiveTrade) => (t.candleIndex - 1 + 0.15 + (0.7 * (t.tick % ticksPerCandle)) / ticksPerCandle) * slotW;

  return (
    <div className="chart live-chart" ref={wrapRef}>
      <div className="chart-head">
        <div className="chart-title">
          <span className="chart-stock">
            <span className="ticker">{ticker}</span>
            <span className="company">{name} · fictional</span>
          </span>
          {shown && (
            <span className="ohlc" data-testid="ohlc">
              <strong>{describe ? describe(shown) : `Candle ${shown.index}`}</strong>
              {describe ? '' : ` · ${candleStateLabel(shown, ticksPerCandle, sessionStart)}`} · O {formatCents(shown.open)} H{' '}
              {formatCents(shown.high)} L {formatCents(shown.low)} C {formatCents(shown.close)}{' '}
              <span className={tone(shown.close - shown.open)}>{formatSignedPercent(shown.close - shown.open, shown.open)}</span>
            </span>
          )}
        </div>
        <div className="chart-nav" role="group" aria-label="Scroll the chart">
          <button type="button" className="btn btn-small btn-ghost" onClick={() => scrollTo(start - 10)} disabled={start <= 0}>
            ◀ Older
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => scrollTo(start + 10)} disabled={following}>
            Newer ▶
          </button>
          <button type="button" className={`btn btn-small ${following ? 'btn-ghost' : 'btn-primary'}`} onClick={() => scrollTo(maxStart)} disabled={following}>
            {following ? '● Following live' : 'Back to live'}
          </button>
        </div>
      </div>

      <PenToolbar pens={pens} />

      <div
        className="chart-frame"
        tabIndex={0}
        role="group"
        aria-label={`${ticker} candlestick chart. Left and right arrow keys scroll through history.`}
        onKeyDown={onKey}
      >
        <svg
          viewBox={`0 0 ${width} ${H}`}
          width={width}
          height={H}
          className={pens.tool === 'off' ? 'chart-svg live-svg' : 'chart-svg live-svg drawing'}
          role="img"
          aria-label={`${ticker} candlestick chart, ${n} candles, current price ${formatCents(price)}`}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') setInspected(null);
          }}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD.left} y={0} width={plotW} height={H} />
            </clipPath>
          </defs>

          {gridPrices.map((p) => (
            <g key={p} className="grid-row" style={{ transform: `translateY(${y(p)}px)` }}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={0} y2={0} className="grid" />
              <text x={width - PAD.right + 6} y={4} className="axis-label">
                {(p / 100).toFixed(2)}
              </text>
            </g>
          ))}

          <g clipPath={`url(#${clipId})`}>
            <g className="scroll-layer" style={{ transform: `translateX(${PAD.left - start * slotW}px)` }} data-start={start}>
              {start < sessionStart && sessionStart <= start + slots + 1 && (
                <g transform={`translate(${(sessionStart - 1) * slotW},0)`}>
                  <line x1={0} x2={0} y1={PAD.top} y2={PAD.top + PLOT_H} className="divider" />
                  <text x={4} y={H - 8} className="divider-label">
                    Your session starts ▸
                  </text>
                </g>
              )}
              {inspected !== null && (
                <rect className="inspect-band" x={(inspected - 1) * slotW} y={PAD.top} width={slotW} height={PLOT_H} />
              )}
              {drawn.map((c) => {
                const top = y(Math.max(c.open, c.close));
                const bottom = y(Math.min(c.open, c.close));
                const bodyH = Math.max(1.5, bottom - top);
                const wickTop = y(c.high);
                const wickH = Math.max(1, y(c.low) - wickTop);
                const cls = [
                  'candle',
                  c.direction,
                  c.complete ? 'done' : 'forming',
                  c.complete ? '' : pulseClass(pulse, 'glow'),
                  c.complete ? '' : bigMove ? 'big-move' : '',
                  c.index < sessionStart ? 'is-history' : '',
                ].join(' ');
                return (
                  <g key={c.index} className={cls} transform={`translate(${(c.index - 0.5) * slotW},0)`} data-index={c.index} data-ticks={c.ticks}>
                    <rect className="wick" x={-0.6} width={1.2} y={0} height={1} style={{ transform: `translateY(${wickTop}px) scaleY(${wickH})` }} />
                    <rect className="body" x={-bodyW / 2} width={bodyW} y={0} height={1} style={{ transform: `translateY(${top}px) scaleY(${bodyH})` }} />
                    <rect
                      className="hit"
                      x={-slotW / 2}
                      width={slotW}
                      y={PAD.top}
                      height={PLOT_H}
                      onPointerEnter={(e) => {
                        if (e.pointerType === 'mouse') setInspected(c.index);
                      }}
                      onPointerDown={() => setInspected((cur) => (cur === c.index ? null : c.index))}
                    />
                  </g>
                );
              })}
              {forming && (
                <g className="live-dot" transform={`translate(${liveX},0)`} data-testid="live-dot" data-dir={pulse.dir ?? ''}>
                  <g className="live-dot-y" style={{ transform: `translateY(${y(price)}px)` }}>
                    <circle className="live-ring" r={4} />
                    {pulse.dir && <circle key={pulse.n} className={`live-ping ${pulse.dir}${bigMove ? ' big-move' : ''}`} r={4} />}
                    <circle className={`live-core ${pulse.dir ?? ''}`} r={3.6} />
                  </g>
                </g>
              )}
              {trades.map((t) => (
                <g key={t.id} className={`marker ${t.side === 'BUY' ? 'buy' : 'sell'}`} transform={`translate(${markerX(t)},0)`}>
                  <path
                    d={t.side === 'BUY' ? 'M0,-6 L6,5 L-6,5 Z' : 'M0,6 L6,-5 L-6,-5 Z'}
                    style={{ transform: `translateY(${y(t.price)}px)` }}
                  >
                    <title>{`${t.side} ${t.quantity} at ${formatCents(t.price)} (tick ${t.tick})`}</title>
                  </path>
                </g>
              ))}
            </g>
          </g>

          <g className={`price-line ${pulseClass(pulse, 'tag')}`.trim()} style={{ transform: `translateY(${y(price)}px)` }} data-testid="price-line">
            <line x1={PAD.left} x2={PAD.left + plotW} y1={0} y2={0} className="mark-line" />
            <rect x={width - PAD.right + 2} y={-10} width={PAD.right - 4} height={20} rx={3} className="mark-tag" />
            <text x={width - PAD.right + 6} y={4} className="mark-text">
              {(price / 100).toFixed(2)}
            </text>
            {floating && (
              <text key={pulse.n} x={width - PAD.right - 8} y={-12} textAnchor="end" className={`float-move ${pulse.dir ?? ''}${bigMove ? ' big-move' : ''}`} data-testid="float-move">
                {floating}
              </text>
            )}
          </g>

          {pens.enabled && (
            <PenLayer
              pens={pens}
              geo={{ openTick0: candles[0]?.openTick ?? 0, ticksPerCandle, slotW, start, lo, hi, plotH: PLOT_H }}
              padLeft={PAD.left}
              padTop={PAD.top}
              plotW={plotW}
              clipId={clipId}
            />
          )}
        </svg>
      </div>

      <div className="chart-scroll">
        <input
          type="range"
          min={0}
          max={maxStart}
          step={1}
          value={Math.min(start, maxStart)}
          disabled={maxStart === 0}
          aria-label="Scroll through earlier candles"
          onChange={(e) => scrollTo(Number(e.target.value))}
        />
      </div>
      <div className="legend live-legend">
        <span className="legend-up">Up (close above open)</span>
        <span className="legend-down">Down (close below open)</span>
        <span className="legend-flat">Flat</span>
        <span className="legend-forming">Forming candle</span>
        <span className="legend-buy">▲ your buy</span>
        <span className="legend-sell">▼ your sell</span>
      </div>
    </div>
  );
}
