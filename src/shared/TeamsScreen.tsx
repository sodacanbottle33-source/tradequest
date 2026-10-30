// Teams and the weekly team race (docs/world.md §37). Start a team or join one (one at a time, up to ten players). Every week the teams race on the AVERAGE weekly growth of their
// members, so a big team has no advantage; the best teams are written down for good, and the winning team's members are given special looks. A team gives no money and no help in
// trading. The server decides everything (who may do what, the score, the places); this page shows what it says and asks it to do things.
import { useEffect, useState } from 'react';
import { api } from './api';
import { AuthPanel } from './AuthPanel';
import { useTeamsVersion } from './extrasStore';
import { teamScoreText } from './extrasUtil';
import { longUntil, signedPercent } from './goalUtil';
import { PlayerName } from './PlayerName';
import { problemText } from './playersUtil';
import { Skeleton } from './Skeleton';
import { useShared } from './store';
import type { TeamRow, TeamsView } from './types';

export function TeamsScreen() {
  const { user } = useShared();
  const version = useTeamsVersion();
  const userId = user?.id ?? 0;
  const [view, setView] = useState<TeamsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [openNew, setOpenNew] = useState(true);
  const [invitee, setInvitee] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (userId === 0) return undefined;
    let alive = true;
    api
      .teams()
      .then((v) => {
        if (!alive) return;
        setView(v);
        setNowMs(Date.now());
      })
      .catch((e: unknown) => {
        if (alive) setError(problemText(e));
      });
    return () => {
      alive = false;
    };
  }, [userId, version]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!user) return <AuthPanel />;

  /** Runs one change; the server's answer is the whole new page. */
  const run = async (fn: () => Promise<TeamsView>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setView(await fn());
      after?.();
    } catch (e) {
      setError(problemText(e));
    } finally {
      setConfirming(null);
      setBusy(false);
    }
  };

  if (view === null) {
    return (
      <section className="card" data-testid="teams-loading">
        <h2>Teams</h2>
        {error ? (
          <p className="notice error" role="alert" data-testid="teams-error">
            {error}
          </p>
        ) : (
          <Skeleton rows={4} />
        )}
      </section>
    );
  }

  const me = view.me;
  const joinable = (t: TeamRow) => me === null && t.open && t.members < view.limits.maxMembers;

  return (
    <div className="teams-layout" data-testid="teams-screen">
      <section className="card team-head" aria-label="Teams">
        <h2>
          Teams <span className="h2-note">the week ends {longUntil(view.endsMs, nowMs)}</span>
        </h2>
        <p className="hint">
          Every week the teams race. A team's score is the <strong>average</strong> weekly growth of its players, so a big team has no advantage over a small one. A team needs {view.limits.minScored} players on the weekly board to be in the race. The members of the winning team who joined at least 3 days before the week ended are given special looks. A team gives no money and no help in trading.
        </p>
        {error && (
          <p className="notice error" role="alert" data-testid="teams-error">
            {error}
          </p>
        )}
      </section>

      {me && (
        <section className="card team-mine" aria-label="Your team" data-testid="team-mine">
          <h3>
            <span className="team-tag" data-testid="team-mine-tag">[{me.tag}]</span> {me.name}{' '}
            <span className="h2-note">
              {me.open ? 'open to everyone' : 'invite only'} · {me.members}/{view.limits.maxMembers} players
            </span>
          </h3>
          <p className="team-score" data-testid="team-mine-score">
            {me.rank !== null ? <strong>#{me.rank} in the race · </strong> : null}
            Score: <strong>{teamScoreText(me.scorePct, me.scored, view.limits.minScored)}</strong>
          </p>
          <ul className="team-members" data-testid="team-members">
            {me.memberList.map((m) => (
              <li className="team-member" key={m.username} data-testid={`team-member-${m.username}`}>
                <PlayerName username={m.username} name={m.displayName} />
                {m.leader && (
                  <span className="team-leader" title="Leader" aria-label="Leader">
                    👑
                  </span>
                )}
                <span className={`team-gain mono${m.gainPct !== null && m.gainPct > 0 ? ' pos' : m.gainPct !== null && m.gainPct < 0 ? ' neg' : ''}`}>{m.gainPct === null ? 'not on the board yet' : signedPercent(m.gainPct)}</span>
                {me.iAmLeader && m.username !== user.username && (
                  <span className="team-member-act">
                    {confirming === `kick-${m.username}` ? (
                      <>
                        <button type="button" className="btn btn-small btn-buy" disabled={busy} onClick={() => void run(() => api.teamKick(m.username))} data-testid={`team-kick-confirm-${m.username}`}>
                          Remove {m.displayName}?
                        </button>
                        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void run(() => api.teamLead(m.username))} data-testid={`team-lead-${m.username}`}>
                          Make leader
                        </button>
                        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setConfirming(`kick-${m.username}`)} data-testid={`team-kick-${m.username}`}>
                          Remove
                        </button>
                      </>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>

          {me.iAmLeader && (
            <div className="team-leader-tools" data-testid="team-leader-tools">
              <form
                className="team-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (invitee.trim() === '') return;
                  void run(() => api.teamInvite(invitee.trim()), () => setInvitee(''));
                }}
              >
                <label>
                  <span className="muted">Invite a player</span>
                  <input type="text" value={invitee} maxLength={20} placeholder="username" autoComplete="off" onChange={(e) => setInvitee(e.target.value)} data-testid="team-invite-input" />
                </label>
                <button type="submit" className="btn btn-small" disabled={busy || invitee.trim() === ''} data-testid="team-invite-send">
                  Invite
                </button>
              </form>
              {me.invited.length > 0 && (
                <p className="hint" data-testid="team-invited">
                  Waiting for an answer: {me.invited.map((i) => i.username).join(', ')}
                </p>
              )}
              <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void run(() => api.teamOpen(!me.open))} data-testid="team-toggle-open">
                {me.open ? 'Make it invite only' : 'Open it to everyone'}
              </button>
            </div>
          )}

          <div className="team-actions">
            {confirming === 'leave' ? (
              <>
                <button type="button" className="btn btn-small btn-buy" disabled={busy} onClick={() => void run(() => api.teamLeave())} data-testid="team-leave-confirm">
                  Yes, leave the team
                </button>
                <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setConfirming('leave')} data-testid="team-leave">
                Leave team
              </button>
            )}
            {me.iAmLeader &&
              (confirming === 'disband' ? (
                <>
                  <button type="button" className="btn btn-small btn-buy" disabled={busy} onClick={() => void run(() => api.teamDisband())} data-testid="team-disband-confirm">
                    Yes, end the team for everybody
                  </button>
                  <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setConfirming('disband')} data-testid="team-disband">
                  End the team
                </button>
              ))}
          </div>
        </section>
      )}

      {!me && (
        <section className="card team-new" aria-label="Start a team" data-testid="team-new">
          <h3>Start a team</h3>
          <form
            className="team-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.teamCreate(name, tag, openNew), () => {
                setName('');
                setTag('');
              });
            }}
          >
            <label>
              <span className="muted">Name ({view.limits.nameMin} to {view.limits.nameMax} characters)</span>
              <input type="text" value={name} maxLength={view.limits.nameMax} autoComplete="off" onChange={(e) => setName(e.target.value)} data-testid="team-name-input" />
            </label>
            <label>
              <span className="muted">Tag ({view.limits.tagMin} to {view.limits.tagMax} letters or numbers)</span>
              <input type="text" value={tag} maxLength={view.limits.tagMax} autoComplete="off" onChange={(e) => setTag(e.target.value)} data-testid="team-tag-input" />
            </label>
            <label className="team-check">
              <input type="checkbox" checked={openNew} onChange={(e) => setOpenNew(e.target.checked)} data-testid="team-open-input" /> Anyone can join
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy || name.trim() === '' || tag.trim() === ''} data-testid="team-create">
              Start the team
            </button>
          </form>
        </section>
      )}

      {!me && view.invites.length > 0 && (
        <section className="card team-invites" aria-label="Invitations" data-testid="team-invites">
          <h3>Invitations</h3>
          <ul className="team-list">
            {view.invites.map((i) => (
              <li key={i.teamId} className="team-row" data-testid={`team-invite-${i.teamId}`}>
                <span>
                  <strong className="team-tag">[{i.tag}]</strong> {i.name} <span className="muted">· {i.members} player{i.members === 1 ? '' : 's'}</span>
                </span>
                <span className="team-row-act">
                  <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void run(() => api.teamJoin(i.teamId))} data-testid={`team-invite-join-${i.teamId}`}>
                    Join
                  </button>
                  <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void run(() => api.teamDecline(i.teamId))} data-testid={`team-invite-no-${i.teamId}`}>
                    No thanks
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card team-race" aria-label="The race" data-testid="team-race">
        <h3>
          The race <span className="h2-note">{view.total} team{view.total === 1 ? '' : 's'}</span>
        </h3>
        {view.teams.length === 0 ? (
          <p className="muted" data-testid="team-none">
            No teams yet. Be the first to start one.
          </p>
        ) : (
          <ol className="team-list team-race-list">
            {view.teams.map((t) => (
              <li key={t.id} className={`team-row${t.you ? ' is-mine' : ''}`} data-testid={`team-row-${t.id}`}>
                <span className="team-rank mono">{t.rank === null ? '—' : `#${t.rank}`}</span>
                <span className="team-who">
                  <strong className="team-tag">[{t.tag}]</strong> {t.name}
                  <span className="muted">
                    {' '}
                    · {t.members} player{t.members === 1 ? '' : 's'} · led by {t.leader}
                    {t.open ? '' : ' · invite only'}
                  </span>
                </span>
                <span className={`team-score-cell mono${t.scorePct !== null && t.scorePct > 0 ? ' pos' : t.scorePct !== null && t.scorePct < 0 ? ' neg' : ''}`}>{t.scorePct === null ? `${t.scored}/${view.limits.minScored}` : signedPercent(t.scorePct)}</span>
                {joinable(t) && (
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(() => api.teamJoin(t.id))} data-testid={`team-join-${t.id}`}>
                    Join
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
        <p className="hint">A team shows the number of its players on the weekly board until it has {view.limits.minScored}; then it gets a score and a place.</p>
      </section>

      {view.lastWeek && (
        <section className="card team-last" aria-label="Last week" data-testid="team-last">
          <h3>Last week's best teams</h3>
          <ol className="team-list">
            {view.lastWeek.places.map((p) => (
              <li key={p.place} className="team-row">
                <span className="team-rank mono">#{p.place}</span>
                <span className="team-who">
                  <strong className="team-tag">[{p.teamTag}]</strong> {p.teamName} <span className="muted">· {p.members} players</span>
                </span>
                <span className="team-score-cell mono pos">{signedPercent(p.scorePct)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
