// The ten stocks as selectable chips: live price, change since the session started, and what you own.
import { formatCents, formatSignedPercent, type LiveStockView } from '../engine';
import { tone } from './labels';

interface Props {
  stocks: readonly LiveStockView[];
  selected: string;
  onSelect: (ticker: string) => void;
}

export function LiveStockList({ stocks, selected, onSelect }: Props) {
  return (
    <section className="card market-card" aria-label="Stocks">
      <h2>
        Stocks <span className="h2-note">· change since your session started</span>
      </h2>
      <div className="stock-grid" role="group" aria-label="Choose a stock">
        {stocks.map((s) => {
          const active = s.ticker === selected;
          const dir = s.tickChange > 0 ? 'up' : s.tickChange < 0 ? 'down' : 'same';
          return (
            <button
              key={s.ticker}
              type="button"
              className={`stock-chip ${active ? 'active' : ''}`}
              aria-pressed={active}
              onClick={() => onSelect(s.ticker)}
              title={`${s.name} · ${s.sector} (fictional)`}
              data-ticker={s.ticker}
            >
              <span className="chip-top">
                <span className="chip-ticker">{s.ticker}</span>
                <span className={`chip-arrow ${dir}`} aria-hidden="true">
                  {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•'}
                </span>
              </span>
              <span key={s.price} className={`chip-price flash-${dir}`} data-testid={`price-${s.ticker}`}>
                {formatCents(s.price)}
              </span>
              <span className={`chip-change ${tone(s.sessionChange)}`}>{formatSignedPercent(s.sessionChange, s.sessionOpen)}</span>
              <span className="chip-held">{s.position.shares > 0 ? `${s.position.shares} held` : ' '}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
