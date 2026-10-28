// Private chats: talk to one player, or to a small group of friends, away from the public chat room. The server decides who may write to whom
// (friends at once, anybody else with a request that has to be accepted), what is hidden and what is refused; this screen lists the conversations
// and requests it sends, and asks it to write, answer, block or make a group. Everything a player wrote is shown as plain text.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import { AuthPanel } from './AuthPanel';
import { Avatar, OnlineDot, useOnlineWatch } from './Avatar';
import { PlayerName } from './PlayerName';
import { lengthOf } from './chatUtil';
import { lastLine, previewOf, requestTitle, whenLabel } from './messagesUtil';
import { PmThreadView } from './PmThreadView';
import { problemText } from './playersUtil';
import { sharedStore, useShared } from './store';
import type { PmRequest, PublicGroup } from './types';

type Panel = 'none' | 'new' | 'group' | 'public' | 'blocked';

// ---- writing to somebody new ---------------------------------------------------------------------------------------------------

function ComposeNew({ initialTo, onDone }: { initialTo: string; onDone: () => void }) {
  const { messages, friends } = useShared();
  const [to, setTo] = useState(initialTo);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!messages) return null;
  const you = messages.you;
  const target = to.trim().toLowerCase();
  const isFriend = (friends?.friends ?? []).some((f) => f.username === target);
  const length = lengthOf(text.trim());
  const max = messages.limits.maxLength;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending || target === '' || text.trim() === '') return;
    setSending(true);
    setError(null);
    try {
      const out = await api.messagesSend({ username: target, text: text.trim() });
      sharedStore.noteSentPrivate(out);
      sharedStore.clearCompose();
      onDone();
    } catch (e) {
      setError(problemText(e));
    } finally {
      setSending(false);
    }
  };
  const onSubmit = (event: FormEvent): void => void submit(event);

  return (
    <section className="card" aria-label="New message" data-testid="pm-new">
      <h2>New message</h2>
      <form className="pm-form" onSubmit={onSubmit}>
        <label className="qty-label" htmlFor="pm-new-to">
          To (a username)
        </label>
        <input id="pm-new-to" className="qty-input" type="text" value={to} onChange={(e) => setTo(e.target.value)} list="pm-friends" maxLength={40} autoComplete="off" disabled={!you.canWrite} data-testid="pm-new-to" />
        <datalist id="pm-friends">
          {(friends?.friends ?? []).map((f) => (
            <option key={f.username} value={f.username}>
              {f.displayName}
            </option>
          ))}
        </datalist>
        <label className="qty-label" htmlFor="pm-new-text">
          Message
        </label>
        <input id="pm-new-text" className="qty-input" type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a message…" autoComplete="off" disabled={!you.canWrite} data-testid="pm-new-text" />
        <span className={length > max ? 'chat-count over' : 'chat-count'}>
          {length}/{max}
        </span>
        <div className="people-actions">
          <button type="submit" className="btn btn-primary" disabled={!you.canWrite || sending || target === '' || length === 0 || length > max} data-testid="pm-new-send">
            {sending ? 'Sending…' : 'Send'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              sharedStore.clearCompose();
              onDone();
            }}
          >
            Cancel
          </button>
        </div>
      </form>
      {!you.canWrite && (
        <p className="notice warn" role="status">
          {you.message}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert" data-testid="pm-new-error">
          {error}
        </p>
      )}
      <p className="hint" data-testid="pm-new-hint">
        {isFriend
          ? 'You are friends, so your message is delivered at once.'
          : 'If you are not friends, your message is sent as a request: the other player can accept it or ignore it, and you can send one more message when they accept. Nobody is told if a request is ignored.'}
      </p>
    </section>
  );
}

// ---- a new group ---------------------------------------------------------------------------------------------------------------

