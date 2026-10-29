// The layer that plays the celebrations of src/shared/winCelebration.ts: confetti and a banner ("+$123.45 · Nice trade!"). It sits on the whole screen
// and never blocks a click. One layer is mounted for the whole app. A person who asked their device for reduced motion gets the banner without
// the flying confetti, the shake or the bobbing (the CSS takes those away), and the banner is also announced to screen readers.
// A player who bought a win style in the Shop (docs/world.md §30) sees his own party in it: other colours, little pictures, three places to burst from. Only the looks change.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { piecesFor } from '../ui/hype';
import { useProfiles } from './profileStore';
import { milestoneOfWin, onCelebrate, type Win } from './winCelebration';
import { styledPieces, winStyleOf } from './winStyles';

interface Playing {
  readonly n: number;
  readonly win: Win;
}

export function WinBurstLayer() {
  const [playing, setPlaying] = useState<Playing | null>(null);
  const counter = useRef(0);
  const queue = useRef<Win[]>([]);
  const { gear } = useProfiles();

  useEffect(
    () =>
      onCelebrate((w) => {
        // A bigger celebration replaces a smaller one that is still playing; a smaller one waits its turn (and at most two wait).
        setPlaying((cur) => {
          if (!cur) {
            counter.current += 1;
            return { n: counter.current, win: w };
          }
          if (w.level > cur.win.level) {
            counter.current += 1;
            return { n: counter.current, win: w };
          }
          if (queue.current.length < 2) queue.current.push(w);
          return cur;
        });
      }),
    [],
  );

  const n = playing?.n ?? 0;
  const level = playing?.win.level ?? 0;
  const ms = playing ? milestoneOfWin(playing.win).durationMs : 0;
  useEffect(() => {
    if (n === 0) return undefined;
    const id = setTimeout(() => {
      const next = queue.current.shift();
      if (next) {
        counter.current += 1;
        setPlaying({ n: counter.current, win: next });
      } else {
        setPlaying(null);
      }
    }, ms);
    return () => clearTimeout(id);
  }, [n, ms]);

  // The style he wears now (or the one the Shop asked to try on).
  const spec = winStyleOf(playing?.win.style ?? gear.win);
  const pieces = useMemo(() => (playing ? styledPieces(piecesFor(playing.win.seed, milestoneOfWin(playing.win)), spec) : []), [playing, spec]);

  // The huge ones shake the page for a moment (not for a person who asked for reduced motion).
  useEffect(() => {
    if (n === 0 || level < 3 || typeof document === 'undefined') return undefined;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const root = document.getElementById('root');
    if (!root) return undefined;
    root.classList.add('fx-shake');
    const id = setTimeout(() => root.classList.remove('fx-shake'), 750);
    return () => {
      clearTimeout(id);
      root.classList.remove('fx-shake');
    };
  }, [n, level]);

  if (!playing || typeof document === 'undefined') return null;
  const w = playing.win;
  return createPortal(
    <div
      className={['burst', 'win-burst', `level-${w.level}`, spec?.banner].filter(Boolean).join(' ')}
      key={playing.n}
      data-testid="win-burst"
      data-kind={w.kind}
      data-style={playing.win.style ?? gear.win ?? ''}
      role="status"
      aria-live="polite"
    >
      {w.level === 3 && <div className="burst-flash" aria-hidden="true" />}
      {([0, 1, 2] as const)
        .filter((o) => pieces.some((p) => p.origin === o))
        .map((o) => (
          <div className={`burst-origin origin-${o}`} aria-hidden="true" key={o}>
            {pieces.map((p, i) =>
              p.origin !== o ? null : (
                <span
                  key={i}
                  className={`piece shape-${p.shape}${p.glyph ? ' glyph' : ''}`}
                  style={{ '--dx': `${p.dx}px`, '--dy': `${p.dy}px`, '--rot': `${p.rot}deg`, '--delay': `${p.delay}ms`, '--time': `${p.time}ms`, '--size': `${p.size}px`, '--color': p.color } as CSSProperties}
                >
                  {p.glyph}
                </span>
              ),
            )}
          </div>
        ))}
      <div className="burst-banner">
        <div className="burst-icon" aria-hidden="true">
          {w.icon}
        </div>
        <div className="burst-x win-x" data-testid="win-label">
          {w.label}
        </div>
        <div className="burst-tag">{w.tag}</div>
        <div className="burst-sub">{w.sub}</div>
      </div>
    </div>,
    document.body,
  );
}
