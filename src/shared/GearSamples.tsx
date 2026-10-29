// Little pictures of the Shop things for your own screen (docs/world.md §30). A candle thing is shown on a small chart drawn with the SAME classes and the same shapes as the
// real chart (src/ui/LiveChart.tsx), so the picture is exactly what the real chart will look like, and a win style on a few of its confetti with a "Try it" button that plays
// the real party. Only for looking: nothing here is bought, worn or sent anywhere.
import { type CSSProperties } from 'react';
import { winStyleOf } from './winStyles';
import { celebrate, type Win } from './winCelebration';

const W = 168;
const H = 76;
const BODY_W = 8;
const SLOT = 15;

/** A made-up run of candles: open, close, high, low (any units; they are only turned into pixels). The last one is the candle still forming. */
const RUN: readonly (readonly [number, number, number, number])[] = [
  [50, 58, 61, 47],
  [58, 54, 60, 51],
  [54, 63, 66, 52],
  [63, 70, 73, 61],
  [70, 66, 72, 63],
  [66, 60, 68, 57],
  [60, 67, 69, 58],
  [67, 76, 79, 65],
  [76, 73, 78, 70],
  [73, 80, 83, 71],
];
const LOW = 44;
const HIGH = 86;
const y = (p: number): number => H - 8 - ((p - LOW) / (HIGH - LOW)) * (H - 16);

/** A small chart with one Shop thing on it (`id` is a candle colour, shape, background or effect). */
export function ChartSample({ id }: { id: string }) {
  const last = RUN.length - 1;
  const close = (RUN[last] as readonly number[])[1] as number;
  return (
    <div className={`company-chart gear-sample cos-${id}`} aria-hidden="true" data-testid={`gear-sample-${id}`}>
      <div className="chart-frame">
        <svg className="chart-svg live-svg" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="presentation">
          {[0.25, 0.5, 0.75].map((f) => (
            <g key={f} className="grid-row" style={{ transform: `translateY(${H * f}px)` }}>
              <line x1={0} x2={W} y1={0} y2={0} className="grid" />
            </g>
          ))}
          {RUN.map(([o, c, h, l], i) => {
            const top = y(Math.max(o, c));
            const bodyH = Math.max(1.5, y(Math.min(o, c)) - top);
            const wickTop = y(h);
            const wickH = Math.max(1, y(l) - wickTop);
            const dir = c > o ? 'up' : c < o ? 'down' : 'flat';
            return (
              <g key={i} className={`candle ${dir} ${i === last ? 'forming' : 'done'}`} transform={`translate(${(i + 0.5) * SLOT + 6},0)`}>
                <rect className="wick" x={-0.6} width={1.2} y={0} height={1} style={{ transform: `translateY(${wickTop}px) scaleY(${wickH})` }} />
                <rect className="body" x={-BODY_W / 2} width={BODY_W} y={0} height={1} style={{ transform: `translateY(${top}px) scaleY(${bodyH})` }} />
              </g>
            );
          })}
          <g className="price-line" style={{ transform: `translateY(${y(close)}px)` }}>
            <line x1={0} x2={W} y1={0} y2={0} className="mark-line" />
          </g>
          <g className="live-dot" transform={`translate(${(last + 0.5) * SLOT + 6},0)`}>
            <g className="live-dot-y" style={{ transform: `translateY(${y(close)}px)` }}>
              <circle className="live-core up" r={3.6} />
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
}

/** What a win style throws: a handful of its colours or little pictures, and a button that plays the real party in that style. */
export function WinSample({ id }: { id: string }) {
  const spec = winStyleOf(id);
  const demo: Win = { kind: 'trade', ticker: 'DEMO', label: '+$123.45', tag: 'Nice trade!', icon: '💰', sub: 'Just trying it on', level: 2, seed: 4242, style: id };
  return (
    <div className="win-sample" data-testid={`win-sample-${id}`}>
      <div className={`win-dots${spec?.banner ? ` ${spec.banner}` : ''}`} aria-hidden="true">
        {Array.from({ length: 9 }, (_, i) =>
          spec?.glyphs ? (
            <span key={i} className="win-glyph">
              {spec.glyphs[i % spec.glyphs.length]}
            </span>
          ) : (
            <span key={i} className="win-dot" style={{ '--color': spec?.palette[i % spec.palette.length] ?? '#fff' } as CSSProperties} />
          ),
        )}
      </div>
      <button type="button" className="btn btn-small btn-ghost" onClick={() => celebrate(demo)} data-testid={`win-try-${id}`}>
        Try it
      </button>
    </div>
  );
}
