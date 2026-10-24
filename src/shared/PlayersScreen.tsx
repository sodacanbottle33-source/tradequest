// Players: the leaderboard of the richest players, your friends, and a list to find players and add them as friends.
// Every number here (who is ranked where, what a player is worth, who is whose friend) comes from the server. The page only asks and
// shows; it does not rank, filter or decide anything, and it can only ever see a player's name and net worth.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { AuthPanel } from './AuthPanel';
import { ChallengeButton, useChallengeActions } from './Challenges';
import { clockTime, formatCents } from './format';
import { problemText, relationLabel, shownText, standingText } from './playersUtil';
import { sharedStore, useShared } from './store';
import type { BoardScope, FriendAction, FriendEntry, Leaderboard, PlayerEntry, Relation } from './types';

type View = 'board' | 'friends' | 'find';

/** Sends one friend action and hands the lists the server answered with to the store. */
function useFriendActions() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (what: FriendAction, username: string): Promise<Relation | null> => {
    setBusy(`${what}:${username}`);
    setError(null);
    try {
      const out = await api.friendAction(what, username);
      sharedStore.setFriends({ friends: out.friends, incoming: out.incoming, outgoing: out.outgoing, limits: out.limits });
      return out.relation;
    } catch (e) {
      setError(problemText(e));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, run };
}
type Actions = ReturnType<typeof useFriendActions>;

function Who({ name, role, you }: { name: string; role: 'player' | 'owner'; you?: boolean }) {
  return (
    <>
      <strong>{name}</strong>
      {you && <span className="muted"> (you)</span>}
      {role === 'owner' && <span className="badge-owner">Owner</span>}
    </>
  );
}

/** What can be done with one player, depending on how he stands to you. */
function PlayerActions({ username, relation, actions, onDone }: { username: string; relation: Relation; actions: Actions; onDone: (username: string, relation: Relation | null) => void }) {
  const go = async (what: FriendAction) => onDone(username, await actions.run(what, username));
  const busy = actions.busy !== null;
  if (relation === 'you') return <span className="muted">{relationLabel(relation)}</span>;
  if (relation === 'friend') return <span className="rel-friend">{relationLabel(relation)}</span>;
  if (relation === 'outgoing') {
    return (
      <span className="people-actions">
        <span className="muted">{relationLabel(relation)}</span>
        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void go('cancel')} data-testid={`cancel-${username}`}>
          Cancel
        </button>
      </span>
    );
  }
  if (relation === 'incoming') {
    return (
      <span className="people-actions">
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => void go('accept')} data-testid={`accept-${username}`}>
          Accept
        </button>
        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void go('decline')} data-testid={`decline-${username}`}>
          Decline
        </button>
      </span>
    );
  }
  return (
    <button type="button" className="btn btn-small" disabled={busy} onClick={() => void go('request')} data-testid={`add-${username}`}>
      {relationLabel(relation)}
    </button>
  );
}

// ---- the leaderboard ---------------------------------------------------------------------------------------------------------

