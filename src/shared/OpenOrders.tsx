// The player's open limit orders: what each one waits for, the cash it has set aside, how long it still waits, and a Cancel button.
// Used on the Account screen (all orders) and under the order form (the orders of the company being traded).
import { useState } from 'react';
import { api } from './api';
import { formatCents } from './format';
import { expiryText, kindLabel, limitDirection } from './limitText';
import { sharedStore, useShared } from './store';
import type { LimitOrder } from './types';

interface Props {
  readonly orders: readonly LimitOrder[];
  /** Show the company name column (the Account screen) or not (under the order form of one company). */
  readonly showCompany?: boolean;
  readonly onOpen?: (ticker: string) => void;
}

export function OpenOrders({ orders, showCompany = true, onOpen }: Props) {
  const { tick, prices, companies } = useShared();
  const [busy, setBusy] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const byTicker = new Map(companies.map((c) => [c.ticker, c]));

  const cancel = async (o: LimitOrder) => {
    if (busy !== null) return;
    setBusy(o.id);
    setProblem(null);
    try {
      await api.cancelLimit(o.id);
      await sharedStore.refreshAccount();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (orders.length === 0) return null;
  return (
    <div className="table-wrap" data-testid="open-orders">
      {problem && (
        <p className="notice error" role="alert" data-testid="open-orders-problem">
          {problem}
        </p>
      )}
      <table className="trades">
        <thead>
          <tr>
            <th>Order</th>
            <th className="num">Shares</th>
            <th className="num">Limit price</th>
            <th className="num">Price now</th>
            <th className="num">Set aside</th>
            <th className="num">Time left</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const c = byTicker.get(o.ticker);
            const live = c ? (prices[c.id] ?? 0) : 0;
            const away = live > 0 ? ((o.limitCents - live) / live) * 100 : null;
            return (
              <tr key={o.id} data-testid={`limit-row-${o.id}`}>
                <td>
                  <span className={o.kind === 'buy' || o.kind === 'cover' ? 'side-buy' : 'side-sell'}>
                    <strong>{kindLabel(o.kind)}</strong>
                    {o.leverage > 1 ? <span className="muted"> {o.leverage}x</span> : null}
                  </span>{' '}
                  {onOpen ? (
                    <button type="button" className="link-btn" onClick={() => onOpen(o.ticker)}>
                      <strong>{o.ticker}</strong>
                    </button>
                  ) : (
                    <strong>{o.ticker}</strong>
                  )}
                  {showCompany && c ? <span className="muted"> {c.name}</span> : null}
                  {(o.stopCents > 0 || o.takeCents > 0) && (
                    <span className="muted sub">
                      {o.stopCents > 0 ? `stop ${formatCents(o.stopCents)}` : ''}
                      {o.stopCents > 0 && o.takeCents > 0 ? ' · ' : ''}
                      {o.takeCents > 0 ? `take ${formatCents(o.takeCents)}` : ''}
                    </span>
                  )}
                </td>
                <td className="num mono">
                  {o.filled > 0 ? `${o.filled} of ${o.qty}` : o.qty}
                </td>
                <td className="num mono">
                  {formatCents(o.limitCents)} <span className="muted sub">or {limitDirection(o.kind)}</span>
                </td>
                <td className="num mono">
                  {live > 0 ? formatCents(live) : '—'}
                  {away !== null && <span className="muted sub">{Math.abs(away) < 0.05 ? 'at the limit' : `${Math.abs(away).toFixed(Math.abs(away) < 10 ? 1 : 0)}% ${away < 0 ? 'above' : 'below'} your limit`}</span>}
                </td>
                <td className="num mono" data-testid={`limit-reserved-${o.id}`}>
                  {o.reservedCents > 0 ? formatCents(o.reservedCents) : <span className="muted" title="Closing orders set aside shares, not cash">—</span>}
                </td>
                <td className="num mono">{expiryText(o, tick)}</td>
                <td className="num">
                  <button type="button" className="btn btn-small" disabled={busy !== null} onClick={() => void cancel(o)} data-testid={`limit-cancel-${o.id}`}>
                    {busy === o.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
