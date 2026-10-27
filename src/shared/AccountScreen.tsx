// The player's Career account: cash, holdings, trades. Career money is separate from the 1v1 match cash and rewards.
import { useEffect, useState } from 'react';
import { pulseClass, usePulse, useTween } from '../ui/usePulse';
import { api } from './api';
import { AuthPanel } from './AuthPanel';
import { CompanyLogo } from './CompanyLogo';
import { formatBps, formatCents, formatShares, toneOf } from './format';
import { OpenOrders } from './OpenOrders';
import { sharedStore, useShared } from './store';
import type { Trade } from './types';
import { UsernamePanel } from './UsernamePanel';

/** What a trade is called in the list: the market's own trades say why they happened. */
export function tradeLabel(t: Trade): string {
  if (t.liquidated) return 'Liquidated';
  if (t.auto === 'stop') return 'Stop-loss';
  if (t.auto === 'take') return 'Take-profit';
  if (t.short) return t.side === 'sell' ? 'Short' : 'Cover';
  return t.side === 'buy' ? 'Buy' : 'Sell';
}

/** True for a trade that closes (part of) a position, so it has a result. */
export function closes(t: Trade): boolean {
  return t.short ? t.side === 'buy' : t.side === 'sell';
}

export function AccountScreen({ onOpen }: { onOpen: (ticker: string) => void }) {
  const { user, career, walletCents, prices, companies, limits } = useShared();
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Looks only: net worth rolls to its new value, and cash flashes when a trade changes it.
  const netShown = useTween(career?.netWorthCents ?? 0, 450, user?.id ?? '');
  const cashPulse = usePulse(career?.cashCents ?? 0, user?.id ?? '');

  const tradeCount = career ? career.positions.length : 0;
  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    api
      .trades('career', 30)
      .then((r) => {
        if (!cancelled) setTrades(r.trades);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [user, career?.cashCents, tradeCount]);

  if (!user) return <AuthPanel />;

  const names = new Map(companies.map((c) => [c.ticker, c]));
  return (
    <div className="account-layout">
      <section className="card" aria-label="Career account">
        <div className="row-between">
          <h2>
            {user.displayName} <span className="h2-note">Career account{user.role === 'owner' ? ' · owner' : user.role === 'moderator' ? ' · moderator' : ''}</span>
          </h2>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => void sharedStore.signOut()}>
            Sign out
          </button>
        </div>
        {!career && <p className="hint">Loading your account…</p>}
        {career && (
          <dl className="stats">
            <div className="stat">
              <dt>Net worth</dt>
              <dd data-testid="career-net">
                <span className="price-roll">{formatCents(Math.round(netShown))}</span>
              </dd>
            </div>
            <div className="stat">
              <dt>Cash</dt>
              <dd data-testid="career-cash">
                <span className={`price-roll ${pulseClass(cashPulse, 'flash')}`.trim()}>{formatCents(career.cashCents)}</span>
              </dd>
            </div>
            {career.reservedCents > 0 && (
              <div className="stat">
                <dt>Set aside in open orders</dt>
                <dd data-testid="career-reserved">{formatCents(career.reservedCents)}</dd>
              </div>
            )}
            <div className="stat">
              <dt>Profit since start</dt>
              <dd className={toneOf(career.profitCents)}>{formatCents(career.profitCents)}</dd>
            </div>
            <div className="stat">
              <dt>Realized profit</dt>
              <dd className={toneOf(career.realizedCents)}>{formatCents(career.realizedCents)}</dd>
            </div>
            <div className="stat">
              <dt>1v1 virtual currency</dt>
              <dd data-testid="wallet-balance">{formatCents(walletCents)}</dd>
            </div>
          </dl>
        )}
        <p className="hint">
          {career && career.reservedCents > 0 ? 'Cash set aside in open limit orders is still yours and counts in net worth; it comes back when an order fills, ends or is cancelled. ' : ''}Holdings are valued at the price you could sell at right now (the bid), minus any debt from leverage. A short position is valued at the price you would pay to buy the shares back (the ask) and counts as what is left of its collateral. 1v1 rewards go to your virtual currency, never to Career cash.
        </p>
      </section>

      <UsernamePanel />

      <section className="card" aria-label="Holdings">
        <h2>Holdings</h2>
        {career && career.positions.length === 0 && <p className="hint">You hold no shares yet. Pick a company on the Market or Memecoins tab.</p>}
        {career && career.positions.length > 0 && (
          <div className="table-wrap">
            <table className="trades">
              <thead>
                <tr>
                  <th>Company</th>
                  <th className="num">Shares</th>
                  <th className="num">Entry price</th>
                  <th className="num">Price now</th>
                  <th className="num">Value</th>
                  <th className="num">Leverage</th>
                  <th className="num">Stop / Take</th>
                  <th className="num">Gain / loss</th>
                </tr>
              </thead>
              <tbody>
                {career.positions.map((p) => {
                  const c = names.get(p.ticker);
                  const live = c ? (prices[c.id] ?? 0) : 0;
                  return (
                    <tr key={p.ticker}>
                      <td>
                        <CompanyLogo ticker={p.ticker} size={22} className="logo-inline" />
                        <button type="button" className="link-btn" onClick={() => onOpen(p.ticker)}>
                          <strong>{p.ticker}</strong>
                        </button>{' '}
                        {p.short && (
                          <span className="tag neg" data-testid={`short-tag-${p.ticker}`}>
                            short
                          </span>
                        )}{' '}
                        {p.dead && (
                          <span className="tag neg" data-testid={`dead-tag-${p.ticker}`} title="Its developer took all the money out of the pool: worth nothing, cannot be sold.">
                            rug pulled
                          </span>
                        )}{' '}
                        {p.bankrupt && (
                          <span className="tag neg" data-testid={`bankrupt-tag-${p.ticker}`} title="The company went bankrupt: its price stopped. You can only sell it (or cover a short) at that price.">
                            bankrupt
                          </span>
                        )}{' '}
                        <span className="muted">{c?.name ?? ''}</span>
                      </td>
                      <td className="num mono">{p.short ? `−${formatShares(p.shares)}` : formatShares(p.shares)}</td>
                      <td className="num mono">{formatCents(p.avgCostCents)}</td>
                      <td className="num mono">{live > 0 ? formatCents(live) : formatCents(p.short ? p.ask : p.bid)}</td>
                      <td className="num mono">
                        {p.short ? (
                          <>
                            {formatCents(p.valueCents)} <span className="muted sub">to buy back · {formatCents(p.creditCents + p.costCents)} held</span>
                          </>
                        ) : (
                          <>
                            {formatCents(p.valueCents)}
                            {p.debtCents > 0 && <span className="muted sub">− {formatCents(p.debtCents)} debt</span>}
                          </>
                        )}
                      </td>
                      <td className="num mono" data-testid={`leverage-cell-${p.ticker}`}>
                        {p.debtCents > 0 || (p.short && p.liqPrice > 0) ? (
                          <>
                            {p.leverage}x{' '}
                            <span className="muted sub">
                              closed at {formatCents(p.liqPrice)}
                              {p.short ? ' or higher' : ''}
                            </span>
                            {p.rateBps > 0 && (
                              <span className="muted sub" data-testid={`cost-cell-${p.ticker}`}>
                                {p.short ? 'borrow fee' : 'interest'} {(p.rateBps / 100).toFixed(p.rateBps % 100 === 0 ? 0 : 1)}% a year · {formatCents(p.chargedCents)} paid so far
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="num mono" data-testid={`exits-cell-${p.ticker}`}>
                        {p.stopCents > 0 || p.takeCents > 0 ? (
                          <>
                            {p.stopCents > 0 && <span className="neg">stop {formatCents(p.stopCents)}</span>}
                            {p.stopCents > 0 && p.takeCents > 0 && ' · '}
                            {p.takeCents > 0 && <span className="pos">take {formatCents(p.takeCents)}</span>}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className={`num mono ${toneOf(p.unrealizedCents)}`}>
                        {formatCents(p.unrealizedCents)}{' '}
                        <span className="muted">{p.costCents > 0 ? formatBps(Math.round((p.unrealizedCents / p.costCents) * 10_000)) : ''}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {limits.length > 0 && (
        <section className="card" aria-label="Open orders">
          <h2>
            Open orders <span className="h2-note">limit orders waiting for their price</span>
          </h2>
          <OpenOrders orders={limits} onOpen={onOpen} />
          <p className="hint">
            An order trades as soon as the market price reaches its limit, never at a worse price than the limit. Cash for orders that open a position is set aside until then; orders that sell or cover promise the shares they will close.
          </p>
        </section>
      )}

      <section className="card" aria-label="Recent trades">
        <h2>Recent trades</h2>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {trades && trades.length === 0 && <p className="hint">No trades yet.</p>}
        {trades && trades.length > 0 && (
          <div className="table-wrap">
            <table className="trades">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Side</th>
                  <th>Company</th>
                  <th className="num">Filled</th>
                  <th className="num">Avg price</th>
                  <th className="num">Total</th>
                  <th className="num">Fee</th>
                  <th className="num">Result</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.createdMs).toLocaleTimeString()}</td>
                    <td className={t.liquidated || t.side === 'sell' ? 'side-sell' : 'side-buy'} data-testid={`trade-kind-${t.id}`}>
                      {tradeLabel(t)}
                      {t.clientOrderId.startsWith('limit-') ? <span className="muted"> (limit)</span> : null}
                      {!t.short && t.side === 'buy' && t.leverage > 1 ? <span className="muted"> {t.leverage}x</span> : null}
                      {t.short && t.side === 'sell' && t.leverage > 1 ? <span className="muted"> {t.leverage}x</span> : null}
                    </td>
                    <td>{t.ticker}</td>
                    <td className="num mono">
                      {t.filled}
                      {t.filled < t.requested ? ` of ${t.requested}` : ''}
                    </td>
                    <td className="num mono">{formatCents(t.avgPrice)}</td>
                    <td className="num mono">{formatCents(t.totalCents)}</td>
                    <td className="num mono" data-testid={`trade-fee-${t.id}`}>{t.feeCents > 0 ? formatCents(t.feeCents) : <span className="muted">—</span>}</td>
                    <td className={`num mono ${toneOf(t.realizedCents)}`}>{closes(t) ? formatCents(t.realizedCents) : <span className="muted">—</span>}</td>
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
