// One private conversation: its messages, the box to write in, and the few things a player can do about it (block, report, leave, and for the
// creator of a group invite, remove and rename). The server decides who may write, how fast and what is hidden; this only asks and shows its answers.
// Every message is shown as plain text, never as markup.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from './api';
import { Avatar, OnlineDot, useOnlineWatch } from './Avatar';
import { CallButton } from './CallBar';
import { lengthOf, timeLabel, waitWords } from './chatUtil';
import { friendsToInvite, membersLine } from './messagesUtil';
import { problemText } from './playersUtil';
import { sharedStore, useShared } from './store';
import type { PmMessage, PmThreadPage } from './types';

type Thread = NonNullable<ReturnType<typeof useShared>['pmThread']>;

/** A button that asks "Sure?" before it does something hard to undo. */
function SureButton({ label, question, busy, onYes, testId, danger = false }: { label: string; question: string; busy: boolean; onYes: () => void; testId: string; danger?: boolean }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={danger ? 'btn btn-small btn-sell' : 'btn btn-small btn-ghost'} disabled={busy} onClick={() => setAsking(true)} data-testid={testId}>
        {label}
      </button>
    );
  }
  return (
    <span className="people-actions">
      <span className="muted">{question}</span>
      <button
        type="button"
        className="btn btn-small btn-sell"
        disabled={busy}
        onClick={() => {
          setAsking(false);
          onYes();
        }}
        data-testid={`${testId}-yes`}
      >
        Yes
      </button>
      <button type="button" className="btn btn-small btn-ghost" onClick={() => setAsking(false)}>
        No
      </button>
    </span>
  );
}

function Line({ message, mine, reported, onReport, onDelete }: { message: PmMessage; mine: boolean; reported: boolean; onReport: (id: number) => void; onDelete: (id: number) => void }) {
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canReport = !mine && message.role !== 'owner';
  return (
    <li className={mine ? 'chat-msg mine' : 'chat-msg'} data-testid="pm-message" data-id={message.id} data-username={message.username}>
      <div className="chat-meta">
        <span className="pfp-wrap">
          <Avatar username={message.username} displayName={message.displayName} size={22} />
          <OnlineDot username={message.username} />
        </span>
        <strong>{message.displayName}</strong>
        {message.role === 'owner' && <span className="badge-owner">Owner</span>}
        <span className="muted">{timeLabel(message.createdMs)}</span>
        <span className="chat-tools">
          {canReport && !reported && !asking && (
            <button type="button" className="link-btn" onClick={() => setAsking(true)} data-testid={`pm-report-${message.id}`}>
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
                data-testid={`pm-report-yes-${message.id}`}
              >
                Yes
              </button>
              <button type="button" className="link-btn" onClick={() => setAsking(false)}>
                No
              </button>
            </>
          )}
          {canReport && reported && <span className="muted">Reported</span>}
          {mine && !deleting && (
            <button type="button" className="link-btn" onClick={() => setDeleting(true)} data-testid={`pm-delete-${message.id}`}>
              Delete
            </button>
          )}
          {mine && deleting && (
            <>
              <span className="muted">Delete for everybody?</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setDeleting(false);
                  onDelete(message.id);
                }}
                data-testid={`pm-delete-yes-${message.id}`}
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
      <p className="chat-text">{message.text}</p>
    </li>
  );
}

