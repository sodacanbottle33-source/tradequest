// Pop-ups that appear the moment the market closes one of the player's positions by itself: "You were liquidated", "Stop-loss hit",
// "Take-profit hit". They float over the page so they are seen wherever the player is looking, and go away by themselves.
import { sharedStore, useShared } from './store';

export function Toasts() {
  const { toasts } = useShared();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="region" aria-label="Position alerts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} role="alert" data-testid="toast" data-tone={t.tone}>
          <div className="toast-body">
            <strong className="toast-title">
              {t.title}: {t.ticker}
            </strong>
            <span className="toast-text">{t.text}</span>
          </div>
          <button type="button" className="btn btn-small btn-ghost" aria-label="Close this alert" onClick={() => sharedStore.dismissToast(t.id)}>
            Close
          </button>
        </div>
      ))}
    </div>
  );
}
