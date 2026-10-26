// The moderators' page. A moderator is a player the owner chose (docs/world.md §21). He can kick and ban ordinary players (a ban is at most 7 days), take
// away a picture and look after the public chat, but he cannot touch the owner, another moderator or himself, and the owner's admin panel stays the
// owner's. Everything here is a request to the server, which checks it again and writes it to the admin log; the buttons only offer what it accepts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { AdminChat } from './AdminChat';
import { newRequestId } from './adminUtil';
import { Avatar } from './Avatar';
import { KICK_CHOICES, MOD_BAN_CHOICES, banLine, cannotActOn } from './modUtil';
import { problemText } from './playersUtil';
import { useProfiles } from './profileStore';
import { RoleBadge } from './RoleBadge';
import type { StaffPlayer } from './types';

type Tab = 'players' | 'chat';
type Confirm = { type: 'ban'; id: string; hours: number; label: string } | { type: 'kick'; id: string; minutes: number; label: string } | null;

function ModPlayers() {
  const { avatars } = useProfiles();
  const [query, setQuery] = useState('');
  const queryRef = useRef(query);
  queryRef.current = query;
  const [players, setPlayers] = useState<readonly StaffPlayer[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setPlayers((await api.modPlayers(queryRef.current)).players);
    } catch (e) {
      setMessage({ kind: 'error', text: problemText(e) });
    }
  }, []);
  // Searching asks the server again a moment after the typing stops.
  useEffect(() => {
    const id = setTimeout(() => void load(), 250);
    return () => clearTimeout(id);
  }, [query, load]);

  const player = (players ?? []).find((p) => p.username === selected) ?? null;
  const blocked = player ? cannotActOn(player.role) : null;

  const run = async (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ kind: 'ok', text: await fn() });
      setConfirm(null);
      await load();
    } catch (e) {
      setMessage({ kind: 'error', text: problemText(e) });
    } finally {
      setBusy(false);
    }
  };

  const choose = (name: string) => {
    setSelected(name);
    setConfirm(null);
    setMessage(null);
  };

  const doConfirm = () =>
    run(async () => {
      if (!player || !confirm) throw new Error('Choose what to do first.');
      const why = reason.trim() || undefined;
      if (confirm.type === 'ban') {
        await api.adminBan({ requestId: confirm.id, username: player.username, hours: confirm.hours, reason: why });
        setReason('');
        return `${player.username} is banned for ${confirm.label}. They were signed out at once.`;
      }
      await api.adminKick({ requestId: confirm.id, username: player.username, minutes: confirm.minutes, reason: why });
      setReason('');
      return `${player.username} is kicked for ${confirm.label}. They were signed out at once and can sign in again after that.`;
    });

  return (
    <div className="admin-grid" data-testid="mod-players">
      <section className="card" aria-label="Find a player">
        <h2>
          Players <span className="h2-note">{players ? `${players.length} shown` : ''}</span>
        </h2>
        <input className="qty-input" type="search" placeholder="Search by username" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search players" data-testid="mod-player-search" />
        <div className="table-wrap">
          <table className="trades admin-players" data-testid="mod-player-list">
            <thead>
              <tr>
                <th>Player</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(players ?? []).map((p) => (
                <tr key={p.username} className={p.username === selected ? 'row-selected' : undefined} data-username={p.username}>
                  <td>
                    <button type="button" className="link-btn" onClick={() => choose(p.username)}>
                      <strong>{p.username}</strong>
                    </button>
                    <RoleBadge role={p.role} />
                  </td>
                  <td>
                    {p.banned ? (
                      <span className="badge-banned" data-testid={`mod-banned-${p.username}`}>
                        {p.banned.kind === 'kick' ? 'Kicked' : 'Banned'}
                      </span>
                    ) : (
                      <span className="muted">OK</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {players !== null && players.length === 0 && <p className="hint">No player matches.</p>}
        <p className="hint">You see names only: moderators never see anybody&apos;s money or private chats.</p>
      </section>

      <div className="admin-col">
        <section className="card" aria-label="Kick or ban">
          <h2>
            Kick or ban <span className="h2-note">{player ? player.username : 'pick a player'}</span>
          </h2>
          {!player && <p className="hint">Click a player in the list.</p>}
          {player && blocked && (
            <p className="hint" data-testid="mod-cannot">
              {blocked}
            </p>
          )}
          {player && !blocked && player.banned && (
            <>
              <p className="notice error" role="status" data-testid="mod-ban-status">
                {banLine(player.banned)}
              </p>
              <button type="button" className="btn btn-buy" disabled={busy} onClick={() => void run(async () => {
                await api.adminUnban({ requestId: newRequestId(), username: player.username });
                return `${player.username} can sign in again.`;
              })} data-testid="mod-unban">
                Lift it for {player.username}
              </button>
              <p className="hint">If the owner gave this ban himself, the server will say so and only the owner can lift it.</p>
            </>
          )}
          {player && !blocked && !player.banned && (
            <>
              <p className="hint">
                A kick is a short ban (10 minutes to 1 day). A ban is 1 hour to 7 days; only the owner bans for good. Either way the player is signed out at once and leaves any 1v1 match (a live match counts as a forfeit). Their money stays as it is. You can give
                about 20 kicks and bans an hour.
              </p>
              <fieldset className="admin-fields" disabled={busy || confirm !== null}>
                <label className="qty-label" htmlFor="mod-reason">
                  Reason (the player sees it when he tries to sign in)
                </label>
                <input id="mod-reason" className="qty-input" type="text" maxLength={120} placeholder="For example: spamming the chat" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="mod-reason" />
                <h3 className="admin-h3">Kick</h3>
                <div className="row-buttons">
                  {KICK_CHOICES.map((k) => (
                    <button key={k.minutes} type="button" className="btn btn-small" onClick={() => setConfirm({ type: 'kick', id: newRequestId(), minutes: k.minutes, label: k.label })} data-testid={`mod-kick-${k.minutes}`}>
                      Kick {k.label}
                    </button>
                  ))}
                </div>
                <h3 className="admin-h3">Ban</h3>
                <div className="row-buttons">
                  {MOD_BAN_CHOICES.map((b) => (
                    <button key={b.hours} type="button" className="btn btn-small btn-sell" onClick={() => setConfirm({ type: 'ban', id: newRequestId(), hours: b.hours, label: b.label })} data-testid={`mod-ban-${b.hours}`}>
                      Ban {b.label}
                    </button>
                  ))}
                </div>
              </fieldset>
              {confirm && (
                <div className="admin-confirm" data-testid="mod-confirm-box">
                  <p>
                    {confirm.type === 'ban' ? 'Ban' : 'Kick'} <strong>{player.username}</strong> for {confirm.label}
                    {reason.trim() ? ` (“${reason.trim()}”)` : ''}?
                  </p>
                  <div className="row-buttons">
                    <button type="button" className="btn btn-sell" disabled={busy} onClick={() => void doConfirm()} data-testid="mod-confirm">
                      {confirm.type === 'ban' ? 'Yes, ban' : 'Yes, kick'}
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(null)} data-testid="mod-cancel">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {player && !blocked && (
            <>
              <h3 className="admin-h3">Profile picture</h3>
              {avatars[player.username] === undefined ? (
                <p className="hint" data-testid="mod-no-picture">
                  {player.username} has no picture.
                </p>
              ) : (
                <div className="pfp-edit">
                  <Avatar username={player.username} size={56} />
                  <button
                    type="button"
                    className="btn btn-sell"
                    disabled={busy}
                    onClick={() => void run(async () => {
                      const r = await api.adminAvatarRemove({ requestId: newRequestId(), username: player.username });
                      return `${r.username}'s picture is removed. They can choose another one.`;
                    })}
                    data-testid="mod-remove-picture"
                  >
                    Remove {player.username}&apos;s picture
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        {message && (
          <p className={message.kind === 'ok' ? 'notice success' : 'notice error'} role="status" data-testid="mod-message">
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}

export function ModScreen() {
  const [tab, setTab] = useState<Tab>('players');
  const tabs: [Tab, string][] = [
    ['players', 'Players'],
    ['chat', 'Chat'],
  ];
  return (
    <div className="admin-screen" data-testid="mod-screen">
      <section className="card admin-banner">
        <h2>
          Moderation <RoleBadge role="moderator" />
        </h2>
        <p className="hint">
          You can kick and ban ordinary players (a ban is at most 7 days), take away a picture, and look after the public chat. You cannot act on the owner, on another moderator or on yourself. Everything you do is written to the log that the owner reads.
        </p>
      </section>
      <nav className="tabs" role="tablist" aria-label="Moderation sections">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)} data-testid={`mod-tab-${id}`}>
            {label}
          </button>
        ))}
      </nav>
      {tab === 'players' && <ModPlayers />}
      {tab === 'chat' && <AdminChat staff />}
    </div>
  );
}
