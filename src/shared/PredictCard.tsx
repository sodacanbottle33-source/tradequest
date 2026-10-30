// The daily prediction (docs/world.md §38): one featured stock a day, the same for everybody. Say once whether its price will be HIGHER or LOWER when the day ends (Tokyo time).
// A right guess pays the same as one daily goal; a wrong one costs nothing. The server picks the stock, keeps the price you saw, judges the guess and pays; this card only shows
// what the server says and asks it to keep a guess.
import { useState } from 'react';
import { api } from './api';
import { extrasStore, usePredict } from './extrasStore';
import { lastGuessText, pickName, recordText } from './extrasUtil';
import { formatCents } from './format';
import { rewardText } from './goalCatalog';
import { longUntil } from './goalUtil';
import { problemText } from './playersUtil';

export function PredictCard() {
  const { view, nowMs } = usePredict();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!view) {
    return (
      <section className="card predict-card" aria-label="Daily prediction" data-testid="predict-loading">
        <h3>Daily prediction</h3>
        <p className="muted">Loading…</p>
      </section>
    );
  }
  const choose = async (pick: 'up' | 'down') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      extrasStore.setPredict(await api.predictPick(pick));
    } catch (e) {
      setError(problemText(e));
      void extrasStore.loadPredict();
    } finally {
      setBusy(false);
    }
  };
  const c = view.company;
  return (
    <section className="card predict-card" aria-label="Daily prediction" data-testid="predict-card">
      <h3>
        Daily prediction <span className="h2-note">ends {longUntil(view.endMs, nowMs)}</span>
      </h3>
      {c === null || c.priceCents === null ? (
        <p className="muted" data-testid="predict-none">
          There is no stock to guess about right now. Look again in a little while.
        </p>
      ) : (
        <>
          <div className="predict-stock" data-testid="predict-stock">
            <strong className="predict-ticker">{c.ticker}</strong>
            <span className="predict-name muted">{c.name}</span>
            <span className="predict-price mono" data-testid="predict-price">
              {formatCents(c.priceCents)}
            </span>
          </div>
          {view.mine === null ? (
            <>
              <p className="hint">
                Will {c.ticker} end the day higher or lower than it is now? You can guess once. A right guess pays <strong>{rewardText(view.reward)}</strong>; a wrong guess costs nothing.
              </p>
              <div className="predict-buttons">
                <button type="button" className="btn btn-primary predict-up" disabled={busy} onClick={() => void choose('up')} data-testid="predict-up">
                  ▲ Higher
                </button>
                <button type="button" className="btn predict-down" disabled={busy} onClick={() => void choose('down')} data-testid="predict-down">
                  ▼ Lower
                </button>
              </div>
            </>
          ) : (
            <p className="predict-mine" data-testid="predict-mine">
              You said <strong>{pickName(view.mine.pick)}</strong> from {formatCents(view.mine.priceFromCents)}. It is judged when the day ends, {longUntil(view.endMs, nowMs)}.
            </p>
          )}
        </>
      )}
      {error && (
        <p className="notice error" role="alert" data-testid="predict-error">
          {error}
        </p>
      )}
      {view.last && (
        <p className={`predict-last is-${view.last.result}`} data-testid="predict-last">
          <strong>Your last guess:</strong> {lastGuessText(view.last)}
        </p>
      )}
      <p className="hint predict-record" data-testid="predict-record">
        {recordText(view.stats)}
      </p>
    </section>
  );
}
