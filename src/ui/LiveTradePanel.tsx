// Order entry for live mode: orders fill immediately at the current price (rules.md §13.5).
import { useState, type FormEvent } from 'react';
import { formatCents, formatSignedCents, parseQuantity, type LiveStockView, type LiveView, type Side } from '../engine';
import { tone } from './labels';

interface Props {
  view: LiveView;
  stock: LiveStockView;
  onOrder: (ticker: string, side: Side, quantityText: string) => void;
}

export function LiveTradePanel({ view, stock, onOrder }: Props) {
  const [side, setSide] = useState<Side>('BUY');
  const [qty, setQty] = useState('');
  const parsed = parseQuantity(qty);
  const total = parsed.ok ? parsed.value * stock.price : null;
  const limit = side === 'BUY' ? stock.maxBuyQuantity : stock.maxSellQuantity;
  const disabled = !view.canTrade;

  // Explain a problem BEFORE the click (the engine still checks everything on submit).
  let problem: string | null = null;
  if (qty !== '' && !parsed.ok) {
    problem = parsed.reason;
  } else if (parsed.ok && parsed.value > limit) {
    if (side === 'SELL') {
      problem =
        limit === 0
          ? `You don't hold any shares of ${stock.ticker} to sell.`
          : `You only hold ${limit} share${limit === 1 ? '' : 's'} of ${stock.ticker}.`;
    } else if (limit === 0) {
      problem = `Not enough cash: 1 share of ${stock.ticker} costs ${formatCents(stock.price)}, but you have ${formatCents(view.account.cash)}.`;
    } else {
      problem = `Not enough cash: ${parsed.value} shares of ${stock.ticker} cost ${formatCents(total ?? 0)} at the current price. You can afford up to ${limit}.`;
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onOrder(stock.ticker, side, qty);
  };

  return (
    <section className="card order" aria-label="Order entry">
      <h2>
        Trade · <span className="order-ticker">{stock.ticker}</span>
      </h2>
      <div className="live-price" aria-live="off">
        <span className="live-price-value" data-testid="live-price">
          {formatCents(stock.price)}
        </span>
        <span className={`live-price-change ${tone(stock.tickChange)}`}>{formatSignedCents(stock.tickChange)} last tick</span>
      </div>
      <form onSubmit={submit}>
        <fieldset disabled={disabled} className="order-fields">
          <div className="segmented" role="group" aria-label="Order side">
            <button type="button" className={side === 'BUY' ? 'seg active buy' : 'seg'} onClick={() => setSide('BUY')}>
              Buy
            </button>
            <button type="button" className={side === 'SELL' ? 'seg active sell' : 'seg'} onClick={() => setSide('SELL')}>
              Sell
            </button>
          </div>

          <label className="qty-label" htmlFor="live-qty">
            Shares of {stock.ticker}
          </label>
          <div className="qty-row">
            <input
              id="live-qty"
              className="qty-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="0"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
            <button type="button" className="btn btn-small" onClick={() => setQty(String(limit))}>
              Max
            </button>
          </div>
          <p className="estimate">
            {side === 'BUY' ? 'Cost at the current price' : 'Proceeds at the current price'}:{' '}
            <strong>{total === null ? '—' : formatCents(total)}</strong>
          </p>
          <p className="estimate">
            {side === 'BUY' ? 'You can buy up to' : 'You can sell up to'}:{' '}
            <strong>
              {limit} share{limit === 1 ? '' : 's'}
            </strong>
            {` (${formatCents(limit * stock.price)})`}
          </p>
          {problem && (
            <p className="notice error" role="alert">
              {problem}
            </p>
          )}
          <button type="submit" className={`btn btn-wide ${side === 'BUY' ? 'btn-buy' : 'btn-sell'}`}>
            {side === 'BUY' ? 'Buy' : 'Sell'} now at market price
          </button>
          <p className="hint">
            Orders fill immediately, at the price at the moment you press the button. The market moves one tick at a time, so
            the price can change just before you click; the trade list shows the exact fill price and tick.
          </p>
        </fieldset>
      </form>
    </section>
  );
}
