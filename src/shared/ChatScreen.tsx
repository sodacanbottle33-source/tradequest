// The chat room: one room for every signed-in player. The server decides what a message may be, who may write, how fast and what is removed;
// this screen shows the messages it sends (as plain text, never as markup) and asks it to send, report or (for the owner) moderate.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import { AuthPanel } from './AuthPanel';
import { Avatar, OnlineDot, useOnlineWatch } from './Avatar';
import { newRequestId } from './adminUtil';
import { MessagePicture, PictureButton, PicturePreview, usePicturePick } from './ChatPicture';
import { MUTE_CHOICES, lengthOf, timeLabel, waitWords } from './chatUtil';
import { problemText } from './playersUtil';
import { RoleBadge } from './RoleBadge';
import { sharedStore, useShared } from './store';
import type { ChatMessage } from './types';

function Line({ message, mine, isOwner, isStaff, reported, onReport, onNote }: { message: ChatMessage; mine: boolean; isOwner: boolean; isStaff: boolean; reported: boolean; onReport: (id: number) => void; onNote: (text: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moderating, setModerating] = useState(false);
  const [busy, setBusy] = useState(false);
  // Staff do not report ordinary players (they act on them), but a moderator can report another moderator's message: only the owner can act on that.
  const canReport = !mine && message.role !== 'owner' && (!isStaff || (!isOwner && message.role === 'moderator'));
  // A moderator can moderate ordinary players only; the owner can moderate everybody.
  const canModerate = isStaff && !mine && (isOwner || message.role === 'player');
  const moderate = async (what: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      onNote(what);
      setModerating(false);
    } catch (e) {
      onNote(problemText(e));
    } finally {
      setBusy(false);
    }
  };
  const who = message.displayName;
  return (
    <li className={mine ? 'chat-msg mine' : 'chat-msg'} data-testid="chat-message" data-id={message.id} data-username={message.username}>
      <div className="chat-meta">
        <span className="pfp-wrap">
          <Avatar username={message.username} displayName={who} size={22} />
          <OnlineDot username={message.username} />
        </span>
        <strong>{who}</strong>
        <RoleBadge role={message.role} />
        <span className="muted">{timeLabel(message.createdMs)}</span>
        <span className="chat-tools">
          {!mine && (
            <button type="button" className="link-btn" onClick={() => sharedStore.startCompose(message.username)} data-testid={`message-${message.id}`}>
              Message
            </button>
          )}
          {canReport && !reported && !asking && (
            <button type="button" className="link-btn" onClick={() => setAsking(true)} data-testid={`report-${message.id}`}>
              Report
            </button>
          )}
          {canReport && asking && (
            <>
              <span className="muted">Report this message?</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setAsking(false);
                  onReport(message.id);
                }}
                data-testid={`report-yes-${message.id}`}
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
            <button type="button" className="link-btn" onClick={() => setModerating((m) => !m)} aria-expanded={moderating} data-testid={`moderate-${message.id}`}>
              {moderating ? 'Close' : 'Moderate'}
            </button>
          )}
          {isOwner && mine && (
            <button type="button" className="link-btn" disabled={busy} onClick={() => void moderate('Message deleted.', () => api.adminChatDelete({ requestId: newRequestId(), messageId: message.id }))} data-testid={`delete-${message.id}`}>
              Delete
            </button>
          )}
          {!isOwner && mine && !deleting && (
            <button type="button" className="link-btn" disabled={busy} onClick={() => setDeleting(true)} data-testid={`delete-own-${message.id}`}>
              Delete
            </button>
          )}
          {!isOwner && mine && deleting && (
            <>
              <span className="muted">Delete this message?</span>
              <button
                type="button"
                className="link-btn"
                disabled={busy}
                onClick={() => {
                  setDeleting(false);
                  void moderate('Message deleted.', () => api.chatDelete(message.id));
                }}
                data-testid={`delete-own-yes-${message.id}`}
              >
                Yes
              </button>
              <button type="button" className="link-btn" onClick={() => setDeleting(false)}>
                No
              </button>
            </>
          )}
        </span>
      </div>
      {message.text !== '' && <p className="chat-text">{message.text}</p>}
      {message.picture !== null && <MessagePicture kind="chat" messageId={message.id} state={message.picture} />}
      {canModerate && moderating && (
        <div className="chat-mod" role="group" aria-label={`Moderate ${who}`}>
          <button type="button" className="btn btn-small btn-sell" disabled={busy} onClick={() => void moderate('Message deleted.', () => api.adminChatDelete({ requestId: newRequestId(), messageId: message.id }))} data-testid={`mod-delete-${message.id}`}>
            Delete message
          </button>
          {MUTE_CHOICES.map((c) => (
            <button
              key={c.minutes}
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => void moderate(`${who} is muted for ${c.label}.`, () => api.adminChatMute({ requestId: newRequestId(), username: message.username, minutes: c.minutes }))}
              data-testid={`mod-mute-${c.minutes}-${message.id}`}
            >
              Mute {c.label}
            </button>
          ))}
          {isOwner && (
            <button type="button" className="btn btn-small btn-sell" disabled={busy} onClick={() => void moderate(`${who} is banned from the chat.`, () => api.adminChatBan({ requestId: newRequestId(), username: message.username }))} data-testid={`mod-ban-${message.id}`}>
              Ban from chat
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function ChatScreen() {
  const { user, chat, tickMs } = useShared();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reported, setReported] = useState<ReadonlySet<number>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const pic = usePicturePick();
  const log = useRef<HTMLUListElement | null>(null);
  useOnlineWatch();
  const stick = useRef(true);
  const asked = useRef<number | null>(null);

  // While this screen is open, new messages count as read.
  useEffect(() => {
    sharedStore.setChatViewing(true);
    return () => sharedStore.setChatViewing(false);
  }, []);

  // Stay at the newest message, unless the reader scrolled up to read older ones.
  const count = chat?.messages.length ?? 0;
  const newest = chat?.messages.at(-1)?.id ?? 0;
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [count, newest]);

  // When the time of a wait (a new account's, a mute) has passed on the server's clock, ask whether writing is open now.
  const until = chat && !chat.you.canWrite ? chat.you.untilMs : null;
  useEffect(() => {
    if (until !== null && tickMs > 0 && tickMs >= until && asked.current !== until) {
      asked.current = until;
      void sharedStore.refreshChat();
    }
  }, [until, tickMs]);

  const report = useCallback(async (id: number) => {
    setReported((old) => new Set(old).add(id));
    try {
      await api.chatReport(id);
      setNote('Thank you. The owner and the moderators will look at that message.');
    } catch (e) {
      setReported((old) => {
        const next = new Set(old);
        next.delete(id);
        return next;
      });
      setNote(problemText(e));
    }
  }, []);

  if (!user) return <AuthPanel />;
  const isOwner = user.role === 'owner';
  const isStaff = isOwner || user.role === 'moderator';
  if (!chat) {
    return (
      <section className="card" aria-label="Chat">
        <p className="hint">Loading the chat…</p>
      </section>
    );
  }
  const you = chat.you;
  const length = lengthOf(text.trim());
  const wait = until !== null && tickMs > 0 ? waitWords(Math.max(0, until - tickMs)) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const typed = text.trim();
    if ((typed === '' && !pic.picture) || sending) return;
    setSending(true);
    setError(null);
    try {
      const out = await api.chatSend(typed, pic.picture ?? undefined);
      sharedStore.noteSent(out.message, out.you);
      setText('');
      pic.clear();
      stick.current = true;
    } catch (e) {
      setError(problemText(e));
      void sharedStore.refreshChat();
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (event: FormEvent): void => void submit(event);
  const onScroll = (): void => {
    const el = log.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const earlier = async () => {
    setLoadingMore(true);
    try {
      await sharedStore.loadEarlierChat();
    } catch (e) {
      setError(problemText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section className="card chat-card" aria-label="Chat room" data-testid="chat-room">
      <h2>
        Chat room <span className="h2-note">everybody who is signed in</span>
      </h2>
      {chat.more && (
        <button type="button" className="btn btn-small btn-ghost" disabled={loadingMore} onClick={() => void earlier()} data-testid="chat-earlier">
          {loadingMore ? 'Loading…' : 'Show earlier messages'}
        </button>
      )}
      <ul
        className="chat-log"
        ref={log}
        role="log"
        aria-live="polite"
        aria-label="Messages"
        data-testid="chat-log"
        onScroll={onScroll}
      >
        {chat.messages.length === 0 && <li className="hint">Nobody has written yet. Say hello!</li>}
        {chat.messages.map((m) => (
          <Line key={m.id} message={m} mine={m.username === user.username} isOwner={isOwner} isStaff={isStaff} reported={reported.has(m.id)} onReport={(id) => void report(id)} onNote={setNote} />
        ))}
      </ul>
      {note && (
        <p className="notice info" role="status" data-testid="chat-note">
          {note}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert" data-testid="chat-error">
          {error}
        </p>
      )}
      {!you.canWrite && (
        <p className="notice warn" role="status" data-testid="chat-blocked">
          {you.reason === 'banned' ? you.message : wait ? `${you.reason === 'muted' ? 'You are muted' : 'New accounts wait a little before writing'}: you can write in ${wait}. Reading is open.` : (you.message ?? 'You cannot write right now.')}
        </p>
      )}
      <form className="chat-form" onSubmit={onSubmit}>
        <input
          className="qty-input chat-input"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={you.canWrite ? 'Write a message…' : 'You cannot write right now'}
          aria-label="Message"
          disabled={!you.canWrite}
          autoComplete="off"
          data-testid="chat-input"
        />
        <span className={length > chat.limits.maxLength ? 'chat-count over' : 'chat-count'} aria-live="off" data-testid="chat-count">
          {length}/{chat.limits.maxLength}
        </span>
        {chat.limits.picturesOn && <PictureButton pick={pic} disabled={!you.canWrite || sending} testId="chat-picture" />}
        <button type="submit" className="btn btn-primary" disabled={!you.canWrite || sending || (length === 0 && !pic.picture) || length > chat.limits.maxLength} data-testid="chat-send">
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
      <PicturePreview pick={pic} testId="chat-picture-preview" />
      <p className="hint">
        Be kind. Messages are plain text, and you can add one small picture. {chat.limits.picturesOn ? 'Pictures are kept for 7 days, and a new account waits an hour before it can send one here. ' : 'The owner has switched pictures off for now. '}Spam is slowed down: at most one message every {Math.round(chat.limits.minGapMs / 100) / 10} seconds, and you cannot repeat yourself. Press Report on a message that breaks the rules; the owner
        and the moderators can remove messages and stop players from writing.
      </p>
    </section>
  );
}
