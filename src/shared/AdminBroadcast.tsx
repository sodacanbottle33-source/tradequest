// Owner tools that speak to everybody: an announcement banner at the top of every page, a "pause all trading" switch, and the button
// that starts Black Monday now (the game starts it by itself every October 19). The server keeps all three; this screen only sends
// requests and shows what the server says is set.
import { useState } from 'react';
import { ApiError, api } from './api';
import { newRequestId, whenText } from './adminUtil';
import type { AdminState } from './types';

const MAX = 200;
/** The word to type before Black Monday starts (the server checks it too). */
const BLACK_MONDAY_WORD = 'BLACK MONDAY';
type Message = { kind: 'ok' | 'error'; text: string } | null;

function problem(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error);
}

export function AdminBroadcast({ state, reload }: { state: AdminState | null; reload: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [confirmPause, setConfirmPause] = useState<string | null>(null); // the request id, once "Pause all trading" was pressed
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [word, setWord] = useState('');
  const [bmMessage, setBmMessage] = useState<Message>(null);

  const announcement = state?.announcement ?? null;
  const paused = state?.paused ?? null;

  const run = async (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ kind: 'ok', text: await fn() });
      await reload();
    } catch (error) {
      setMessage({ kind: 'error', text: problem(error) });
    } finally {
      setBusy(false);
    }
  };

  const post = () =>
    run(async () => {
      await api.adminAnnounce({ requestId: newRequestId(), text: text.trim() });
      setText('');
      return 'The announcement is showing on every page now.';
    });

  const takeDown = () =>
    run(async () => {
      await api.adminAnnounce({ requestId: newRequestId(), text: '' });
      return 'The announcement is gone.';
    });

  const pause = () =>
    run(async () => {
      if (confirmPause === null) throw new Error('Press "Pause all trading" first.');
      await api.adminPause({ requestId: confirmPause, paused: true, reason: reason.trim() || undefined });
      setConfirmPause(null);
      setReason('');
      return 'All trading is paused. Nobody can buy or sell until you open it again.';
    });

  const resume = () =>
    run(async () => {
      await api.adminPause({ requestId: newRequestId(), paused: false });
      return 'Trading is open again.';
    });

  const blackMonday = async () => {
    if (busy || word.trim().toUpperCase() !== BLACK_MONDAY_WORD) return;
    setBusy(true);
    setBmMessage(null);
    try {
      await api.adminBlackMonday({ requestId: newRequestId(), confirm: word.trim() });
      setWord('');
      setBmMessage({ kind: 'ok', text: 'Black Monday has started. The news story appears in a moment and prices begin to fall.' });
      await reload();
    } catch (error) {
      setBmMessage({ kind: 'error', text: problem(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="card" aria-label="Announcement">
        <h2>
          Announcement <span className="h2-note">a message at the top of every page</span>
        </h2>
        <p className="hint" data-testid="admin-announcement-now">
          {announcement ? `Showing now (since ${whenText(announcement.ms)}): “${announcement.text}”` : 'No announcement is showing.'}
        </p>
        <fieldset className="admin-fields" disabled={busy}>
          <label className="qty-label" htmlFor="adm-announce">
            Message ({text.length}/{MAX})
          </label>
          <input id="adm-announce" className="qty-input" type="text" maxLength={MAX} placeholder="For example: The market is being updated tonight" value={text} onChange={(e) => setText(e.target.value)} data-testid="admin-announce-text" />
          <div className="row-buttons">
            <button type="button" className="btn btn-primary" disabled={text.trim() === ''} onClick={() => void post()} data-testid="admin-announce-post">
              Post announcement
            </button>
            <button type="button" className="btn" disabled={announcement === null} onClick={() => void takeDown()} data-testid="admin-announce-clear">
              Take it down
            </button>
          </div>
        </fieldset>
      </section>

      <section className="card" aria-label="Pause all trading">
        <h2>
          Pause all trading <span className="h2-note">every company, Career and 1v1</span>
        </h2>
        {paused ? (
          <>
            <p className="notice warn" role="status" data-testid="admin-paused-now">
              Trading has been paused since {whenText(paused.sinceMs)}
              {paused.reason ? `: ${paused.reason}` : '.'}
            </p>
            <button type="button" className="btn btn-buy" disabled={busy} onClick={() => void resume()} data-testid="admin-pause-resume">
              Open trading again
            </button>
          </>
        ) : (
          <>
            <p className="hint">An emergency switch: nobody can buy or sell anything until you open trading again. Prices and news keep going. To stop only one company, use "Stop trading" under Move a price.</p>
            <fieldset className="admin-fields" disabled={busy || confirmPause !== null}>
              <label className="qty-label" htmlFor="adm-pause-reason">
                Reason (shown to players who try to trade)
              </label>
              <input id="adm-pause-reason" className="qty-input" type="text" maxLength={120} placeholder="For example: back in 10 minutes" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="admin-pause-reason" />
              <button type="button" className="btn btn-sell" onClick={() => setConfirmPause(newRequestId())} data-testid="admin-pause-start">
                Pause all trading…
              </button>
            </fieldset>
            {confirmPause !== null && (
              <div className="admin-confirm" data-testid="admin-pause-confirm-box">
                <p>
                  Really stop <strong>all</strong> trading for everybody{reason.trim() ? ` (“${reason.trim()}”)` : ''}?
                </p>
                <div className="row-buttons">
                  <button type="button" className="btn btn-sell" disabled={busy} onClick={() => void pause()} data-testid="admin-pause-confirm">
                    Yes, pause everything
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => setConfirmPause(null)} data-testid="admin-pause-cancel">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {message && (
          <p className={message.kind === 'ok' ? 'notice success' : 'notice error'} role="status" data-testid="admin-broadcast-message">
            {message.text}
          </p>
        )}
      </section>

      <section className="card" aria-label="Black Monday">
        <h2>
          Black Monday <span className="h2-note">every October 19, or start it now</span>
        </h2>
        <p className="hint" data-testid="admin-bm-hint">
          Every October 19 (Tokyo time) the whole market crashes at a surprise hour, like the real crash of 1987, and then takes about a week to recover. A normal stock falls about 20% in 6 hours;
          big safe stocks fall less, small risky ones and memecoins fall more. Players who borrowed money can be forced out. You can start it now to see it. It cannot be undone, and it cannot
          start while another Black Monday is still running.
        </p>
        <fieldset className="admin-fields" disabled={busy}>
          <label className="qty-label" htmlFor="adm-bm-word">
            Type {BLACK_MONDAY_WORD} to confirm
          </label>
          <input id="adm-bm-word" className="qty-input" type="text" autoComplete="off" value={word} onChange={(e) => setWord(e.target.value)} data-testid="admin-bm-word" />
          <button type="button" className="btn btn-sell" disabled={word.trim().toUpperCase() !== BLACK_MONDAY_WORD} onClick={() => void blackMonday()} data-testid="admin-bm-start">
            Start Black Monday now
          </button>
        </fieldset>
        {bmMessage && (
          <p className={bmMessage.kind === 'ok' ? 'notice success' : 'notice error'} role="status" data-testid="admin-bm-message">
            {bmMessage.text}
          </p>
        )}
      </section>
    </>
  );
}