function GroupMaker({ onDone }: { onDone: () => void }) {
  const { messages, friends } = useShared();
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!messages) return null;
  const limits = messages.limits;
  const list = friends?.friends ?? [];
  const most = limits.maxGroupMembers - 1;
  const isPublic = visibility === 'public';

  const toggle = (username: string) => setPicked((old) => (old.includes(username) ? old.filter((u) => u !== username) : old.length >= most ? old : [...old, username]));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || title.trim() === '' || (picked.length === 0 && !isPublic)) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.groupCreate(title.trim(), [...picked], visibility);
      void sharedStore.refreshMessages();
      onDone();
      void sharedStore.openConversation(out.conversation.id);
    } catch (e) {
      setError(problemText(e));
    } finally {
      setBusy(false);
    }
  };
  const onSubmit = (event: FormEvent): void => void submit(event);

  return (
    <section className="card" aria-label="New group" data-testid="pm-group-new">
      <h2>
        New group <span className="h2-note">up to {isPublic ? limits.maxPublicGroupMembers : limits.maxGroupMembers} players</span>
      </h2>
      {!messages.you.canWrite && (
        <p className="notice warn" role="status">
          {messages.you.message}
        </p>
      )}
      {list.length === 0 && !isPublic ? (
        <div>
          <p className="hint">A private group is made of your friends. You have none yet: add some from the Players tab first, or make a public group that anybody can join.</p>
          <button type="button" className="btn btn-small" onClick={() => setVisibility('public')} data-testid="pm-group-go-public">
            Make a public group instead
          </button>
        </div>
      ) : (
        <form className="pm-form" onSubmit={onSubmit}>
          <fieldset className="pm-pick pm-visibility-pick">
            <legend>Who can join</legend>
            <label className="pm-pick-row">
              <input type="radio" name="pm-group-visibility" checked={!isPublic} onChange={() => setVisibility('private')} data-testid="pm-group-private" />
              <span>
                <strong>Private</strong> <span className="muted">only friends you invite, up to {limits.maxGroupMembers} players</span>
              </span>
            </label>
            <label className="pm-pick-row">
              <input type="radio" name="pm-group-visibility" checked={isPublic} onChange={() => setVisibility('public')} data-testid="pm-group-public" />
              <span>
                <strong>Public</strong> <span className="muted">anybody can find it in Public groups and join, up to {limits.maxPublicGroupMembers} players</span>
              </span>
            </label>
          </fieldset>
          <label className="qty-label" htmlFor="pm-group-title">
            Group name
          </label>
          <input id="pm-group-title" className="qty-input" type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={limits.maxGroupTitle} autoComplete="off" data-testid="pm-group-title" />
          <fieldset className="pm-pick">
            <legend>
              Invite friends <span className="muted">({picked.length} of {most}{isPublic ? ', if you want' : ''})</span>
            </legend>
            {list.length === 0 && <span className="hint">You have no friends yet. A public group can start empty; players find it in Public groups.</span>}
            {list.map((f) => (
              <label key={f.username} className="pm-pick-row">
                <input type="checkbox" checked={picked.includes(f.username)} onChange={() => toggle(f.username)} disabled={!picked.includes(f.username) && picked.length >= most} data-testid={`pm-pick-${f.username}`} />
                <span>{f.displayName}</span>
              </label>
            ))}
          </fieldset>
          <div className="people-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !messages.you.canWrite || title.trim() === '' || (picked.length === 0 && !isPublic)} data-testid="pm-group-create">
              {busy ? 'Making…' : 'Make the group'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onDone}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="notice error" role="alert" data-testid="pm-group-error">
          {error}
        </p>
      )}
      <p className="hint">
        Each friend gets an invitation and sees the group only when they accept. A new member reads only what is said after they join. Every member can invite their own friends later with the Invite friends button; only you can remove people,
        rename the group or change who can join.
      </p>
    </section>
  );
}

// ---- public groups ------------------------------------------------------------------------------------------------------------

