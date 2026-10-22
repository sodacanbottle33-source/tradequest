// The ten stocks as a row of selectable chips: price, change since the previous candle, and what you
// own or have pending. Selecting a chip only changes which stock the chart and order panel show.
import { formatCents, formatSignedPercent, type StockView } from '../engine';
import { tone } from './labels';

interface Props {
  stocks: readonly StockView[];
  selected: string;
  onSelect: (ticker: string) => void;
}

export function StockList({ stocks, selected, onSelect }: Props) {
  return (
    <section className="card market-card" aria-label="Stocks">
      <h2>Stocks</h2>
      <div className="stock-grid" role="group" aria-label="Choose a stock">
        {stocks.map((s) => {
          const active = s.ticker === selected;
          return (
            <button
              key={s.ticker}
              type="button"
              className={`stock-chip ${active ? 'active' : ''}`}
              aria-pressed={active}
              onClick={() => onSelect(s.ticker)}
              title={`${s.name} · ${s.sector} (fictional)`}
            >
              <span className="chip-top">
                <span className="chip-ticker">{s.ticker}</span>
                {s.pending && (
                  <span className={`chip-flag ${s.pending.side === 'BUY' ? 'buy' : 'sell'}`} title="Pending order">
                    {s.pending.side === 'BUY' ? 'B' : 'S'}
                    {s.pending.quantity}
                  </span>
                )}
              </span>
              <span className="chip-price">{formatCents(s.markPrice)}</span>
              <span className={`chip-change ${tone(s.change)}`}>{formatSignedPercent(s.change, s.previousClose)}</span>
              <span className="chip-held">{s.position.shares > 0 ? `${s.position.shares} held` : ' '}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
