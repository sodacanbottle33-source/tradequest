// The "Chat" tab of the admin panel: the messages players reported, and everybody who is muted or banned from the chat. The owner can also
// moderate straight from the Chat screen (Moderate on a message). Every action is written once to the admin log.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { newRequestId, whenText } from './adminUtil';
import { MUTE_CHOICES } from './chatUtil';
import { problemText } from './playersUtil';
import type { AdminChatView } from './types';

export function AdminChat() {
  const [view, setView] = useState<AdminChatView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.adminChat());
    } catch (e) {
      setMessage({ kind: 'error', text: problemText(e) });
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  const run = async (done: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ kind: 'ok', text: done });
      await load();
    } catch (e) {
      setMessage({ kind: 'error', text: problemText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="players-layout" data-testid="admin-chat">
      {message && (
        <p className={message.kind === 'ok' ? 'notice success' : 'notice error'} role="status" data-testid="admin-chat-message">
          {message.text}
        </p>
      )}
      <section className="card" aria-label="Reported messages">
        <h2>
          Reported messages <span className="h2-note">{view ? view.reports.length : ''}</span>
        </h2>
        {view === null && <p className="hint">Loading…</p>}
        {view !== null && view.reports.length === 0 && (
          <p className="hint" data-testid="admin-chat-no-reports">
            Nobody has reported anything. You can also moderate straight from the Chat screen: press Moderate under a message.
          </p>
        )}
        {view !== null && view.reports.length > 0 && (
          <div className="table-wrap">
            <table className="trades" data-testid="admin-chat-reports">
              <thead>
                <tr>
                  <th>Message</th>
                  <th>Player</th>
                  <th className="num">Reports</th>
                  <th>What to do</th>
                </tr>
              </thead>
              <tbody>
                {view.reports.map((r) => (
                  <tr key={r.messageId} data-testid={`admin-chat-report-${r.messageId}`}>
                    <td className="chat-text">
                      {r.text}
                      <div className="muted">{whenText(r.createdMs)}</div>
                    </td>
                    <td>
                      {r.displayName}
                      {r.restriction && <span className="tag">{r.restriction === 'ban' ? 'Banned' : 'Muted'}</span>}
                    </td>
                    <td className="num">{r.reporters}</td>
                    <td>
                      <span className="people-actions">
                        <button type="button" className="btn btn-small btn-sell" disabled={busy} onClick={() => void run('Message deleted.', () => api.adminChatDelete({ requestId: newRequestId(), messageId: r.messageId }))} data-testid={`admin-chat-delete-${r.messageId}`}>
                          Delete
                        </button>
                        {MUTE_CHOICES.map((c) => (
                          <button
                            key={c.minutes}
                            type="button"
                            className="btn btn-small"
                            disabled={busy || r.restriction === 'ban'}
                            onClick={() => void run(`${r.displayName} is muted for ${c.label}.`, () => api.adminChatMute({ requestId: newRequestId(), username: r.username, minutes: c.minutes }))}
                            data-testid={`admin-chat-mute-${c.minutes}-${r.messageId}`}
                          >
                            Mute {c.label}
                          </button>
                        ))}
                        <button type="button" className="btn btn-small btn-sell" disabled={busy} onClick={() => void run(`${r.displayName} is banned from the chat.`, () => api.adminChatBan({ requestId: newRequestId(), username: r.username }))} data-testid={`admin-chat-ban-${r.messageId}`}>
                          Ban from chat
                        </button>
                        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void run('Report closed.', () => api.adminChatDismiss({ requestId: newRequestId(), messageId: r.messageId }))} data-testid={`admin-chat-dismiss-${r.messageId}`}>
                          Dismiss
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-label="Muted and banned">
        <h2>
          Muted and banned from the chat <span className="h2-note">{view ? view.restricted.length : ''}</span>
        </h2>
        {view !== null && view.restricted.length === 0 && <p className="hint">Nobody is muted or banned from the chat.</p>}
        {view !== null && view.restricted.length > 0 && (
          <div className="table-wrap">
            <table className="trades" data-testid="admin-chat-restricted">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>What</th>
                  <th>Until</th>
                  <th>Reason</th>
                  <th>By</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {view.restricted.map((x) => (
                  <tr key={x.username} data-testid={`admin-chat-restricted-${x.username}`}>
                    <td>{x.displayName}</td>
                    <td>{x.kind === 'ban' ? 'Banned' : 'Muted'}</td>
                    <td>{x.untilMs === null ? 'until you lift it' : whenText(x.untilMs)}</td>
                    <td>{x.reason || '—'}</td>
                    <td>{x.by}</td>
                    <td className="num">
                      <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(`${x.displayName} can write again.`, () => api.adminChatLift({ requestId: newRequestId(), username: x.username }))} data-testid={`admin-chat-lift-${x.username}`}>
                        Let them write again
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">Muting or banning someone from the chat never stops them from playing, trading or reading the chat. Spam is slowed down for everybody automatically.</p>
      </section>
    </div>
  );
}