/** The groups anybody can join: a search box and a list, busiest first. */
function PublicGroupsPanel({ onDone, onOpen }: { onDone: () => void; onOpen: (id: number) => void }) {
  const { messages } = useShared();
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<readonly PublicGroup[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  // Ask for the list when the screen opens and a moment after each change of the search words.
  useEffect(() => {
    const ticket = (latest.current += 1);
    const timer = setTimeout(
      () => {
        api
          .publicGroups(query.trim())
          .then((out) => {
            if (latest.current === ticket) setGroups(out.groups);
          })
          .catch((e: unknown) => {
            if (latest.current === ticket) setError(problemText(e));
          });
      },
      query === '' ? 0 : 250,
    );
    return () => clearTimeout(timer);
  }, [query]);

  if (!messages) return null;
  const join = async (group: PublicGroup) => {
    if (busy !== null) return;
    setBusy(group.id);
    setError(null);
    try {
      const out = await api.groupJoin(group.id);
      void sharedStore.refreshMessages();
      onOpen(out.conversation.id);
    } catch (e) {
      setError(problemText(e));
      void api
        .publicGroups(query.trim())
        .then((fresh) => setGroups(fresh.groups))
        .catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card" aria-label="Public groups" data-testid="pm-public">
      <div className="row-between">
        <h2>
          Public groups <span className="h2-note">anybody can join</span>
        </h2>
        <button type="button" className="btn btn-small btn-ghost" onClick={onDone}>
          Close
        </button>
      </div>
      <input className="qty-input" type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by group name…" aria-label="Search public groups" maxLength={messages.limits.maxGroupTitle} autoComplete="off" data-testid="pm-public-search" />
      {groups === null && !error && <p className="hint">Loading the groups…</p>}
      {groups !== null && groups.length === 0 && (
        <p className="hint" data-testid="pm-public-empty">
          {query.trim() === '' ? 'There are no public groups yet. Press New group and choose Public to make the first one.' : 'No public group has that in its name.'}
        </p>
      )}
      {groups !== null && groups.length > 0 && (
        <ul className="pm-list" aria-label="Public groups" data-testid="pm-public-list">
          {groups.map((g) => (
            <li key={g.id} className="pm-request" data-testid={`pm-public-${g.id}`}>
              <strong>{g.title}</strong>
              <span className="pm-preview muted">
                {g.memberCount} of {g.max} players{g.creator ? ` · made by ${g.creator.displayName}` : ''}
              </span>
              <span className="people-actions">
                {g.joined ? (
                  <button type="button" className="btn btn-small" onClick={() => onOpen(g.id)} data-testid={`pm-public-open-${g.id}`}>
                    Open
                  </button>
                ) : (
                  <button type="button" className="btn btn-small btn-primary" disabled={busy !== null || g.memberCount >= g.max || !messages.you.canWrite} onClick={() => void join(g)} data-testid={`pm-public-join-${g.id}`}>
                    {g.memberCount >= g.max ? 'Full' : busy === g.id ? 'Joining…' : 'Join'}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!messages.you.canWrite && (
        <p className="notice warn" role="status">
          {messages.you.message}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert" data-testid="pm-public-error">
          {error}
        </p>
      )}
      <p className="hint">
        Anybody who can write can join a public group at once. Everyone in it can read what is said after they join, so do not share private things there. You can leave at any time, and the player who made the group can remove people.
      </p>
    </section>
  );
}

// ---- players you blocked -------------------------------------------------------------------------------------------------------

function BlockedPanel({ onDone }: { onDone: () => void }) {
  const { messages } = useShared();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!messages) return null;
  const unblock = async (username: string) => {
    setBusy(true);
    setError(null);
    try {
      sharedStore.setMessages(await api.messagesUnblock(username));
    } catch (e) {
      setError(problemText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-label="Blocked players" data-testid="pm-blocked">
      <div className="row-between">
        <h2>
          Blocked players <span className="h2-note">{messages.blocked.length}</span>
        </h2>
        <button type="button" className="btn btn-small btn-ghost" onClick={onDone}>
          Close
        </button>
      </div>
      {messages.blocked.length === 0 && <p className="hint">You have not blocked anybody.</p>}
      {messages.blocked.length > 0 && (
        <ul className="friend-challenge-list">
          {messages.blocked.map((b) => (
            <li key={b.username} data-username={b.username}>
              <strong>{b.displayName}</strong>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => void unblock(b.username)} data-testid={`pm-unblock-${b.username}`}>
                Unblock
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <p className="hint">
        A blocked player cannot write to you, ask to be your friend or invite you to a group, and what they write in a conversation you share is hidden from you. Blocking also ends a friendship and any 1v1 challenge between you. They are
        not told that you blocked them; they only find that they cannot write to you.
      </p>
    </section>
  );
}

// ---- requests and invitations --------------------------------------------------------------------------------------------------

function Requests({ requests, onOpen }: { requests: readonly PmRequest[]; onOpen: (id: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(problemText(e));
      void sharedStore.refreshMessages();
    } finally {
      setBusy(false);
    }
  };
  const answer = (r: PmRequest, what: 'accept' | 'decline') =>
    run(async () => {
      sharedStore.setMessages(await api.messagesRespond(r.conversationId, what));
      if (what === 'accept') onOpen(r.conversationId);
    });
  const block = (r: PmRequest) =>
    run(async () => {
      sharedStore.setMessages(await api.messagesBlock(r.from.username));
    });
  if (requests.length === 0) return null;
  return (
    <div className="pm-requests" data-testid="pm-requests" aria-label="Requests">
      <h3>
        Waiting for you <span className="h2-note">{requests.length}</span>
      </h3>
      <ul className="pm-list">
        {requests.map((r) => (
          <li key={r.conversationId} className="pm-request" data-testid={`pm-request-${r.conversationId}`}>
            <strong>{requestTitle(r)}</strong>
            {r.kind === 'message' && <span className="pm-preview muted">{previewOf(r.text, 120)}</span>}
            {r.kind === 'invite' && (
              <span className="pm-preview muted">
                {r.memberCount} {r.memberCount === 1 ? 'player is' : 'players are'} in it now
              </span>
            )}
            <span className="people-actions">
              {r.kind === 'message' && (
                <button type="button" className="btn btn-small btn-ghost" onClick={() => onOpen(r.conversationId)} data-testid={`pm-read-${r.conversationId}`}>
                  Read
                </button>
              )}
              <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void answer(r, 'accept')} data-testid={`pm-accept-${r.conversationId}`}>
                {r.kind === 'message' ? 'Accept' : 'Join'}
              </button>
              <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void answer(r, 'decline')} data-testid={`pm-decline-${r.conversationId}`}>
                {r.kind === 'message' ? 'Ignore' : 'Decline'}
              </button>
              {r.kind === 'message' && (
                <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void block(r)} data-testid={`pm-block-request-${r.conversationId}`}>
                  Block
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {error && (
        <p className="notice error" role="alert" data-testid="pm-requests-error">
          {error}
        </p>
      )}
    </div>
  );
}

// ---- the screen ----------------------------------------------------------------------------------------------------------------

export function MessagesScreen() {
  const { user, messages, pmOpen, pmThread, pmCompose, tickMs } = useShared();
  const [panel, setPanel] = useState<Panel>('none');
  useOnlineWatch();

  // The conversation on screen is closed when the player leaves this tab, so messages that arrive afterwards count as unread.
  useEffect(() => {
    void sharedStore.refreshMessages();
    return () => {
      void sharedStore.openConversation(null);
    };
  }, []);

  // "Message" next to a player's name elsewhere opens the writing form with that name in it.
  useEffect(() => {
    if (pmCompose !== null) {
      setPanel('new');
      void sharedStore.openConversation(null);
    }
  }, [pmCompose]);

  if (!user) return <AuthPanel />;
  if (!messages) {
    return (
      <section className="card" aria-label="Messages">
        <p className="hint">Loading your messages…</p>
      </section>
    );
  }

  const me = user.username;
  const now = tickMs > 0 ? tickMs : Date.now();
  const open = (id: number) => {
    setPanel('none');
    sharedStore.clearCompose();
    void sharedStore.openConversation(id);
  };
  const close = () => void sharedStore.openConversation(null);
  const showThread = panel === 'none' && pmOpen !== null && pmThread !== null && pmThread.id === pmOpen;
  const choose = (next: Panel) => {
    void sharedStore.openConversation(null);
    sharedStore.clearCompose();
    setPanel((old) => (old === next ? 'none' : next));
  };

  return (
    <div className={pmOpen !== null || panel !== 'none' ? 'pm-layout pm-open' : 'pm-layout'} data-testid="messages">
      <aside className="card pm-side" aria-label="Conversations">
        <div className="row-between">
          <h2>
            Messages{' '}
            {messages.unread > 0 && (
              <span className="tab-count" data-testid="pm-unread" aria-label={`${messages.unread} unread`}>
                {messages.unread > 99 ? '99+' : messages.unread}
              </span>
            )}
          </h2>
          <span className="people-actions">
            <button type="button" className="btn btn-small btn-primary" onClick={() => choose('new')} aria-pressed={panel === 'new'} data-testid="pm-new-button">
              New message
            </button>
            <button type="button" className="btn btn-small" onClick={() => choose('group')} aria-pressed={panel === 'group'} data-testid="pm-group-button">
              New group
            </button>
            <button type="button" className="btn btn-small" onClick={() => choose('public')} aria-pressed={panel === 'public'} data-testid="pm-public-button">
              Public groups
            </button>
          </span>
        </div>

        <Requests requests={messages.requests} onOpen={open} />

        {messages.conversations.length === 0 && messages.requests.length === 0 && (
          <p className="hint" data-testid="pm-empty">
            No conversations yet. Press New message to write to a friend, or to anybody else: a player who is not your friend gets a request and decides whether to answer. Press Public groups to find a group anybody can join.
          </p>
        )}
        {messages.conversations.length > 0 && (
          <ul className="pm-list" aria-label="Your conversations" data-testid="pm-list">
            {messages.conversations.map((c) => (
              <li key={c.id}>
                <button type="button" className={pmOpen === c.id && panel === 'none' ? 'pm-item active' : 'pm-item'} onClick={() => open(c.id)} data-testid={`pm-open-${c.id}`} data-unread={c.unread}>
                  <span className="pm-title">
                    {c.other && (
                      <span className="pfp-wrap">
                        <Avatar username={c.other.username} displayName={c.other.displayName} size={22} />
                        <OnlineDot username={c.other.username} />
                      </span>
                    )}
                    {c.other ? <PlayerName username={c.other.username} name={c.title} link={false} /> : <strong>{c.title}</strong>}
                    {c.kind === 'group' && <span className="tag">{c.visibility === 'public' ? 'Public group' : 'Group'}</span>}
                    {c.requestState === 'waiting' && <span className="tag">Waiting for a reply</span>}
                    {c.unread > 0 && (
                      <span className="tab-count" aria-label={`${c.unread} unread`}>
                        {c.unread > 99 ? '99+' : c.unread}
                      </span>
                    )}
                    <span className="muted pm-when">{c.last ? whenLabel(c.last.createdMs, now) : ''}</span>
                  </span>
                  <span className="pm-preview muted">{lastLine(c, me)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="link-btn" onClick={() => choose('blocked')} aria-expanded={panel === 'blocked'} data-testid="pm-blocked-button">
          Blocked players ({messages.blocked.length})
        </button>
      </aside>

      <div className="pm-main">
        {panel === 'new' && <ComposeNew key={pmCompose ?? ''} initialTo={pmCompose ?? ''} onDone={() => setPanel('none')} />}
        {panel === 'group' && <GroupMaker onDone={() => setPanel('none')} />}
        {panel === 'public' && <PublicGroupsPanel onDone={() => setPanel('none')} onOpen={open} />}
        {panel === 'blocked' && <BlockedPanel onDone={() => setPanel('none')} />}
        {showThread && pmThread && <PmThreadView thread={pmThread} onClose={close} />}
        {panel === 'none' && pmOpen !== null && !showThread && (
          <section className="card" aria-label="Conversation">
            <p className="hint">Loading the conversation…</p>
          </section>
        )}
        {panel === 'none' && pmOpen === null && (
          <section className="card pm-placeholder" aria-label="No conversation open">
            <p className="hint">Pick a conversation on the left, or start a new one.</p>
            <p className="hint">
              Private chats are between the players in them only. The owner cannot read them; he sees just a message that somebody presses Report on, and the few before it. Press Block on a player and they can no longer write to you.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
