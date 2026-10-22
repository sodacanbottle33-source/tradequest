// 1v1: find an opponent, ready up, countdown, a 3-minute match on the shared market, results. The server decides who is in the
// lobby, when the match starts and ends, what every trade costs and who won. This screen shows what the server says.
import { useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { formatCents } from './format';
import { MatchScreen } from './MatchScreen';
import { sharedStore, useShared } from './store';
import type { HistoryEntry, Match } from './types';

function resultText(r: string | null): string {
  return r === 'win' ? 'Won' : r === 'loss' ? 'Lost' : r === 'tie' ? 'Tie' : r === 'forfeit' ? 'Forfeited' : '—';
}

function Players({ match }: { match: Match }) {
  return (
    <ul className="lobby-players" aria-label="Players">
      {match.players.map((p) => (
        <li key={p.userId} className={p.ready ? 'is-ready' : undefined}>
          <span className="player-name">
            {p.name}
            {p.you ? ' (you)' : ''}
          </span>
          {p.bot && <span className="tag">Computer player</span>}
          <span className="tag">{p.ready ? 'Ready' : 'Not ready'}</span>
        </li>
      ))}
      {match.playerCount < match.capacity && (
        <li className="is-empty">
          <span className="player-name muted">Waiting for an opponent…</span>
        </li>
      )}
    </ul>
  );
}

export function LobbyScreen({ onGoSignIn }: { onGoSignIn: () => void }) {
  const { user, match, searching, bots, walletCents, tick } = useShared();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);

  const finishedId = match?.phase === 'finished' || match?.phase === 'cancelled' ? match.id : 0;
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api
      .matches()
      .then((r) => {
        if (!cancelled) setHistory(r.matches);
      })
      .catch(() => {
        if (!cancelled) setHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user, finishedId]);

  if (!user) {
    return (
      <section className="card">
        <h2>1v1 battles</h2>
        <p>Sign in to play a 1v1 battle. Two players trade the same market, with every company you see in Career, for exactly 3 minutes with $1,000 each.</p>
        <button type="button" className="btn btn-primary" onClick={onGoSignIn}>
          Sign in or create an account
        </button>
      </section>
    );
  }

  const act = async (fn: () => Promise<{ match: Match | null } | { ok: boolean }>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if ('match' in r) sharedStore.setMatch(r.match);
      else await sharedStore.refreshLobby();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      await sharedStore.refreshLobby();
    } finally {
      setBusy(false);
    }
  };

  const phase = match?.phase;

  if (match && (phase === 'live' || phase === 'settling' || phase === 'finished' || phase === 'cancelled')) {
    return (
      <MatchScreen
        match={match}
        onDismiss={() => void act(() => api.dismiss())}
        onForfeit={() => void act(() => api.leave())}
        busy={busy}
        error={error}
      />
    );
  }

  const secondsToStart = match && match.startTick !== null ? Math.max(0, match.startTick - tick) : (match?.ticksToStart ?? 0);

  return (
    <div className="lobby">
      <section className="card lobby-card" aria-label="1v1 lobby">
        <h2>
          1v1 battle <span className="h2-note">{match ? `${match.playerCount}/${match.capacity} players` : `${searching} waiting`}</span>
        </h2>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}

        {!match && (
          <>
            <p>
              Two players trade the <strong>same market</strong>, with every company you see in Career, for exactly <strong>3 minutes</strong>. Each starts the match with
              <strong> $1,000</strong> of match cash, separate from your Career money. The bigger profit wins.
            </p>
            <ul className="rules">
              <li>The winner receives their match profit or $50, whichever is more, as virtual currency. The loser receives $50.</li>
              <li>A tie pays $50 to both.</li>
              <li>If you leave a live match you forfeit and your opponent wins. Leaving before it starts costs nothing.</li>
              <li>If the server restarts during a match, the match is cancelled and nobody is paid.</li>
              {bots && <li>If nobody joins you within 10 seconds, a bot plays you. A real player who arrives first always takes the bot&apos;s place.</li>}
            </ul>
            <div className="row-buttons">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(() => api.join())} data-testid="find-match">
                {busy ? 'Looking…' : 'Find a match'}
              </button>
              {bots && (
                <button type="button" className="btn" disabled={busy} onClick={() => void act(() => api.playBot())} data-testid="play-bot">
                  Play a bot now
                </button>
              )}
            </div>
          </>
        )}

        {match && phase === 'waiting' && (
          <>
            <p className="big-status" data-testid="lobby-status">
              Waiting for an opponent… {match.playerCount}/{match.capacity}
            </p>
            <Players match={match} />
            <p className="hint">{match.message}</p>
            <div className="row-buttons">
              {bots && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(() => api.playBot())} data-testid="play-bot">
                  Play a bot now
                </button>
              )}
              <button type="button" className={bots ? 'btn' : 'btn btn-primary'} disabled={busy} onClick={() => void act(() => api.leave())} data-testid="leave-lobby">
                Leave lobby
              </button>
            </div>
          </>
        )}

        {match && phase === 'ready_check' && (
          <>
            <p className="big-status" data-testid="lobby-status">
              {match.players.some((p) => p.bot && !p.you) ? `${match.players.find((p) => p.bot && !p.you)?.name ?? 'A bot'} will play you` : 'Opponent found'} {match.playerCount}/{match.capacity}. Press Ready.
            </p>
            <Players match={match} />
            <p className="hint">{match.message}</p>
            {(() => {
              const me = match.players.find((p) => p.you);
              return (
                <div className="row-buttons">
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(() => api.ready(!(me?.ready ?? false)))} data-testid="ready">
                    {me?.ready ? 'Not ready' : 'Ready'}
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => void act(() => api.leave())} data-testid="leave-lobby">
                    Leave
                  </button>
                </div>
              );
            })()}
          </>
        )}

        {match && phase === 'countdown' && (
          <>
            <p className="countdown" data-testid="countdown" aria-live="assertive">
              {secondsToStart}
            </p>
            <p className="big-status">Match starts in {secondsToStart} s</p>
            <Players match={match} />
            <p className="hint">Prices are the same for both players. The 3 minutes start on the same market tick for both of you.</p>
            <button type="button" className="btn" disabled={busy} onClick={() => void act(() => api.leave())}>
              Leave (no penalty)
            </button>
          </>
        )}
      </section>

      <section className="card" aria-label="Virtual currency and history">
        <h2>
          Your 1v1 record <span className="h2-note">virtual currency {formatCents(walletCents)}</span>
        </h2>
        {history === null && <p className="hint">No matches yet.</p>}
        {history && history.length === 0 && <p className="hint">No matches yet.</p>}
        {history && history.length > 0 && (
          <div className="table-wrap">
            <table className="trades">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Opponent</th>
                  <th className="num">Your profit</th>
                  <th>Result</th>
                  <th className="num">Reward</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.matchId}>
                    <td>{h.endedMs ? new Date(h.endedMs).toLocaleString() : '—'}</td>
                    <td>{h.opponent?.name ?? '—'}</td>
                    <td className={`num mono ${h.you.profitCents && h.you.profitCents > 0 ? 'pos' : h.you.profitCents && h.you.profitCents < 0 ? 'neg' : ''}`}>
                      {h.you.profitCents === null ? '—' : formatCents(h.you.profitCents)}
                    </td>
                    <td>{h.state === 'cancelled' ? `Cancelled${h.cancelReason ? ` (${h.cancelReason.replace(/_/g, ' ')})` : ''}` : resultText(h.you.result)}</td>
                    <td className="num mono">{h.you.rewardCents === null ? '—' : formatCents(h.you.rewardCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
