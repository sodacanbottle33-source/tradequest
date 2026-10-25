// Players: the leaderboard of the richest players, your friends, and a list to find players and add them as friends.
// Every number here (who is ranked where, what a player is worth, who is whose friend) comes from the server. The page only asks and
// shows; it does not rank, filter or decide anything, and it can only ever see a player's name and net worth.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { AuthPanel } from './AuthPanel';
import { Avatar, OnlineDot, useOnlineWatch } from './Avatar';
import { CallButton } from './CallBar';
import { ChallengeButton, useChallengeActions } from './Challenges';
import { clockTime, formatCents } from './format';
import { problemText, relationLabel, shownText, standingText } from './playersUtil';
import { sharedStore, useShared } from './store';
import type { BoardScope, FriendAction, FriendEntry, Leaderboard, PlayerEntry, Relation, WeeklyBoard } from './types';

type View = 'board' | 'weekly' | 'friends' | 'find';

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

function Who({ name, username, role, you }: { name: string; username: string; role: 'player' | 'owner'; you?: boolean }) {
  return (
    <>
      <span className="pfp-wrap" style={{ marginRight: 8 }}>
        <Avatar username={username} displayName={name} size={24} />
        <OnlineDot username={username} />
      </span>
      <strong>{name}</strong>
      {you && <span className="muted"> (you)</span>}
      {role === 'owner' && <span className="badge-owner">Owner</span>}
    </>
  );
}

/** Opens the Messages tab with this player ready to be written to. */
function MessageButton({ username }: { username: string }) {
  return (
    <button type="button" className="btn btn-small btn-ghost" onClick={() => sharedStore.startCompose(username)} data-testid={`message-${username}`}>
      Message
    </button>
  );
}

/** What can be done with one player, depending on how he stands to you. */
function PlayerActions({ username, relation, actions, onDone }: { username: string; relation: Relation; actions: Actions; onDone: (username: string, relation: Relation | null) => void }) {
  if (relation === 'you') return <span className="muted">{relationLabel(relation)}</span>;
  return (
    <span className="people-actions">
      <RelationActions username={username} relation={relation} actions={actions} onDone={onDone} />
      <MessageButton username={username} />
    </span>
  );
}

