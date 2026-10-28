// The quote of the day: a small card at the top of the Market page with one motivation line, one trading tip, a Copy button and a
// "hide until tomorrow" button. It is the same for everybody on the same calendar day (src/shared/dailyQuote.ts) and needs no server.
import { useState } from 'react';
import { copyText, dailyPick, dayKey, dayNumberOf, hiddenToday, readHiddenDay, writeHiddenDay } from './dailyQuote';

/** Puts text on the clipboard. Returns false when the browser does not allow it (the player can still select the text by hand). */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the old way
  }
  try {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(box);
    return ok;
  } catch {
    return false;
  }
}

export function DailyQuoteCard() {
  const [today] = useState(() => new Date());
  const key = dayKey(today);
  const [hidden, setHidden] = useState(() => hiddenToday(readHiddenDay(), key));
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  if (hidden) return null;
  const { quote, tip } = dailyPick(dayNumberOf(today));

  const copy = (): void => {
    void copyToClipboard(copyText(quote, tip)).then((ok) => {
      setCopied(ok ? 'yes' : 'failed');
      window.setTimeout(() => setCopied('no'), 2000);
    });
  };
  const hide = (): void => {
    writeHiddenDay(key);
    setHidden(true);
  };

  return (
    <section className="card daily-quote" aria-label="Quote of the day" data-testid="daily-quote">
      <div className="dq-body">
        <p className="dq-label">Quote of the day</p>
        <blockquote className="dq-quote" data-testid="daily-quote-text">
          {quote}
        </blockquote>
        <p className="dq-tip" data-testid="daily-quote-tip">
          <strong>Tip of the day:</strong> {tip}
        </p>
      </div>
      <div className="dq-actions">
        <button type="button" className="btn btn-small" onClick={copy} data-testid="daily-quote-copy" aria-live="polite">
          {copied === 'yes' ? 'Copied!' : copied === 'failed' ? 'Press Ctrl+C' : 'Copy'}
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={hide} data-testid="daily-quote-hide" aria-label="Hide the quote until tomorrow" title="Hide until tomorrow">
          ✕
        </button>
      </div>
    </section>
  );
}