export function PmThreadView({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const { user, messages, friends, tickMs } = useShared();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reported, setReported] = useState<ReadonlySet<number>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [inviting, setInviting] = useState('');
  const log = useRef<HTMLUListElement | null>(null);
  useOnlineWatch();
  const stick = useRef(true);
  const asked = useRef<number | null>(null);
  const conv = thread.conversation;

  // A different conversation starts with a clean box and the newest message in view.
  useEffect(() => {
    setText('');
    setError(null);
    setNote(null);
    setRenaming(null);
    setInviting('');
    stick.current = true;
  }, [thread.id]);

  const count = thread.messages.length;
  const newest = thread.messages.at(-1)?.id ?? 0;
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [count, newest, thread.id]);

  // When the time of a wait (a new account's) has passed on the server's clock, ask whether writing is open now.
  const until = messages && !messages.you.canWrite ? messages.you.untilMs : null;
  useEffect(() => {
    if (until !== null && tickMs > 0 && tickMs >= until && asked.current !== until) {
      asked.current = until;
      void sharedStore.refreshMessages();
    }
  }, [until, tickMs]);

  if (!user || !messages) return null;
  const me = user.username;
  const you = messages.you;
  const maxLength = messages.limits.maxLength;
  const length = lengthOf(text.trim());
  const isCreator = conv.kind === 'group' && conv.creator === me;
  const canWrite = conv.canWrite && you.canWrite;
  const wait = until !== null && tickMs > 0 ? waitWords(Math.max(0, until - tickMs)) : null;

  /** Runs one action: its words on success, the server's own words when it fails. */
  const run = async (done: string | null, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
    } catch (e) {
      setError(problemText(e));
      sharedStore.onPmChanged();
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const typed = text.trim();
    if (typed === '' || sending) return;
    setSending(true);
    setError(null);
    try {
      const out = await api.messagesSend({ conversationId: thread.id, text: typed });
      sharedStore.noteSentPrivate(out);
      setText('');
      stick.current = true;
    } catch (e) {
      setError(problemText(e));
      sharedStore.onPmChanged();
    } finally {
      setSending(false);
    }
  };
  const onSubmit = (event: FormEvent): void => void submit(event);
  const onScroll = (): void => {
    const el = log.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const report = async (id: number) => {
    setReported((old) => new Set(old).add(id));
    try {
      await api.messagesReport(id);
      setNote('Thank you. The owner will see that message and the few before it, and nothing else of this conversation.');
    } catch (e) {
      setReported((old) => {
        const next = new Set(old);
        next.delete(id);
        return next;
      });
      setError(problemText(e));
    }
  };

  const remove = async (id: number) => {
    try {
      await api.messagesDelete(id);
      sharedStore.removePrivateMessage(thread.id, id);
    } catch (e) {
      setError(problemText(e));
    }
  };

  const earlier = async () => {
    setLoadingMore(true);
    try {
      await sharedStore.loadEarlierThread();
    } catch (e) {
      setError(problemText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const answer = (what: 'accept' | 'decline') =>
    run(null, async () => {
      sharedStore.setMessages(await api.messagesRespond(conv.id, what));
      if (what === 'decline') onClose();
      else sharedStore.onPmChanged();
    });
  const block = (username: string) =>
    run(null, async () => {
      sharedStore.setMessages(await api.messagesBlock(username));
      void sharedStore.refreshFriends();
      onClose();
    });
  const leave = () =>
    run(null, async () => {
      sharedStore.setMessages(await api.groupLeave(conv.id));
      onClose();
    });
  const applyGroup = async (promise: Promise<{ conversation: PmThreadPage['conversation'] }>) => {
    await promise;
    sharedStore.onPmChanged();
  };

  const header: ReactNode =
    conv.kind === 'group' ? (
      <>
        <h2>
          {conv.title} <span className="h2-note">Group · {conv.members.length} {conv.members.length === 1 ? 'player' : 'players'}</span>
        </h2>
        <p className="pm-members" data-testid="pm-members">
          {membersLine(conv, me)}
          {conv.invited.length > 0 && <span className="muted"> · invited, no answer yet: {conv.invited.map((p) => p.displayName).join(', ')}</span>}
        </p>
      </>
    ) : (
      <h2>
        {conv.title} <span className="h2-note">{conv.friends ? 'Friend' : 'Not a friend'}</span>
      </h2>
    );

  const inviteChoices = isCreator && friends ? friendsToInvite(friends.friends, conv) : [];
  const roomLeft = messages.limits.maxGroupMembers - conv.members.length - conv.invited.length;

  return (
    <section className="card chat-card pm-thread" aria-label={`Conversation with ${conv.title}`} data-testid="pm-thread" data-conversation={conv.id}>
      <div className="pm-head">
        <button type="button" className="btn btn-small btn-ghost pm-back" onClick={onClose} data-testid="pm-back">
          ‹ Back
        </button>
        <div className="pm-head-main">{header}</div>
        <span className="people-actions">
          {conv.kind === 'direct' && conv.other && conv.friends && <CallButton username={conv.other.username} />}
          {conv.kind === 'direct' && conv.other && (
            <SureButton label="Block" question={`Block ${conv.other.displayName}?`} busy={busy} onYes={() => void block((conv.other as { username: string }).username)} testId="pm-block" />
          )}
          {conv.kind === 'direct' && conv.other && !conv.friends && (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() =>
                void run('Friend request sent.', async () => {
                  const out = await api.friendAction('request', (conv.other as { username: string }).username);
                  sharedStore.setFriends({ friends: out.friends, incoming: out.incoming, outgoing: out.outgoing, limits: out.limits });
                })
              }
              data-testid="pm-add-friend"
            >
              Add friend
            </button>
          )}
          {conv.kind === 'group' && <SureButton label="Leave group" question="Leave this group?" busy={busy} onYes={() => void leave()} testId="pm-leave" />}
        </span>
      </div>

      {conv.requestState === 'incoming' && (
        <div className="notice info pm-request-bar" role="status" data-testid="pm-request-bar">
          <span>{conv.note}</span>
          <span className="people-actions">
            <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void answer('accept')} data-testid="pm-accept">
              Accept
            </button>
            <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void answer('decline')} data-testid="pm-ignore">
              Ignore
            </button>
          </span>
        </div>
      )}

      {isCreator && (
        <div className="pm-admin" role="group" aria-label="Group settings" data-testid="pm-group-tools">
          {renaming === null ? (
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setRenaming(conv.title)} data-testid="pm-rename">
              Rename
            </button>
          ) : (
            <span className="people-actions">
              <input className="qty-input" type="text" value={renaming} maxLength={messages.limits.maxGroupTitle} onChange={(e) => setRenaming(e.target.value)} aria-label="Group name" data-testid="pm-rename-input" />
              <button
                type="button"
                className="btn btn-small"
                disabled={busy || renaming.trim() === ''}
                onClick={() =>
                  void run('Renamed.', async () => {
                    await applyGroup(api.groupRename(conv.id, renaming));
                    setRenaming(null);
                  })
                }
                data-testid="pm-rename-save"
              >
                Save
              </button>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </span>
          )}
          {roomLeft > 0 && inviteChoices.length > 0 && (
            <span className="people-actions">
              <select className="qty-input" value={inviting} onChange={(e) => setInviting(e.target.value)} aria-label="Invite a friend" data-testid="pm-invite-select">
                <option value="">Invite a friend…</option>
                {inviteChoices.map((f) => (
                  <option key={f.username} value={f.username}>
                    {f.displayName}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-small"
                disabled={busy || inviting === ''}
                onClick={() =>
                  void run('Invitation sent.', async () => {
                    await applyGroup(api.groupInvite(conv.id, inviting));
                    setInviting('');
                  })
                }
                data-testid="pm-invite"
              >
                Invite
              </button>
            </span>
          )}
          {[...conv.members.filter((p) => p.username !== me), ...conv.invited].map((p) => (
            <SureButton key={p.username} label={`Remove ${p.displayName}`} question={`Remove ${p.displayName}?`} busy={busy} onYes={() => void run(null, () => applyGroup(api.groupRemove(conv.id, p.username)))} testId={`pm-remove-${p.username}`} />
          ))}
        </div>
      )}

      {thread.more && (
        <button type="button" className="btn btn-small btn-ghost" disabled={loadingMore} onClick={() => void earlier()} data-testid="pm-earlier">
          {loadingMore ? 'Loading…' : 'Show earlier messages'}
        </button>
      )}
      <ul className="chat-log pm-log" ref={log} role="log" aria-live="polite" aria-label="Messages" data-testid="pm-log" onScroll={onScroll}>
        {thread.messages.length === 0 && <li className="hint">No messages yet.</li>}
        {thread.messages.map((m) => (
          <Line key={m.id} message={m} mine={m.username === me} reported={reported.has(m.id)} onReport={(id) => void report(id)} onDelete={(id) => void remove(id)} />
        ))}
      </ul>

      {note && (
        <p className="notice info" role="status" data-testid="pm-note">
          {note}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert" data-testid="pm-error">
          {error}
        </p>
      )}
      {!you.canWrite && (
        <p className="notice warn" role="status" data-testid="pm-new-account">
          {wait ? `New accounts wait a little before writing: you can write in ${wait}. Reading is open.` : (you.message ?? 'You cannot write right now.')}
        </p>
      )}
      {you.canWrite && conv.note && conv.requestState !== 'incoming' && (
        <p className={conv.canWrite ? 'hint' : 'notice warn'} role="status" data-testid="pm-conv-note">
          {conv.note}
        </p>
      )}
      <form className="chat-form" onSubmit={onSubmit}>
        <input
          className="qty-input chat-input"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={canWrite ? 'Write a message…' : 'You cannot write here right now'}
          aria-label="Message"
          disabled={!canWrite}
          autoComplete="off"
          data-testid="pm-input"
        />
        <span className={length > maxLength ? 'chat-count over' : 'chat-count'} aria-live="off" data-testid="pm-count">
          {length}/{maxLength}
        </span>
        <button type="submit" className="btn btn-primary" disabled={!canWrite || sending || length === 0 || length > maxLength} data-testid="pm-send">
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
      <p className="hint">
        Only the {conv.kind === 'group' ? 'players in this group' : 'two of you'} can read this. The owner cannot; he sees only a message you press Report on, and the few before it. Messages are plain text, and the same
        slow-down as in the chat room applies.
      </p>
    </section>
  );
}