function RelationActions({ username, relation, actions, onDone }: { username: string; relation: Relation; actions: Actions; onDone: (username: string, relation: Relation | null) => void }) {
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
                        <Who name={row.displayName} username={row.username} role="player" you={row.relation === 'you'} />
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

// ---- the weekly board --------------------------------------------------------------------------------------------------------

/** "+12.34%" or "-3.5%" */
export function pctText(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '-' : '';
  return `${sign}${Math.abs(pct).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
}

/** "+$123.45" or "-$10.00" */
export function gainText(cents: number): string {
  const sign = cents > 0 ? '+' : cents < 0 ? '-' : '';
  return `${sign}${formatCents(Math.abs(cents))}`;
}

/** How long until the week ends, in words ("2 days 5 hours", "3 hours", "12 minutes"). */
export function weekLeftText(endsMs: number, nowMs: number): string {
  const left = Math.max(0, endsMs - nowMs);
  const minutes = Math.floor(left / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (days >= 1) return hours > 0 ? `${plural(days, 'day')} ${plural(hours, 'hour')}` : plural(days, 'day');
  if (hours >= 1) return plural(hours, 'hour');
  return plural(Math.max(1, minutes), 'minute');
}

function WeeklyPanel({ isOwner }: { isOwner: boolean }) {
  const [scope, setScope] = useState<BoardScope>('all');
  const [board, setBoard] = useState<WeeklyBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = useFriendActions();
  const { tickMs } = useShared();
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = (seq.current += 1);
    try {
      const b = await api.weeklyBoard(scope);
      if (mine === seq.current) {
        setBoard(b);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(problemText(e));
    }
  }, [scope]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      clearInterval(timer);
      seq.current += 1;
    };
  }, [load]);

  const choose = (next: BoardScope) => {
    if (next === scope) return;
    setBoard(null);
    setScope(next);
  };

  return (
    <section className="card" aria-label="Weekly leaderboard" data-testid="weekly-board">
      <div className="row-between">
        <h2>
          This week <span className="h2-note">{board ? `${weekLeftText(board.endsMs, tickMs || board.updatedMs)} left` : ''}</span>
        </h2>
      </div>
      <div className="seg-group" role="group" aria-label="Who to rank this week">
        <button type="button" className={scope === 'all' ? 'seg active' : 'seg'} aria-pressed={scope === 'all'} onClick={() => choose('all')} data-testid="weekly-all">
          Everyone
        </button>
        <button type="button" className={scope === 'friends' ? 'seg active' : 'seg'} aria-pressed={scope === 'friends'} onClick={() => choose('friends')} data-testid="weekly-friends">
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
      {!board && !error && <p className="hint">Loading this week…</p>}
      {board && (
        <>
          <p className="board-me" data-testid="weekly-standing">
            {board.me
              ? `You are #${board.me.rank.toLocaleString('en-US')} of ${board.total.toLocaleString('en-US')} this week: ${gainText(board.me.gainCents)} (${pctText(board.me.gainPct)}).`
              : isOwner
                ? 'The owner is not ranked.'
                : `You are not ranked this week. You need at least ${formatCents(board.minStartCents)} at the start of the week.`}
          </p>
          {board.rows.length > 0 && (
            <div className="table-wrap">
              <table className="trades board" data-testid="weekly-table">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Player</th>
                    <th className="num">This week</th>
                    <th className="num">Net worth</th>
                    <th className="num">Friend</th>
                  </tr>
                </thead>
                <tbody>
                  {board.rows.map((row) => (
                    <tr key={row.username} className={row.relation === 'you' ? 'row-selected' : undefined} data-username={row.username}>
                      <td className={row.rank <= 3 ? 'num rank top' : 'num rank'}>{row.rank}</td>
                      <td>
                        <Who name={row.displayName} username={row.username} role="player" you={row.relation === 'you'} />
                      </td>
                      <td className={row.gainCents > 0 ? 'num mono up' : row.gainCents < 0 ? 'num mono down' : 'num mono'}>
                        {pctText(row.gainPct)} <span className="muted">{gainText(row.gainCents)}</span>
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
          {board.rows.length === 0 && <p className="hint">Nobody has a result yet. The week starts on Monday at 00:00 Tokyo time.</p>}
          {board.lastWeek.winners.length > 0 && (
            <div data-testid="weekly-last">
              <h3>Last week&apos;s best</h3>
              <ol className="podium">
                {board.lastWeek.winners.map((w, i) => (
                  <li key={w.username} data-username={w.username}>
                    <span className="rank top">{i + 1}</span> <Who name={w.displayName} username={w.username} role="player" /> <span className="up mono">{pctText(w.gainPct)}</span> <span className="muted">{gainText(w.gainCents)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
      <p className="hint">
        Ranked by how much your net worth grew since Monday 00:00 Tokyo time, as a percentage of what you had then, so small and big accounts compete fairly. You need at least{' '}
        {formatCents(board?.minStartCents ?? 10_000)} at the start of the week to be ranked; a player who joins during the week starts from the starting cash. The owner and the computer players are left out. A new week starts every Monday.
      </p>
    </section>
  );
}

// ---- friends -----------------------------------------------------------------------------------------------------------------

function FriendRow({ entry, children }: { entry: FriendEntry; children: ReactNode }) {
  return (
    <tr data-username={entry.username}>
      <td>
        <Who name={entry.displayName} username={entry.username} role={entry.role} />
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
                  <CallButton username={e.username} />
                  <MessageButton username={e.username} />
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
                    <Who name={p.displayName} username={p.username} role={p.role} you={p.relation === 'you'} />
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
  useOnlineWatch();
  if (!user) return <AuthPanel />;
  const waiting = friends?.incoming.length ?? 0;
  const tabs: [View, string][] = [
    ['board', 'Leaderboard'],
    ['weekly', 'This week'],
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
      {view === 'weekly' && <WeeklyPanel isOwner={user.role === 'owner'} />}
      {view === 'friends' && <FriendsPanel onFind={() => setView('find')} />}
      {view === 'find' && <FindPanel />}
    </div>
  );
}
