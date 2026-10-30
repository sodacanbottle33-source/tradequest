// Market events (docs/world.md §39): at 21:00 Tokyo time, at most once a day, something happens to the market (a storm, a meme frenzy, a rally or a sell-off). This strip, at the top of
// the Market page, says when the next one starts (never WHAT it will be), shows the one happening now with the biggest moves, and lists the last few. The server decides and runs
// everything; this only shows what it says.
import { useMarketEvents } from './extrasStore';
import { eventClock, movesText } from './extrasUtil';
import { longUntil } from './goalUtil';
import type { MarketEventLine } from './types';

function Moves({ line, onOpen, n }: { line: MarketEventLine; onOpen: (ticker: string) => void; n: number }) {
  const top = [...line.moves].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, n);
  return (
    <span className="event-moves" data-testid="event-moves">
      {top.map((m) => (
        <button type="button" key={m.ticker} className={`link-btn event-move ${m.pct > 0 ? 'pos' : 'neg'}`} onClick={() => onOpen(m.ticker)} title={m.name} data-testid={`event-move-${m.ticker}`}>
          {m.pct > 0 ? '+' : '−'}
          {Math.abs(m.pct).toFixed(1)}% {m.ticker}
        </button>
      ))}
    </span>
  );
}

export function EventsStrip({ onOpen }: { onOpen: (ticker: string) => void }) {
  const { view, nowMs } = useMarketEvents();
  if (!view || !view.enabled) return null;
  const recent = view.recent.slice(0, 3);
  return (
    <aside className={`card events-strip${view.live ? ' is-live' : ''}`} aria-label="Market events" data-testid="events-strip">
      {view.live ? (
        <p className="event-live" data-testid="events-live">
          <span className="event-icon" aria-hidden="true">
            {view.live.icon}
          </span>{' '}
          <strong>{view.live.name} is happening now.</strong> {view.live.blurb} <Moves line={view.live} onOpen={onOpen} n={4} />
        </p>
      ) : (
        view.next && (
          <p className="event-next" data-testid="events-next">
            <span className="event-icon" aria-hidden="true">
              🌙
            </span>{' '}
            <strong>Market event tonight at {eventClock(view.next.atMs)} Tokyo time</strong> <span className="muted">({longUntil(view.next.atMs, nowMs)}). What happens is a surprise.</span>
          </p>
        )
      )}
      {recent.length > 0 && (
        <ul className="event-recent" data-testid="events-recent" aria-label="Recent events">
          {recent.map((e) => (
            <li key={e.day} data-testid={`event-recent-${e.day}`}>
              <span className="event-icon" aria-hidden="true">
                {e.icon}
              </span>{' '}
              <strong>{e.name}</strong> <span className="muted">· {movesText(e, 3)}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
