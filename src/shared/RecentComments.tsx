// "Recent comments": the newest comments and answers on every stock and memecoin, so a reader sees where people are talking. A line opens that company's page, where
// the comments are shown under the chart. The comments are the server's; they are shown as plain text. The owner (only) also sees a Delete button on every line: it asks
// once, then calls the same owner route as "Moderate -> Delete comment" under a chart; the server decides and writes the admin log, this list only reads again.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { newRequestId } from './adminUtil';
import { agoText, COMMENT_REFRESH_MS } from './commentsUtil';
import { PlayerName } from './PlayerName';
import { problemText } from './playersUtil';
import { RoleBadge } from './RoleBadge';
import { useShared } from './store';
import type { RecentComment } from './types';

const SHOWN = 12;

export function RecentComments({ onOpen }: { onOpen: (ticker: string) => void }) {
  const { user, tickMs } = useShared();
  const isOwner = user?.role === 'owner';
  const [items, setItems] = useState<RecentComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.recentComments(SHOWN);
      setItems(r.comments);
      setError(null);
    } catch (e) {
      setError(problemText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void load();
    }, COMMENT_REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const remove = async (id: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.adminCommentDelete({ requestId: newRequestId(), commentId: id });
      setNote({ kind: 'info', text: 'Comment deleted.' });
    } catch (e) {
      setNote({ kind: 'error', text: problemText(e) });
    } finally {
      setAsking(null);
      setBusy(false);
      await load(); // whatever happened (even "that comment is gone"), show what the server has now
    }
  };

  const nowMs = tickMs > 0 ? tickMs : new Date().getTime();
  return (
    <section className="card recent-comments" aria-label="Recent comments" data-testid="recent-comments">
      <h2>
        Recent comments <span className="h2-note">every stock and memecoin</span>
      </h2>
      {error && (
        <p className="notice error" role="alert" data-testid="recent-comments-error">
          Could not load the recent comments: {error}
        </p>
      )}
      {note && (
        <p className={`notice ${note.kind}`} role={note.kind === 'error' ? 'alert' : 'status'} data-testid="recent-comments-note">
          {note.text}
        </p>
      )}
      {items === null && !error && <p className="hint">Loading…</p>}
      {items !== null && items.length === 0 && (
        <p className="hint" data-testid="recent-comments-empty">
          Nobody has written a comment yet. Open any company and write the first one.
        </p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="recent-list" data-testid="recent-comments-list">
          {items.map((c) => (
            <li key={c.id} className="recent-item" data-testid={`recent-comment-${c.id}`}>
              <div className="recent-head">
                <button type="button" className="link-btn recent-open" onClick={() => onOpen(c.ticker)} title={`Open ${c.company}`} data-testid={`recent-open-${c.id}`}>
                  {c.ticker}
                </button>
                <span className="muted recent-company">{c.company}</span>
                <span className="muted">· {c.reply ? 'answer by' : ''}</span>
                <PlayerName username={c.username} name={c.displayName} />
                <RoleBadge role={c.role} />
                <span className="muted">{agoText(nowMs, c.createdMs)}</span>
                {c.likes > 0 && <span className="muted">· ♥ {c.likes}</span>}
                {isOwner && asking !== c.id && (
                  <button type="button" className="link-btn" disabled={busy} onClick={() => { setNote(null); setAsking(c.id); }} data-testid={`recent-delete-${c.id}`}>
                    Delete
                  </button>
                )}
                {isOwner && asking === c.id && (
                  <>
                    <span className="muted">Delete this comment?</span>
                    <button type="button" className="btn btn-small btn-sell" disabled={busy} onClick={() => void remove(c.id)} data-testid={`recent-delete-yes-${c.id}`}>
                      Yes, delete it
                    </button>
                    <button type="button" className="link-btn" disabled={busy} onClick={() => setAsking(null)} data-testid={`recent-delete-no-${c.id}`}>
                      No
                    </button>
                  </>
                )}
              </div>
              <p className="recent-text">{c.text}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
