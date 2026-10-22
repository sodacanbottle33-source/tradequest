// Hand-made SVG candlestick chart: no chart library, so no extra licence or attribution needed.
// It draws only the candles in the view (1..k); future slots stay empty.
import { formatCents, HISTORY_LENGTH, TOTAL_CANDLES, type VisibleCandle } from '../engine';
import { roundCounterLabel } from './labels';

const W = 720;
const H = 340;
const PAD = { top: 16, right: 64, bottom: 26, left: 8 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const SLOT = PLOT_W / TOTAL_CANDLES;

interface Props {
  /** Candles 1..k of ONE stock — the view never contains later ones. */
  candles: readonly VisibleCandle[];
  markPrice: number;
  roundNumber: number;
  roundLength: number;
  /** Shown above the chart, e.g. "NVRA" and "Novera Systems". */
  ticker: string;
  name: string;
}

export function CandleChart({ candles, markPrice, roundNumber, roundLength, ticker, name }: Props) {
  const current = candles[candles.length - 1];

  let lo = Math.min(...candles.map((c) => c.low));
  let hi = Math.max(...candles.map((c) => c.high));
  const pad = Math.max((hi - lo) * 0.08, 10);
  lo -= pad;
  hi += pad;
  const y = (price: number) => PAD.top + ((hi - price) / (hi - lo)) * PLOT_H;
  const xCenter = (index: number) => PAD.left + (index - 0.5) * SLOT;
  const bodyW = Math.max(2, SLOT * 0.62);

  const ticks = [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * i) / 4);
  const dividerX = PAD.left + HISTORY_LENGTH * SLOT;

  return (
    <div className="chart">
      <div className="chart-head">
        <div className="chart-title">
          <span className="chart-stock">
            <span className="ticker">{ticker}</span>
            <span className="company">{name} · fictional</span>
          </span>
          <span className="round-counter">{roundCounterLabel({ roundNumber, roundLength })}</span>
          {current && (
            <span className="ohlc">
              {current.kind === 'history' ? 'History · ' : ''}O {formatCents(current.open)} H {formatCents(current.high)} L{' '}
              {formatCents(current.low)} C {formatCents(current.close)}
            </span>
          )}
        </div>
        <div className="legend">
          <span className="legend-history">History (not tradable)</span>
          <span className="legend-round">Round</span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart-svg"
        role="img"
        aria-label={`${ticker} candlestick chart, ${candles.length} candles shown, last close ${formatCents(markPrice)}`}
      >
        <rect x={PAD.left} y={PAD.top} width={HISTORY_LENGTH * SLOT} height={PLOT_H} className="history-zone" />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={PAD.left + PLOT_W} y1={y(t)} y2={y(t)} className="grid" />
            <text x={W - PAD.right + 6} y={y(t) + 4} className="axis-label">
              {(t / 100).toFixed(2)}
            </text>
          </g>
        ))}
        <line x1={dividerX} x2={dividerX} y1={PAD.top} y2={PAD.top + PLOT_H} className="divider" />
        <text x={dividerX + 4} y={H - 8} className="divider-label">
          Round starts ▸
        </text>
        <text x={PAD.left + 4} y={H - 8} className="divider-label">
          History
        </text>

        {candles.map((c) => {
          const up = c.close >= c.open;
          const top = y(Math.max(c.open, c.close));
          const bottom = y(Math.min(c.open, c.close));
          const cls = `candle ${up ? 'up' : 'down'} ${c.kind === 'history' ? 'is-history' : ''}`;
          return (
            <g key={c.index} className={cls}>
              <line x1={xCenter(c.index)} x2={xCenter(c.index)} y1={y(c.high)} y2={y(c.low)} className="wick" />
              <rect
                x={xCenter(c.index) - bodyW / 2}
                y={top}
                width={bodyW}
                height={Math.max(1, bottom - top)}
                className="body"
              />
            </g>
          );
        })}

        <line x1={PAD.left} x2={PAD.left + PLOT_W} y1={y(markPrice)} y2={y(markPrice)} className="mark-line" />
        <rect x={W - PAD.right + 2} y={y(markPrice) - 10} width={PAD.right - 4} height={20} rx={3} className="mark-tag" />
        <text x={W - PAD.right + 6} y={y(markPrice) + 4} className="mark-text">
          {(markPrice / 100).toFixed(2)}
        </text>
      </svg>
    </div>
  );
}
