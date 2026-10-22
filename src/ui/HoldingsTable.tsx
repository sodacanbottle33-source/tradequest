// Your portfolio: one row per stock you currently own. Click a row to look at that stock.
import { formatCents, formatSignedCents, type StockView } from '../engine';
import { tone } from './labels';

interface Props {
  stocks: readonly StockView[];
  selected: string;
  onSelect: (ticker: string) => void;
}

export function HoldingsTable({ stocks, selected, onSelect }: Props) {
  const held = stocks.filter((s) => s.position.shares > 0);
  if (held.length === 0) {
    return <p className="muted">You don't own any shares yet. Pick a stock, place a buy order, then press Next candle.</p>;
  }
  const totalValue = held.reduce((a, s) => a + s.position.positionValue, 0);
  const totalPnl = held.reduce((a, s) => a + s.position.unrealizedPnl, 0);
  return (
    <div className="table-wrap">
      <table className="trades holdings">
        <thead>
          <tr>
            <th>Stock</th>
            <th className="num">Shares</th>
            <th className="num">Avg entry</th>
            <th className="num">Last</th>
            <th className="num">Value</th>
            <th className="num">Unrealized P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {held.map((s) => (
            <tr key={s.ticker} className={s.ticker === selected ? 'row-selected' : ''}>
              <td>
                <button type="button" className="link-btn" onClick={() => onSelect(s.ticker)}>
                  {s.ticker}
                </button>
              </td>
              <td className="num">{s.position.shares}</td>
              <td className="num">{s.position.averageEntry === null ? '—' : formatCents(s.position.averageEntry)}</td>
              <td className="num">{formatCents(s.markPrice)}</td>
              <td className="num">{formatCents(s.position.positionValue)}</td>
              <td className={`num ${tone(s.position.unrealizedPnl)}`}>{formatSignedCents(s.position.unrealizedPnl)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td />
            <td />
            <td />
            <td className="num">{formatCents(totalValue)}</td>
            <td className={`num ${tone(totalPnl)}`}>{formatSignedCents(totalPnl)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
