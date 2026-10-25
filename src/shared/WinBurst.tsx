// The layer that plays the celebrations of src/shared/winCelebration.ts: confetti and a banner ("+$123.45 · Nice trade!"). It sits on the whole screen
// and never blocks a click. One layer is mounted for the whole app. A person who asked their device for reduced motion gets the banner without
// the flying confetti, the shake or the bobbing (the CSS takes those away), and the banner is also announced to screen readers.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { piecesFor } from '../ui/hype';
import { milestoneOfWin, onCelebrate, type Win } from './winCelebration';

interface Playing {
  readonly n: number;
  readonly win: Win;
}

export function WinBurstLayer() {
  const [playing, setPlaying] = useState<Playing | null>(null);
  const counter = useRef(0);
  const queue = useRef<Win[]>([]);

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

  const pieces = useMemo(() => (playing ? piecesFor(playing.win.seed, milestoneOfWin(playing.win)) : []), [playing]);

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
    <div className={`burst win-burst level-${w.level}`} key={playing.n} data-testid="win-burst" data-kind={w.kind} role="status" aria-live="polite">
      {w.level === 3 && <div className="burst-flash" aria-hidden="true" />}
      <div className="burst-origin" aria-hidden="true">
        {pieces.map((p, i) => (
          <span
            key={i}
            className={`piece shape-${p.shape}`}
            style={{ '--dx': `${p.dx}px`, '--dy': `${p.dy}px`, '--rot': `${p.rot}deg`, '--delay': `${p.delay}ms`, '--time': `${p.time}ms`, '--size': `${p.size}px`, '--color': p.color } as CSSProperties}
          />
        ))}
      </div>
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
