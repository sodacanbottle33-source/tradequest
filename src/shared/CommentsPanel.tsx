// The comments of one company, shown under its chart (docs/world.md §40). The server decides what a comment may be, who may write, how fast, and what is removed;
// this panel shows what the server sends (as plain text, never as markup) and asks it to write, answer, like, report, delete or (for the owner and the moderators) moderate.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import { newRequestId } from './adminUtil';
import { Avatar } from './Avatar';
import { MUTE_CHOICES, lengthOf } from './chatUtil';
import { agoText, answersText, canLikeComment, canModerateComment, canReportComment, COMMENT_REFRESH_MS, commentsText, joinPages, withLike, type Viewer } from './commentsUtil';
import { PlayerName } from './PlayerName';
import { problemText } from './playersUtil';
import { RoleBadge } from './RoleBadge';
import { useShared } from './store';
import type { CommentItem, CommentLine, CommentsView } from './types';

interface RowProps {
  line: CommentLine;
  viewer: Viewer;
  canWrite: boolean;
  nowMs: number;
  answer?: boolean;
  reported: boolean;
  onReply: (line: CommentLine) => void;
  onReport: (id: number) => void;
  onLiked: (id: number, liked: boolean, likes: number) => void;
  /** Something changed on the server (a comment was deleted, a player muted): say so and read the list again. */
  onChanged: (note: string) => void;
  onProblem: (text: string) => void;
}

