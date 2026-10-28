// The layer that plays the badge shows of src/shared/badgeShow.ts: a medal pops in with sparkles when the player earns a badge. One layer is
// mounted for the whole app. It never blocks a click. A person who asked their device for reduced motion gets the card without the moving
// parts (the CSS takes them away), and the card is also announced to screen readers.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { BadgeIcon } from './BadgeIcon';
import { MAX_WAITING, onBadgeShow, sparklesFor, type BadgeShow } from './badgeShow';

interface Playing {
  readonly n: number;
  readonly show: BadgeShow;
}

export function BadgeUnlockLayer() {
  const [playing, setPlaying] = useState<Playing | null>(null);
  const playingRef = useRef<Playing | null>(null);
  const counter = useRef(0);
  const queue = useRef<BadgeShow[]>([]);

  // The state is only a mirror of the ref, so nothing that changes the queue runs inside a state updater (a page may run those twice).
  const start = (show: BadgeShow): void => {
    counter.current += 1;
    const next = { n: counter.current, show };
    playingRef.current = next;
    setPlaying(next);
  };

  useEffect(
    () =>
      onBadgeShow((shows) => {
        let rest = shows;
        if (!playingRef.current) {
          start(shows[0] as BadgeShow);
          rest = shows.slice(1);
        }
        for (const s of rest) if (queue.current.length < MAX_WAITING) queue.current.push(s);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const n = playing?.n ?? 0;
  const ms = playing?.show.ms ?? 0;
  useEffect(() => {
    if (n === 0) return undefined;
    const id = setTimeout(() => {
      const next = queue.current.shift();
      if (next) {
        start(next);
      } else {
        playingRef.current = null;
        setPlaying(null);
      }
    }, ms);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, ms]);

  const sparks = useMemo(() => (playing ? sparklesFor(playing.show.seed, playing.show.sparkles, playing.show.big) : []), [playing]);

  if (!playing || typeof document === 'undefined') return null;
  const s = playing.show;
  return createPortal(
    <div
      className={`badge-show ${s.big ? 'big' : 'small'} tier-${s.tier}${s.secret ? ' secret' : ''}`}
      key={playing.n}
      style={{ '--ms': `${s.ms}ms` } as CSSProperties}
      role="status"
      aria-live="polite"
      data-testid="badge-show"
      data-badge={s.id}
      data-size={s.big ? 'big' : 'small'}
    >
      {s.tier === 4 && <div className="bs-glow" aria-hidden="true" />}
      <div className="bs-card">
        <div className="bs-medal">
          {s.big && <span className="bs-shine" aria-hidden="true" />}
          <span className="bs-ring" aria-hidden="true" />
          <span className="bs-pop">
            <BadgeIcon id={s.id} large />
          </span>
          {s.secret && (
            <span className="bs-qmark" aria-hidden="true">
              ❓
            </span>
          )}
          <span className="bs-origin" aria-hidden="true">
            {sparks.map((p, i) => (
              <span
                key={i}
                className={`bs-spark shape-${p.shape} tone-${p.tone}`}
                style={{ '--dx': `${p.dx}px`, '--dy': `${p.dy}px`, '--rot': `${p.rot}deg`, '--delay': `${p.delay}ms`, '--time': `${p.time}ms`, '--size': `${p.size}px` } as CSSProperties}
              />
            ))}
          </span>
        </div>
        <div className="bs-text">
          <div className="bs-label">{s.secret ? 'Secret badge found!' : 'New badge!'}</div>
          <div className="bs-name">{s.name}</div>
          {s.big && <div className="bs-how">{s.how}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
