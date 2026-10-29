// Ranked 1v1 (docs/world.md §31): the player's tier and points, the ladder of the week and last week's podium. A match against a random real player moves points; a match against a
// bot or a friend never does. The server holds every number; this card shows what it says.
import { useEffect, useState } from 'react';
import { api } from './api';
import { barPercent } from './goalUtil';
import { nextTierText, seasonEndText } from './rankedUtil';
import { problemText } from './playersUtil';
import type { RankedView } from './types';

/** `version` changes when a match ended, so the card asks again. */
export function RankedCard({ version }: { version: number }) {
  const [view, setView] = useState<RankedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    api
      .ranked()
      .then((v) => {
        if (!alive) return;
        setView(v);
        setError(null);
        setNowMs(Date.now());
      })
      .catch((e: unknown) => {
        if (alive) setError(problemText(e));
      });
    return () => {
      alive = false;
    };
  }, [version]);
  if (error && !view) {
    return (
      <section className="card ranked-card" aria-label="Ranked 1v1">
        <h2>Ranked 1v1</h2>
        <p className="notice error" role="alert">
          {error}
        </p>
      </section>
    );
  }
  if (!view) {
    return (
      <section className="card ranked-card" aria-label="Ranked 1v1" data-testid="ranked-loading">
        <h2>Ranked 1v1</h2>
        <p className="hint">Loading…</p>
      </section>
    );
  }
  const me = view.me;
  const rows = all ? view.ladder : view.ladder.slice(0, 10);
  return (
    <section className="card ranked-card" aria-label="Ranked 1v1" data-testid="ranked-card">
      <h2>
        Ranked 1v1 <span className="h2-note">{seasonEndText(view, nowMs)}</span>
      </h2>
      <div className={`rank-me tier-${me.tier}`} data-testid="rank-me">
        <span className="rank-icon" aria-hidden="true">
          {me.tierIcon}
        </span>
        <div className="rank-me-text">
          <strong className="rank-tier" data-testid="rank-tier">
            {me.tierName}
          </strong>
          <span className="mono rank-points" data-testid="rank-points">
            {me.points} points
          </span>
        </div>
        <div className="rank-me-side muted">
          {me.place === null ? 'No place yet' : `Place ${me.place} of ${view.players}`}
          <br />
          {me.wins} won · {me.losses} lost
        </div>
      </div>
      <div className="rank-bar" role="progressbar" aria-label="Progress to the next tier" aria-valuemin={0} aria-valuemax={100} aria-valuenow={barPercent(me.into, me.span || 1)}>
        <span className="rank-bar-fill" style={{ width: `${me.next ? barPercent(me.into, me.span) : 100}%` }} />
      </div>
      <p className="hint" data-testid="rank-next">
        {nextTierText(me)}. {me.floorPoints > 0 ? `Your points can not fall below ${me.floorPoints} this season.` : 'Reach Silver and your points can not fall back below it this season.'}
      </p>
      <ul className="rules">
        <li>Only matches against random real players from the lobby are ranked. A match against a bot or a friend never moves points.</li>
        <li>A win gives about 25 points (more against a stronger player), a loss takes about 20. Leaving a live match costs 10 more.</li>
        <li>The same two players earn points from each other only {view.rules.pairLimit} times an hour.</li>
        <li>A new season starts every Monday at 00:00 Tokyo time: points move halfway back to {view.startPoints}. Play {view.rules.minMatches} ranked matches to finish on the podium.</li>
      </ul>

      <h3>
        Ladder this week <span className="h2-note">{view.players} player{view.players === 1 ? '' : 's'}</span>
      </h3>
      {view.ladder.length === 0 ? (
        <p className="hint">Nobody has played a ranked match this week. Be the first.</p>
      ) : (
        <div className="table-wrap">
          <table className="trades ladder" data-testid="ladder">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Player</th>
                <th>Tier</th>
                <th className="num">Points</th>
                <th className="num">Matches</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.username} className={e.you ? 'row-selected' : undefined}>
                  <td className="num mono">{e.place}</td>
                  <td>
                    {e.displayName}
                    {e.you ? ' (you)' : ''}
                  </td>
                  <td>
                    <span aria-hidden="true">{e.tierIcon}</span> {e.tierName}
                  </td>
                  <td className="num mono">{e.points}</td>
                  <td className="num mono">{e.matches}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view.ladder.length > 10 && (
        <button type="button" className="btn btn-small btn-ghost" onClick={() => setAll(!all)} data-testid="ladder-more">
          {all ? 'Show the top 10' : `Show all ${view.ladder.length}`}
        </button>
      )}
      {view.lastSeason && view.lastSeason.places.length > 0 && (
        <div className="rank-last" data-testid="rank-last">
          <h3>Last season&apos;s podium</h3>
          <ol>
            {view.lastSeason.places.slice(0, 3).map((p) => (
              <li key={p.place}>
                <span aria-hidden="true">{p.place === 1 ? '🥇' : p.place === 2 ? '🥈' : '🥉'}</span> {p.displayName} <span className="muted mono">{p.points} points</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