function Row({ line, viewer, canWrite, nowMs, answer = false, reported, onReply, onReport, onLiked, onChanged, onProblem }: RowProps) {
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moderating, setModerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const isOwner = viewer.role === 'owner';
  const canReport = canReportComment(line, viewer);
  const canModerate = canModerateComment(line, viewer);
  const canLike = canLikeComment(line, viewer);
  const who = line.displayName;
  const act = async (done: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      setModerating(false);
      setDeleting(false);
      onChanged(done);
    } catch (e) {
      onProblem(problemText(e));
    } finally {
      setBusy(false);
    }
  };
  const like = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.commentLike(line.id);
      onLiked(line.id, r.liked, r.likes);
    } catch (e) {
      onProblem(problemText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={['comment', answer ? 'comment-answer' : '', line.mine ? 'mine' : ''].filter(Boolean).join(' ')} data-testid={`comment-${line.id}`} data-username={line.username}>
      <div className="comment-meta">
        <span className="pfp-wrap">
          <Avatar username={line.username} displayName={who} size={answer ? 18 : 22} />
        </span>
        <PlayerName username={line.username} name={who} />
        <RoleBadge role={line.role} />
        <span className="muted">{agoText(nowMs, line.createdMs)}</span>
      </div>
      <p className="comment-text" data-testid={`comment-text-${line.id}`}>
        {line.text}
      </p>
      <div className="comment-tools">
        {canLike ? (
          <button type="button" className={line.liked ? 'link-btn comment-like liked' : 'link-btn comment-like'} disabled={busy} aria-pressed={line.liked} onClick={() => void like()} data-testid={`comment-like-${line.id}`}>
            {line.liked ? '♥ Liked' : '♡ Like'}
            {line.likes > 0 ? ` · ${line.likes}` : ''}
          </button>
        ) : (
          line.likes > 0 && (
            <span className="muted" data-testid={`comment-likes-${line.id}`}>
              ♥ {line.likes}
            </span>
          )
        )}
        {canWrite && (
          <button type="button" className="link-btn" onClick={() => onReply(line)} data-testid={`comment-reply-${line.id}`}>
            Reply
          </button>
        )}
        {canReport && !reported && !asking && (
          <button type="button" className="link-btn" onClick={() => setAsking(true)} data-testid={`comment-report-${line.id}`}>
            Report
          </button>
        )}
        {canReport && asking && (
          <>
            <span className="muted">Report this comment?</span>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setAsking(false);
                onReport(line.id);
              }}
              data-testid={`comment-report-yes-${line.id}`}
            >
              Yes
            </button>
            <button type="button" className="link-btn" onClick={() => setAsking(false)}>
              No
            </button>
          </>
        )}
        {canReport && reported && <span className="muted">Reported</span>}
        {canModerate && (
          <button type="button" className="link-btn" onClick={() => setModerating((m) => !m)} aria-expanded={moderating} data-testid={`comment-moderate-${line.id}`}>
            {moderating ? 'Close' : 'Moderate'}
          </button>
        )}
        {line.mine && !deleting && (
          <button type="button" className="link-btn" disabled={busy} onClick={() => setDeleting(true)} data-testid={`comment-delete-${line.id}`}>
            Delete
          </button>
        )}
        {line.mine && deleting && (
          <>
            <span className="muted">Delete this comment?</span>
            <button type="button" className="link-btn" disabled={busy} onClick={() => void act('Comment deleted.', () => api.commentDelete(line.id))} data-testid={`comment-delete-yes-${line.id}`}>
              Yes
            </button>
            <button type="button" className="link-btn" onClick={() => setDeleting(false)}>
              No
            </button>
          </>
        )}
      </div>
      {canModerate && moderating && (
        <div className="comment-mod" role="group" aria-label={`Moderate ${who}`}>
          <button type="button" className="btn btn-small btn-sell" disabled={busy} onClick={() => void act('Comment deleted.', () => api.adminCommentDelete({ requestId: newRequestId(), commentId: line.id }))} data-testid={`comment-mod-delete-${line.id}`}>
            Delete comment
          </button>
          {MUTE_CHOICES.map((c) => (
            <button
              key={c.minutes}
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => void act(`${who} is muted for ${c.label}. That also stops comments.`, () => api.adminChatMute({ requestId: newRequestId(), username: line.username, minutes: c.minutes }))}
              data-testid={`comment-mod-mute-${c.minutes}-${line.id}`}
            >
              Mute {c.label}
            </button>
          ))}
          {isOwner && (
            <button type="button" className="btn btn-small btn-sell" disabled={busy} onClick={() => void act(`${who} is banned from the chat and from comments.`, () => api.adminChatBan({ requestId: newRequestId(), username: line.username }))} data-testid={`comment-mod-ban-${line.id}`}>
              Ban from chat
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Walks every comment and answer and changes the one with this id. */
function patchLine(items: readonly CommentItem[], id: number, change: (line: CommentLine) => CommentLine): CommentItem[] {
  return items.map((c) => ({
    ...c,
    ...(c.id === id ? change(c) : {}),
    replies: c.replies.map((r) => (r.id === id ? change(r) : r)),
  }));
}

export function CommentsPanel({ ticker }: { ticker: string }) {
  const { user, tickMs } = useShared();
  const [view, setView] = useState<CommentsView | null>(null);
  const [older, setOlder] = useState<CommentItem[]>([]);
  const [moreOlder, setMoreOlder] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reported, setReported] = useState<ReadonlySet<number>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [replyTo, setReplyTo] = useState<{ id: number; topId: number; name: string } | null>(null);
  const [replyText, setReplyText] = useState('');
  const current = useRef(ticker);
  current.current = ticker;
  const asked = useRef<number | null>(null);
  const olderCount = useRef(0);
  olderCount.current = older.length;

  /** Reads the newest page again. `reset` also forgets the older pages the reader opened (the newest page may have moved on past them). */
  const load = useCallback(async (reset = true) => {
    try {
      const v = await api.comments(ticker);
      if (current.current !== ticker) return;
      setView(v);
      if (reset) {
        setOlder([]);
        setMoreOlder(null);
      }
      setLoadError(null);
    } catch (e) {
      if (current.current === ticker) setLoadError(problemText(e));
    }
  }, [ticker]);

  // A new company, or signing in or out: start again. Then look for new comments now and then while the page is in front.
  const userName = user?.username ?? '';
  useEffect(() => {
    setView(null);
    setOlder([]);
    setMoreOlder(null);
    setText('');
    setReplyTo(null);
    setReplyText('');
    setError(null);
    setNote(null);
    void load();
    // While the reader has opened older pages, the list stays as it is (new comments come with the Refresh button).
    const id = setInterval(() => {
      if (olderCount.current === 0 && (typeof document === 'undefined' || document.visibilityState === 'visible')) void load();
    }, COMMENT_REFRESH_MS);
    return () => clearInterval(id);
  }, [load, userName]);

  // When the time of a mute has passed on the server's clock, ask whether writing is open now.
  const until = view && !view.you.canWrite ? view.you.untilMs : null;
  useEffect(() => {
    if (until !== null && tickMs > 0 && tickMs >= until && asked.current !== until) {
      asked.current = until;
      void load();
    }
  }, [until, tickMs, load]);

  const viewer: Viewer = { signedIn: user !== null, role: user?.role ?? 'player' };
  const nowMs = tickMs > 0 ? tickMs : new Date().getTime();
  const items = view ? joinPages(view.comments, older) : [];
  const hasMore = older.length > 0 ? moreOlder === true : view?.more === true;

  const changed = useCallback(
    (done: string) => {
      setNote(done);
      setError(null);
      void load();
    },
    [load],
  );
  const problem = useCallback((message: string) => {
    setNote(null);
    setError(message);
  }, []);
  const liked = useCallback((id: number, isLiked: boolean, likes: number) => {
    const change = (l: CommentLine) => withLike(l, isLiked, likes);
    setView((v) => (v ? { ...v, comments: patchLine(v.comments, id, change) } : v));
    setOlder((o) => patchLine(o, id, change));
  }, []);
  const report = useCallback(async (id: number) => {
    setReported((old) => new Set(old).add(id));
    try {
      await api.commentReport(id);
      setError(null);
      setNote('Thank you. The owner and the moderators will look at that comment.');
    } catch (e) {
      setReported((old) => {
        const next = new Set(old);
        next.delete(id);
        return next;
      });
      problem(problemText(e));
    }
  }, [problem]);

  const send = async (body: string, parentId: number | undefined, done: () => void) => {
    if (sending) return;
    setSending(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.commentPost(ticker, body, parentId);
      setView((v) => (v ? { ...v, you: r.you } : v));
      done();
      await load();
    } catch (e) {
      problem(problemText(e));
    } finally {
      setSending(false);
    }
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send(text.trim(), undefined, () => setText(''));
  };
  const onReplySubmit = (event: FormEvent) => {
    event.preventDefault();
    if (replyTo === null) return;
    void send(replyText.trim(), replyTo.id, () => {
      setReplyText('');
      setReplyTo(null);
    });
  };
  const earlier = async () => {
    const last = items[items.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.comments(ticker, last.id);
      setOlder((o) => joinPages(o, page.comments).filter((c) => !view || !view.comments.some((f) => f.id === c.id)));
      setMoreOlder(page.more);
    } catch (e) {
      problem(problemText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const you = view?.you ?? null;
  const maxLength = view?.limits.maxLength ?? 300;
  const length = lengthOf(text);
  const replyLength = lengthOf(replyText);
  return (
    <section className="card comments-card" aria-label={`${ticker} comments`} data-testid="comments-panel">
      <div className="comments-head">
        <h2>
          Comments <span className="h2-note">{view ? commentsText(view.total) : ''}</span>
        </h2>
        <button type="button" className="btn btn-small btn-ghost" onClick={() => void load()} data-testid="comments-refresh">
          Refresh
        </button>
      </div>
      {loadError && (
        <p className="notice error" role="alert" data-testid="comments-load-error">
          Could not load the comments: {loadError}
        </p>
      )}
      {view === null && !loadError && <p className="hint">Loading the comments…</p>}
      {view !== null && (
        <form className="comment-form" onSubmit={onSubmit}>
          <input
            className="qty-input comment-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={you?.canWrite ? `Write a comment about ${ticker}…` : 'Sign in to write a comment'}
            aria-label={`Write a comment about ${ticker}`}
            disabled={!you?.canWrite || sending}
            autoComplete="off"
            data-testid="comment-input"
          />
          <span className={length > maxLength ? 'comment-count over' : 'comment-count'} aria-live="off" data-testid="comment-count">
            {length}/{maxLength}
          </span>
          <button type="submit" className="btn btn-primary" disabled={!you?.canWrite || sending || length === 0 || length > maxLength} data-testid="comment-send">
            Post
          </button>
        </form>
      )}
      {you && !you.canWrite && you.message && (
        <p className="notice warn" role="status" data-testid="comments-blocked">
          {you.message}
        </p>
      )}
      {note && (
        <p className="notice info" role="status" data-testid="comments-note">
          {note}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert" data-testid="comments-error">
          {error}
        </p>
      )}
      {view !== null && items.length === 0 && (
        <p className="hint" data-testid="comments-empty">
          No comments on {ticker} yet.{you?.canWrite ? ' Be the first to write one!' : ''}
        </p>
      )}
      {items.length > 0 && (
        <ul className="comment-list" data-testid="comment-list">
          {items.map((c) => (
            <li key={c.id} className="comment-thread" data-testid="comment-thread" data-id={c.id}>
              <Row
                line={c}
                viewer={viewer}
                canWrite={you?.canWrite === true}
                nowMs={nowMs}
                reported={reported.has(c.id)}
                onReply={(l) => setReplyTo({ id: l.id, topId: c.id, name: l.displayName })}
                onReport={(id) => void report(id)}
                onLiked={liked}
                onChanged={changed}
                onProblem={problem}
              />
              {c.replies.length > 0 && (
                <>
                  <p className="comment-answers-count muted">{answersText(c.replies.length)}</p>
                  <ul className="comment-replies">
                    {c.replies.map((r) => (
                      <li key={r.id}>
                        <Row
                          line={r}
                          viewer={viewer}
                          canWrite={you?.canWrite === true}
                          nowMs={nowMs}
                          answer
                          reported={reported.has(r.id)}
                          onReply={(l) => setReplyTo({ id: l.id, topId: c.id, name: l.displayName })}
                          onReport={(id) => void report(id)}
                          onLiked={liked}
                          onChanged={changed}
                          onProblem={problem}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {replyTo !== null && replyTo.topId === c.id && (
                <form className="comment-reply-form" onSubmit={onReplySubmit}>
                  <span className="muted comment-reply-to">Answering {replyTo.name}</span>
                  <input
                    className="qty-input comment-input"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Write your answer…"
                    aria-label={`Answer ${replyTo.name}`}
                    disabled={sending}
                    autoComplete="off"
                    autoFocus
                    data-testid={`reply-input-${c.id}`}
                  />
                  <span className={replyLength > maxLength ? 'comment-count over' : 'comment-count'}>
                    {replyLength}/{maxLength}
                  </span>
                  <button type="submit" className="btn btn-primary btn-small" disabled={sending || replyLength === 0 || replyLength > maxLength} data-testid={`reply-send-${c.id}`}>
                    Answer
                  </button>
                  <button type="button" className="btn btn-small btn-ghost" onClick={() => setReplyTo(null)}>
                    Cancel
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <p className="more-row">
          <button type="button" className="btn btn-small" disabled={loadingMore} onClick={() => void earlier()} data-testid="comments-more">
            {loadingMore ? 'Loading…' : 'Show older comments'}
          </button>
        </p>
      )}
      <p className="hint">
        Comments are public and have no effect on prices. {view ? `One comment every ${Math.round(view.limits.gapMs / 1000)} seconds, at most ${maxLength} characters.` : ''} Press Report on a comment that breaks the rules; the owner and the moderators can delete comments and mute players.
      </p>
    </section>
  );
}