function BoardPanel({ isOwner }: { isOwner: boolean }) {
  const [scope, setScope] = useState<BoardScope>('all');
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = useFriendActions();
  const friendCount = useShared().friends?.friends.length ?? 0;
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = (seq.current += 1);
    try {
      const b = await api.leaderboard(scope);
      if (mine === seq.current) {
        setBoard(b);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(problemText(e));
    }
  }, [scope]);

  // The server keeps its ranking for half a minute, so asking more often would only repeat the answer. A new or lost friend changes the Friends view at once.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      clearInterval(timer);
      seq.current += 1;
    };
  }, [load, friendCount]);

  const choose = (next: BoardScope) => {
    if (next === scope) return;
    setBoard(null);
    setScope(next);
  };

  return (
    <section className="card" aria-label="Leaderboard" data-testid="leaderboard">
      <div className="row-between">
        <h2>
          Richest players <span className="h2-note">{board ? shownText(board.rows.length, board.total) : ''}</span>
        </h2>
      </div>
      <div className="seg-group" role="group" aria-label="Who to rank">
        <button type="button" className={scope === 'all' ? 'seg active' : 'seg'} aria-pressed={scope === 'all'} onClick={() => choose('all')} data-testid="board-all">
          Everyone
        </button>
        <button type="button" className={scope === 'friends' ? 'seg active' : 'seg'} aria-pressed={scope === 'friends'} onClick={() => choose('friends')} data-testid="board-friends">
          Friends
        </button>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {actions.error && (
        <p className="notice error" role="alert">
          {actions.error}
        </p>
      )}
      {!board && !error && <p className="hint">Loading the leaderboard…</p>}
      {board && (
        <>
          <p className="board-me" data-testid="board-standing">
            {standingText(board.me, board.total, board.scope, board.size, isOwner)}
          </p>
          {board.rows.length > 0 && (
            <div className="table-wrap">
              <table className="trades board" data-testid="board-table">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Player</th>
                    <th className="num">Net worth</th>
                    <th className="num">Friend</th>
                  </tr>
                </thead>
                <tbody>
                  {board.rows.map((row) => (
                    <tr key={row.username} className={row.relation === 'you' ? 'row-selected' : undefined} data-username={row.username}>
                      <td className={row.rank <= 3 ? 'num rank top' : 'num rank'}>{row.rank}</td>
                      <td>
                        <Who name={row.displayName} role="player" you={row.relation === 'you'} />
                      </td>
                      <td className="num mono">{formatCents(row.netWorthCents)}</td>
                      <td className="num">
                        <PlayerActions username={row.username} relation={row.relation} actions={actions} onDone={(_name, relation) => relation !== null && void load()} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {board.scope === 'friends' && board.total <= 1 && <p className="hint">No friends to compare with yet. Add some from the Find players tab or from the Everyone board.</p>}
        </>
      )}
      <p className="hint">
        Ranked by Career net worth: cash plus what your shares are worth right now. The owner and the computer players are left out. The list is refreshed every 30
        seconds{board ? ` (last at ${clockTime(board.updatedMs)})` : ''}. Other players see only your name and your net worth, never what you hold or trade.
      </p>
    </section>
  );
}

// ---- friends -----------------------------------------------------------------------------------------------------------------

function FriendRow({ entry, children }: { entry: FriendEntry; children: ReactNode }) {
  return (
    <tr data-username={entry.username}>
      <td>
        <Who name={entry.displayName} role={entry.role} />
      </td>
      <td className="num mono">{entry.netWorthCents === null ? '—' : formatCents(entry.netWorthCents)}</td>
      <td className="num">{entry.rank === null ? '—' : `#${entry.rank.toLocaleString('en-US')}`}</td>
      <td className="num">{children}</td>
    </tr>
  );
}

function FriendTable({ label, rows, render }: { label: string; rows: FriendEntry[]; render: (entry: FriendEntry) => ReactNode }) {
  return (
    <div className="table-wrap">
      <table className="trades" aria-label={label}>
        <thead>
          <tr>
            <th>Player</th>
            <th className="num">Net worth</th>
            <th className="num">Place</th>
            <th className="num" />
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => (
            <FriendRow key={entry.username} entry={entry}>
              {render(entry)}
            </FriendRow>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FriendsPanel({ onFind }: { onFind: () => void }) {
  const { friends } = useShared();
  const actions = useFriendActions();
  const challengeActions = useChallengeActions();
  const [confirming, setConfirming] = useState<string | null>(null);
  if (!friends) return (
      <section className="card">
        <p className="hint">Loading your friends…</p>
      </section>
    );
  const busy = actions.busy !== null;
  const act = async (what: FriendAction, username: string) => {
    setConfirming(null);
    await actions.run(what, username);
  };
  return (
    <div className="players-layout" data-testid="friends-panel">
      {actions.error && (
        <p className="notice error" role="alert">
          {actions.error}
        </p>
      )}
      {challengeActions.error && (
        <p className="notice error" role="alert">
          {challengeActions.error}
        </p>
      )}
      {friends.incoming.length > 0 && (
        <section className="card" aria-label="Friend requests" data-testid="friend-requests">
          <h2>
            Friend requests <span className="h2-note">{friends.incoming.length} waiting for you</span>
          </h2>
          <FriendTable
            label="Requests for you"
            rows={friends.incoming}
            render={(e) => (
              <span className="people-actions">
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => void act('accept', e.username)} data-testid={`accept-${e.username}`}>
                  Accept
                </button>
                <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void act('decline', e.username)} data-testid={`decline-${e.username}`}>
                  Decline
                </button>
              </span>
            )}
          />
        </section>
      )}

      <section className="card" aria-label="Friends" data-testid="friend-list">
        <h2>
          Friends{' '}
          <span className="h2-note">
            {friends.friends.length} of {friends.limits.maxFriends}
          </span>
        </h2>
        {friends.friends.length === 0 && (
          <p className="hint">
            You have no friends yet.{' '}
            <button type="button" className="link-btn" onClick={onFind}>
              Find players
            </button>{' '}
            and send a request; when they say yes you will see each other here and on the Friends leaderboard.
          </p>
        )}
        {friends.friends.length > 0 && (
          <FriendTable
            label="Your friends"
            rows={friends.friends}
            render={(e) =>
              confirming === e.username ? (
                <span className="people-actions">
                  <span className="muted">Remove?</span>
                  <button type="button" className="btn btn-small btn-sell" disabled={busy} onClick={() => void act('remove', e.username)} data-testid={`remove-yes-${e.username}`}>
                    Yes
                  </button>
                  <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirming(null)}>
                    No
                  </button>
                </span>
              ) : (
                <span className="people-actions">
                  <ChallengeButton username={e.username} actions={challengeActions} />
                  <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setConfirming(e.username)} data-testid={`remove-${e.username}`}>
                    Remove
                  </button>
                </span>
              )
            }
          />
        )}
        <p className="hint">
          Friends can see only your name and your net worth. Nothing — no cash, no shares — is ever sent between players. Press Challenge to ask a friend who has TradeQuest open to a 1v1.
        </p>
      </section>

      {friends.outgoing.length > 0 && (
        <section className="card" aria-label="Requests you sent" data-testid="friend-sent">
          <h2>
            Waiting for an answer <span className="h2-note">{friends.outgoing.length} of {friends.limits.maxOutgoing}</span>
          </h2>
          <FriendTable
            label="Requests you sent"
            rows={friends.outgoing}
            render={(e) => (
              <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void act('cancel', e.username)} data-testid={`cancel-${e.username}`}>
                Cancel request
              </button>
            )}
          />
        </section>
      )}
    </div>
  );
}

// ---- finding players ---------------------------------------------------------------------------------------------------------

function FindPanel() {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<PlayerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actions = useFriendActions();
  const seq = useRef(0);

  const fetchPage = useCallback(async (q: string, offset: number) => {
    const mine = (seq.current += 1);
    setLoading(true);
    try {
      const page = await api.players(q, offset, 50);
      if (mine !== seq.current) return;
      setRows((old) => (offset === 0 ? page.players : [...old, ...page.players]));
      setTotal(page.total);
      setLoaded(true);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(problemText(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  // A search starts a moment after the last key, so typing a name does not ask the server once per letter.
  useEffect(() => {
    const timer = setTimeout(() => void fetchPage(query, 0), query === '' ? 0 : 250);
    return () => {
      clearTimeout(timer);
      seq.current += 1;
    };
  }, [query, fetchPage]);

  const changed = (username: string, relation: Relation | null) => {
    if (relation !== null) setRows((old) => old.map((r) => (r.username === username ? { ...r, relation } : r)));
  };

  return (
    <section className="card" aria-label="Find players" data-testid="find-players">
      <h2>
        Find players <span className="h2-note">{loaded ? `${total.toLocaleString('en-US')} ${total === 1 ? 'player' : 'players'}` : ''}</span>
      </h2>
      <input className="qty-input" type="search" placeholder="Search by username" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search players" maxLength={40} data-testid="player-search" />
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {actions.error && (
        <p className="notice error" role="alert">
          {actions.error}
        </p>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="trades" aria-label="Players" data-testid="player-table">
            <thead>
              <tr>
                <th>Player</th>
                <th className="num">Net worth</th>
                <th className="num">Place</th>
                <th className="num">Friend</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.username} data-username={p.username} className={p.relation === 'you' ? 'row-selected' : undefined}>
                  <td>
                    <Who name={p.displayName} role={p.role} you={p.relation === 'you'} />
                  </td>
                  <td className="num mono">{p.netWorthCents === null ? '—' : formatCents(p.netWorthCents)}</td>
                  <td className="num">{p.rank === null ? '—' : `#${p.rank.toLocaleString('en-US')}`}</td>
                  <td className="num">
                    <PlayerActions username={p.username} relation={p.relation} actions={actions} onDone={changed} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loaded && rows.length === 0 && !loading && <p className="hint">No player has a name like that.</p>}
      {rows.length < total && (
        <button type="button" className="btn btn-small btn-ghost" disabled={loading} onClick={() => void fetchPage(query, rows.length)} data-testid="players-more">
          {loading ? 'Loading…' : `Show more (${(total - rows.length).toLocaleString('en-US')} left)`}
        </button>
      )}
      <p className="hint">Send a request; when the other player accepts you are friends. Players are listed richest first. The owner is on the list but is never ranked.</p>
    </section>
  );
}

// ---- the screen --------------------------------------------------------------------------------------------------------------

export function PlayersScreen() {
  const { user, friends } = useShared();
  const [view, setView] = useState<View>('board');
  if (!user) return <AuthPanel />;
  const waiting = friends?.incoming.length ?? 0;
  const tabs: [View, string][] = [
    ['board', 'Leaderboard'],
    ['friends', 'Friends'],
    ['find', 'Find players'],
  ];
  return (
    <div className="players-layout">
      <div className="seg-group" role="group" aria-label="Players sections">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" className={view === id ? 'seg active' : 'seg'} aria-pressed={view === id} onClick={() => setView(id)} data-testid={`players-${id}`}>
            {label}
            {id === 'friends' && waiting > 0 && (
              <span className="tab-count" data-testid="friend-badge">
                {waiting}
              </span>
            )}
          </button>
        ))}
      </div>
      {view === 'board' && <BoardPanel isOwner={user.role === 'owner'} />}
      {view === 'friends' && <FriendsPanel onFind={() => setView('find')} />}
      {view === 'find' && <FindPanel />}
    </div>
  );
}
