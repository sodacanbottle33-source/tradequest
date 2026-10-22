import { useState, type FormEvent } from 'react';
import { formatCents, parseQuantity, type MarketView, type Side, type StockView } from '../engine';

interface Props {
  view: MarketView;
  /** The stock whose order is being entered. */
  stock: StockView;
  onSubmit: (ticker: string, side: Side, quantityText: string) => void;
  onCancel: (ticker: string) => void;
  onSelect: (ticker: string) => void;
  onNext: () => void;
  onFinish: () => void;
}

export function OrderPanel({ view, stock, onSubmit, onCancel, onSelect, onNext, onFinish }: Props) {
  const [side, setSide] = useState<Side>('BUY');
  const [qty, setQty] = useState('');
  const parsed = parseQuantity(qty);
  const estimate = parsed.ok ? parsed.value * stock.markPrice : null;
  const disabled = !view.canSubmit;
  const limit = side === 'BUY' ? stock.maxBuyQuantity : stock.maxSellQuantity;
  // Cash this stock's new buy may use: all cash minus what OTHER stocks' pending buys have set aside.
  const ownReserved = stock.pending?.side === 'BUY' ? stock.pendingEstimate : 0;
  const buyingPower = Math.max(0, view.account.cash - (view.account.reservedForPendingBuys - ownReserved));
  const otherReserved = view.account.reservedForPendingBuys - ownReserved;

  // Explain a problem BEFORE the player clicks (the engine still checks everything on submit).
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
      problem = `Not enough cash: 1 share of ${stock.ticker} costs about ${formatCents(stock.markPrice)}, but you have ${formatCents(buyingPower)} available.`;
    } else {
      problem = `Not enough cash: ${parsed.value} shares of ${stock.ticker} cost about ${formatCents(parsed.value * stock.markPrice)}. You can afford up to ${limit} (about ${formatCents(stock.maxBuyCost)}).`;
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(stock.ticker, side, qty);
  };
  const fillMax = () => setQty(String(limit));

  return (
    <section className="card order" aria-label="Order entry">
      <h2>
        Order · <span className="order-ticker">{stock.ticker}</span>
      </h2>
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

          <label className="qty-label" htmlFor="qty">
            Shares of {stock.ticker}
          </label>
          <div className="qty-row">
            <input
              id="qty"
              className="qty-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="0"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
            <button type="button" className="btn btn-small" onClick={fillMax}>
              Max
            </button>
          </div>
          <p className="estimate">
            {side === 'BUY' ? 'Est. cost at last close' : 'Est. proceeds at last close'}:{' '}
            <strong>{estimate === null ? '—' : formatCents(estimate)}</strong>
            <span className="hint">Fills at the next candle's open, so the final price can differ.</span>
          </p>
          <p className="estimate">
            {side === 'BUY' ? 'You can buy up to' : 'You can sell up to'}:{' '}
            <strong>
              {limit} share{limit === 1 ? '' : 's'}
            </strong>
            {side === 'BUY' ? ` (about ${formatCents(stock.maxBuyCost)})` : ` (about ${formatCents(limit * stock.markPrice)})`}
          </p>
          {side === 'BUY' && otherReserved > 0 && (
            <p className="hint">
              {formatCents(otherReserved)} of your cash is already set aside for pending buys of other stocks.
            </p>
          )}
          {problem && (
            <p className="notice error" role="alert">
              {problem}
            </p>
          )}
          {stock.pending && (
            <p className="hint">
              Placing another order for {stock.ticker} replaces your pending {stock.ticker} order — it does not add to it.
            </p>
          )}
          <button type="submit" className={`btn btn-wide ${side === 'BUY' ? 'btn-buy' : 'btn-sell'}`}>
            Place {side === 'BUY' ? 'buy' : 'sell'} order
          </button>
        </fieldset>
      </form>

      <div className="pending-list" aria-live="polite" aria-label="Pending orders">
        {view.pendingOrders.length === 0 ? (
          <span className="muted">No pending orders</span>
        ) : (
          view.pendingOrders.map((o) => {
            const s = view.stocks.find((x) => x.ticker === o.ticker);
            return (
              <div key={o.ticker} className={`pending ${o.ticker === stock.ticker ? 'is-selected' : ''}`}>
                <span>
                  <button type="button" className="link-btn" onClick={() => onSelect(o.ticker)}>
                    {o.ticker}
                  </button>{' '}
                  <strong>
                    {o.side} {o.quantity}
                  </strong>{' '}
                  — about {formatCents(s ? s.pendingEstimate : 0)} at the last close
                </span>
                <button type="button" className="btn btn-small btn-ghost" onClick={() => onCancel(o.ticker)}>
                  Cancel
                </button>
              </div>
            );
          })
        )}
      </div>

      {view.canFinish ? (
        <div className="final">
          <p>This is the final candle — no more orders. Finishing sells all your shares at each stock's closing price.</p>
          <button type="button" className="btn btn-wide btn-primary" onClick={onFinish}>
            Finish round
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-wide btn-primary" onClick={onNext} disabled={!view.canAdvance}>
          Next candle →
        </button>
      )}
    </section>
  );
}
