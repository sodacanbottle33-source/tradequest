// A running 1v1 match and its results. Everything shown comes from the server: the clock counts the market's own ticks, the
// match account is the server's, and the result and rewards appear only when the server has settled the match.
import { useEffect, useState } from 'react';
import { api } from './api';
import { CAREER_CLOSED_NOTE, MATCH_TABS, tabAfterOpen, type MatchTab } from './careerLock';
import { CompanyView } from './CompanyView';
import { EarningsScreen } from './EarningsScreen';
import { formatCents, formatClock } from './format';
import { MarketScreen } from './MarketScreen';
import { NewsScreen } from './NewsScreen';
import { sharedStore, useShared } from './store';
import type { Account, Match } from './types';

interface Props {
  match: Match;
  onDismiss: () => void;
  onForfeit: () => void;
  busy: boolean;
  error: string | null;
  /** A company asked for from outside the match (a news story): opened once, then `onJumpDone` is called. */
  jump?: { ticker: string } | null;
  onJumpDone?: () => void;
}

function Results({ match, onDismiss, busy }: { match: Match; onDismiss: () => void; busy: boolean }) {
  const { walletCents } = useShared();
  const me = match.players.find((p) => p.you);
  const other = match.players.find((p) => !p.you);
  const headline =
    match.phase === 'cancelled'
      ? 'Match cancelled'
      : match.outcome === 'abandoned'
        ? 'Match abandoned'
        : match.outcome === 'tie'
          ? 'It is a tie'
          : me?.result === 'win'
            ? 'You won!'
            : me?.result === 'forfeit'
              ? 'You forfeited'
              : 'You lost';
  return (
    <section className="card results-card" aria-label="Match results">
      <p className="eyebrow">1v1 battle #{match.id}</p>
      <h2 data-testid="match-result">{headline}</h2>
      <p>{match.message}</p>
      {match.phase === 'finished' && (
        <div className="table-wrap">
          <table className="trades">
            <thead>
              <tr>
                <th>Player</th>
                <th className="num">Final value</th>
                <th className="num">Profit</th>
                <th>Result</th>
                <th className="num">Reward</th>
              </tr>
            </thead>
            <tbody>
              {[me, other].map((p) =>
                p ? (
                  <tr key={p.userId} className={p.you ? 'row-selected' : undefined}>
                    <td>
                      {p.name}
                      {p.you ? ' (you)' : ''}
                    </td>
                    <td className="num mono">{p.finalValueCents === null ? '—' : formatCents(p.finalValueCents)}</td>
                    <td className={`num mono ${p.profitCents !== null && p.profitCents > 0 ? 'pos' : p.profitCents !== null && p.profitCents < 0 ? 'neg' : ''}`}>
                      {p.profitCents === null ? '—' : formatCents(p.profitCents)}
                    </td>
                    <td>{p.result === 'win' ? 'Won' : p.result === 'loss' ? 'Lost' : p.result === 'tie' ? 'Tie' : p.result === 'forfeit' ? 'Forfeited' : '—'}</td>
                    <td className="num mono">{p.rewardCents === null ? '—' : formatCents(p.rewardCents)}</td>
                  </tr>
                ) : null,
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        Match results are saved once. Your virtual currency is now <strong data-testid="wallet">{formatCents(walletCents)}</strong>. Your Career account was not touched.
      </p>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={onDismiss} data-testid="close-results">
        Close
      </button>
    </section>
  );
}

export function MatchScreen({ match, onDismiss, onForfeit, busy, error, jump = null, onJumpDone }: Props) {
  const { tick, user, companies } = useShared();
  const [account, setAccount] = useState<Account | null>(null);
  const [ticker, setTicker] = useState<string | null>(null);
  // The same lists as Career, apart from Launch: stocks, memecoins, the earnings calendar and the news.
  const [tab, setTab] = useState<MatchTab>('market');
  const [accError, setAccError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // Forfeiting asks "are you sure?" inside the page: a browser pop-up can be blocked or dismissed without the player seeing it.
  const [confirming, setConfirming] = useState(false);

  const live = match.phase === 'live';

  /** Opens a company page; a coin sits under Memecoins and a stock under Market, and one opened from Earnings or News keeps that section behind it. */
  const open = (t: string) => {
    setTicker(t);
    setTab((current) => tabAfterOpen(current, companies.find((c) => c.ticker === t)?.sector === 'meme'));
    window.scrollTo?.(0, 0);
  };
  // A company asked for from outside (a news story clicked while the match runs) opens here, once.
  useEffect(() => {
    if (jump === null) return;
    open(jump.ticker);
    onJumpDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  useEffect(() => {
    if (!live) return undefined;
    let cancelled = false;
    const load = () =>
      api
        .account('match')
        .then((a) => {
          if (!cancelled) {
            setAccount(a);
            setAccError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setAccError(e instanceof Error ? e.message : String(e));
        });
    void load();
    const id = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [live, match.id, version]);

  if (!live && match.phase !== 'settling') return <Results match={match} onDismiss={onDismiss} busy={busy} />;

  if (match.phase === 'settling') {
    return (
      <section className="card" aria-live="polite">
        <h2>Time! Calculating the result…</h2>
        <p className="hint">The server scores both players from the stored prices of the last tick of the match. This takes a few seconds.</p>
      </section>
    );
  }

  const left = match.endTick !== null ? Math.max(0, match.endTick - tick) : (match.ticksLeft ?? 0);
  const opponent = match.players.find((p) => !p.you);
  const me = match.players.find((p) => p.you);

  return (
    <div className="match-layout">
      <section className="card match-head" aria-label="Match status">
        <div>
          <p className="eyebrow">1v1 battle #{match.id} · vs {opponent?.name ?? 'opponent'}</p>
          <p className="match-timer" data-testid="match-timer" aria-live="off">
            {formatClock(left)}
          </p>
          <p className="muted">of 3:00 · same market, same prices for both players</p>
          {!me?.forfeited && (
            <p className="muted" data-testid="career-closed-note">
              {CAREER_CLOSED_NOTE}
            </p>
          )}
        </div>
        <dl className="stats">
          <div className="stat">
            <dt>Match cash</dt>
            <dd data-testid="match-cash">{account ? formatCents(account.cashCents) : '—'}</dd>
          </div>
          <div className="stat">
            <dt>Match value</dt>
            <dd>{account ? formatCents(account.netWorthCents) : '—'}</dd>
          </div>
          <div className="stat">
            <dt>Profit so far</dt>
            <dd className={account && account.profitCents > 0 ? 'pos' : account && account.profitCents < 0 ? 'neg' : ''} data-testid="match-profit">
              {account ? formatCents(account.profitCents) : '—'}
            </dd>
          </div>
        </dl>
        {me?.forfeited ? (
          <p className="notice info" data-testid="forfeited-note">
            You forfeited. You cannot trade in this match any more, and your opponent wins when the timer reaches 0:00.
          </p>
        ) : confirming ? (
          <div className="notice warn" role="alert" data-testid="forfeit-confirm">
            <p>Really forfeit? Your opponent wins this match.</p>
            <div className="results-actions">
              <button type="button" className="btn btn-sell" disabled={busy} onClick={onForfeit} data-testid="forfeit-yes">
                Yes, forfeit
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(false)} data-testid="forfeit-no">
                Keep playing
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(true)} data-testid="forfeit">
            Forfeit
          </button>
        )}
      </section>
      {(error || accError) && (
        <p className="notice error" role="alert">
          {error ?? accError}
        </p>
      )}

      <section className="card" aria-label="Match holdings">
        <h2>
          Match holdings <span className="h2-note">your opponent's score stays hidden until the match is over</span>
        </h2>
        {account && account.positions.length === 0 && <p className="hint">You hold nothing yet. Pick any company below and buy before time runs out.</p>}
        {account && account.positions.length > 0 && (
          <div className="table-wrap">
            <table className="trades">
              <tbody>
                {account.positions.map((p) => (
                  <tr key={p.ticker}>
                    <td>
                      <button type="button" className="link-btn" onClick={() => open(p.ticker)}>
                        <strong>{p.ticker}</strong>
                      </button>{' '}
                      {p.short && <span className="tag neg">short</span>}
                    </td>
                    <td className="num mono">
                      {p.short ? `−${p.shares}` : p.shares} sh
                      {(p.debtCents > 0 || (p.short && p.liqPrice > 0)) && (
                        <span className="muted">
                          {' '}
                          · {p.leverage}x, closed at {formatCents(p.liqPrice)}
                          {p.short ? ' or higher' : ''}
                        </span>
                      )}
                      {(p.stopCents > 0 || p.takeCents > 0) && (
                        <span className="muted">
                          {' '}
                          · {p.stopCents > 0 ? `stop ${formatCents(p.stopCents)}` : ''}
                          {p.stopCents > 0 && p.takeCents > 0 ? ', ' : ''}
                          {p.takeCents > 0 ? `take ${formatCents(p.takeCents)}` : ''}
                        </span>
                      )}
                    </td>
                    <td className={`num mono ${p.unrealizedCents >= 0 ? 'pos' : 'neg'}`}>{formatCents(p.unrealizedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">
          When time runs out, positions are valued at the last price of the match, minus any debt from leverage; a short counts as what is left of its
          collateral after buying the shares back at that price. A leveraged or short position that the market closes (its margin is gone) is lost for
          the rest of the match. A stop-loss or take-profit closes the whole position by itself, until the last second of the match.
        </p>
      </section>

      {/* The same lists as Career (stocks, memecoins, earnings, news), then the company page with its chart, book, news and trade panel. */}
      <nav className="tabs" role="tablist" aria-label="Match sections">
        {MATCH_TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'tab active' : 'tab'}
            onClick={() => {
              setTab(id);
              setTicker(null);
            }}
            data-testid={`mtab-${id}`}
          >
            {label}
          </button>
        ))}
      </nav>
      {ticker ? (
        <CompanyView
          ticker={ticker}
          onBack={() => setTicker(null)}
          onTicker={open}
          trade={{
            kind: 'match',
            account,
            blocked: user ? (match.canTrade ? null : 'Trading is closed for this match right now.') : 'Sign in first.',
            onTraded: (r) => {
              setAccount(r.account);
              setVersion((v) => v + 1);
              void sharedStore.refreshLobby();
            },
          }}
        />
      ) : tab === 'earnings' ? (
        <EarningsScreen onOpen={open} />
      ) : tab === 'news' ? (
        <NewsScreen onTicker={open} />
      ) : (
        <MarketScreen key={tab} kind={tab === 'coins' ? 'coins' : 'stocks'} onOpen={open} selected={null} hideLaunched />
      )}
    </div>
  );
}
