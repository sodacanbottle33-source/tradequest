import { formatCents, formatSignedCents, type MarketTrade } from '../engine';
import { tradeCandleLabel, tone } from './labels';

export function TradeHistory({ trades }: { trades: readonly MarketTrade[] }) {
  if (trades.length === 0) return <p className="muted">No trades yet.</p>;
  return (
    <div className="table-wrap">
      <table className="trades">
        <thead>
          <tr>
            <th>#</th>
            <th>Candle</th>
            <th>Stock</th>
            <th>Side</th>
            <th className="num">Qty</th>
            <th className="num">Price</th>
            <th className="num">Amount</th>
            <th className="num">P&amp;L</th>
            <th className="num">Cash after</th>
          </tr>
        </thead>
        <tbody>
          {[...trades].reverse().map((t) => (
            <tr key={t.id}>
              <td>{t.id}</td>
              <td>{tradeCandleLabel(t.candleIndex, t.type)}</td>
              <td className="mono">{t.ticker}</td>
              <td className={t.side === 'BUY' ? 'side-buy' : 'side-sell'}>
                {t.side}
                {t.type === 'liquidation' ? ' (auto)' : ''}
              </td>
              <td className="num">{t.quantity}</td>
              <td className="num">{formatCents(t.price)}</td>
              <td className="num">{formatCents(t.amount)}</td>
              <td className={`num ${t.tradePnl === null ? '' : tone(t.tradePnl)}`}>
                {t.tradePnl === null ? '—' : formatSignedCents(t.tradePnl)}
              </td>
              <td className="num">{formatCents(t.cashAfter)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
