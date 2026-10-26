// A small candle chart for the tutorial and the practice lessons. It only draws what it is given: no live prices, no server.
// The candles from `futureFrom` on are the "what happened next" part: drawn after a divider on a shaded background.
import { CHART_H, CHART_W, AXIS_W, geometryOf, gridPrices } from '../learn/chartGeometry';
import type { ChartLine, ChartMark, LCandle } from '../learn/types';

export interface MiniChartProps {
  readonly candles: readonly LCandle[];
  /** Spoken description of the chart for screen readers. */
  readonly label: string;
  readonly lines?: readonly ChartLine[];
  readonly marks?: readonly ChartMark[];
  /** The first candle of the part that is shown after the player's answer. */
  readonly futureFrom?: number;
  /** How many candle slots the chart has room for (so a chart that grows candle by candle keeps its scale). Defaults to candles.length. */
  readonly slots?: number;
  readonly selected?: number;
  readonly onPick?: (index: number) => void;
  readonly format: (price: number) => string;
  /** Prices that must fit on the scale even when no candle reaches them. */
  readonly keepInView?: readonly number[];
  readonly testId?: string;
}

const TONE_CLASS: Record<ChartLine['tone'], string> = { up: 'mc-line-up', down: 'mc-line-down', accent: 'mc-line-accent', muted: 'mc-line-muted' };

export function MiniChart({ candles, label, lines = [], marks = [], futureFrom, slots, selected, onPick, format, keepInView = [], testId }: MiniChartProps) {
  const count = Math.max(slots ?? candles.length, candles.length, 1);
  const g = geometryOf(candles, count, [...lines.map((l) => l.price), ...keepInView]);
  const plotRight = CHART_W - AXIS_W;
  const futureX = futureFrom !== undefined && futureFrom < candles.length ? g.slot * futureFrom : null;
  return (
    <svg className="mini-chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={label} data-testid={testId ?? 'mini-chart'}>
      {futureX !== null && <rect className="mc-future" x={futureX} y={0} width={plotRight - futureX} height={CHART_H} />}
      {gridPrices(g).map((p) => (
        <g key={p}>
          <line className="mc-grid" x1={0} x2={plotRight} y1={g.y(p)} y2={g.y(p)} />
          <text className="mc-axis" x={plotRight + 6} y={g.y(p) + 4}>
            {format(p)}
          </text>
        </g>
      ))}
      {futureX !== null && (
        <g>
          <line className="mc-divider" x1={futureX} x2={futureX} y1={0} y2={CHART_H} />
          <text className="mc-divider-label" x={futureX + 6} y={12}>
            what happened next
          </text>
        </g>
      )}
      {lines.map((l) => (
        <g key={`${l.label}-${l.price}`}>
          <line className={`mc-line ${TONE_CLASS[l.tone]}`} x1={0} x2={plotRight} y1={g.y(l.price)} y2={g.y(l.price)} />
          <text className={`mc-line-label ${TONE_CLASS[l.tone]}`} x={4} y={g.y(l.price) - 4}>
            {l.label}
          </text>
        </g>
      ))}
      {candles.map((c, i) => {
        const up = c.c >= c.o;
        const x = g.x(i);
        const top = g.y(Math.max(c.o, c.c));
        const bottom = g.y(Math.min(c.o, c.c));
        const body = (
          <>
            <line className={up ? 'mc-wick mc-up' : 'mc-wick mc-down'} x1={x} x2={x} y1={g.y(c.h)} y2={g.y(c.l)} />
            <rect className={up ? 'mc-body mc-up' : 'mc-body mc-down'} x={x - g.body / 2} y={top} width={g.body} height={Math.max(1.5, bottom - top)} />
            {selected === i && <rect className="mc-selected" x={x - g.slot / 2} y={0} width={g.slot} height={CHART_H} />}
          </>
        );
        if (!onPick) return <g key={i}>{body}</g>;
        return (
          <g
            key={i}
            className="mc-pick"
            role="button"
            tabIndex={0}
            aria-label={`Candle ${i + 1}: open ${format(c.o)}, high ${format(c.h)}, low ${format(c.l)}, close ${format(c.c)}`}
            onClick={() => onPick(i)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPick(i);
              }
            }}
            data-testid={`mc-candle-${i}`}
          >
            <rect className="mc-hit" x={x - g.slot / 2} y={0} width={g.slot} height={CHART_H} />
            {body}
          </g>
        );
      })}
      {marks.map((m) => {
        const c = candles[m.index];
        if (!c) return null;
        const x = g.x(m.index);
        const above = m.side === 'above';
        const y = above ? g.y(c.h) - 8 : g.y(c.l) + 16;
        return (
          <text key={`${m.index}-${m.label}`} className="mc-mark" x={Math.min(Math.max(x, 40), plotRight - 40)} y={y} textAnchor="middle">
            {above ? '▼ ' : '▲ '}
            {m.label}
          </text>
        );
      })}
    </svg>
  );
}
