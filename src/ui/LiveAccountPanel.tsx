import { formatCents, formatSignedCents, formatSignedPercent, type LiveAccountView } from '../engine';
import { tone } from './labels';

export function LiveAccountPanel({ account }: { account: LiveAccountView }) {
  const a = account;
  const rows: Array<[string, string, string?]> = [
    ['Cash', formatCents(a.cash)],
    ['Holdings value', formatCents(a.holdingsValue)],
    ['Unrealized P&L', formatSignedCents(a.unrealizedPnl), tone(a.unrealizedPnl)],
    ['Realized P&L', formatSignedCents(a.realizedPnl), tone(a.realizedPnl)],
  ];
  return (
    <section className="card account" aria-label="Account">
      <div className="equity">
        <span className="label">Net worth (cash + shares at current prices)</span>
        <span className="equity-value" data-testid="equity">
          {formatCents(a.equity)}
        </span>
        <span className={`equity-return ${tone(a.totalReturn)}`}>
          {formatSignedCents(a.totalReturn)} ({formatSignedPercent(a.totalReturn, a.startCash)})
        </span>
      </div>
      <dl className="stats">
        {rows.map(([label, value, cls]) => (
          <div key={label} className="stat">
            <dt>{label}</dt>
            <dd className={cls ?? ''} data-testid={`stat-${label.split(' ')[0]?.toLowerCase()}`}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
