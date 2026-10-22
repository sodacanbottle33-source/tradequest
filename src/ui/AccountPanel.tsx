import { formatCents, formatSignedCents, formatSignedPercent, type MarketAccountView } from '../engine';
import { tone } from './labels';

export function AccountPanel({ account }: { account: MarketAccountView }) {
  const a = account;
  const rows: Array<[string, string, string?]> = [['Cash', formatCents(a.cash)]];
  // A buy only turns into shares (and Cash only drops) when it fills at the next candle's open.
  // Until then, show the money pending buys will use so the balance doesn't look unchanged.
  if (a.reservedForPendingBuys > 0) {
    rows.push(['Set aside for pending buys (est.)', `−${formatCents(a.reservedForPendingBuys)}`]);
    rows.push(['Available cash', formatCents(a.availableCash)]);
  }
  rows.push(
    ['Holdings value', formatCents(a.holdingsValue)],
    ['Unrealized P&L', formatSignedCents(a.unrealizedPnl), tone(a.unrealizedPnl)],
    ['Realized P&L', formatSignedCents(a.realizedPnl), tone(a.realizedPnl)],
  );

  return (
    <section className="card account" aria-label="Account">
      <div className="equity">
        <span className="label">Equity (all stocks + cash)</span>
        <span className="equity-value">{formatCents(a.equity)}</span>
        <span className={`equity-return ${tone(a.totalReturn)}`}>
          {formatSignedCents(a.totalReturn)} ({formatSignedPercent(a.totalReturn, a.startCash)})
        </span>
      </div>
      <dl className="stats">
        {rows.map(([label, value, cls]) => (
          <div key={label} className="stat">
            <dt>{label}</dt>
            <dd className={cls ?? ''}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
