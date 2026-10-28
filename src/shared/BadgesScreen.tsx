// The Badges page (a section of the Players tab): every achievement badge, which ones you have, when you got them, how to get the rest and how rare
// each one is. The server decides who has earned what (server/badges.ts); this page only shows its answer, and asks again when it says you earned one.
import { useEffect, useState } from 'react';
import { api } from './api';
import { BADGE_GROUPS, BADGES, TIER_NAMES, badgeById } from './badgeCatalog';
import { BadgeIcon } from './BadgeIcon';
import { earnedText, haveText, rarityText } from './badgeUtil';
import { problemText } from './playersUtil';
import { Skeleton } from './Skeleton';
import { useShared } from './store';
import type { BadgesView } from './types';

export function BadgesScreen() {
  const { user, badgesVersion } = useShared();
  const [view, setView] = useState<BadgesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const userId = user?.id ?? 0;

  useEffect(() => {
    let alive = true;
    api
      .badges()
      .then((v) => {
        if (!alive) return;
        setView(v);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(problemText(e));
      });
    return () => {
      alive = false;
    };
  }, [userId, badgesVersion]);

  const lines = new Map((view?.badges ?? []).map((b) => [b.id, b]));
  const earned = (view?.badges ?? []).filter((b) => b.earnedMs !== null && badgeById(b.id) !== undefined).length;

  return (
    <section className="card badges-card" aria-label="Badges" data-testid="badges-screen">
      <h2>
        Badges <span className="h2-note">achievements</span>
      </h2>
      {error && (
        <p className="notice error" role="alert" data-testid="badges-error">
          {error}
        </p>
      )}
      {view === null && !error && (
        <>
          <p className="hint">Loading your badges…</p>
          <Skeleton rows={4} />
        </>
      )}
      {view !== null && (
        <>
          <p className="badges-have" data-testid="badges-have">
            {haveText(earned, BADGES.length)}
          </p>
          <div className="badges-bar" role="progressbar" aria-valuemin={0} aria-valuemax={BADGES.length} aria-valuenow={earned} aria-label="Badges earned">
            <span style={{ width: `${Math.round((earned / BADGES.length) * 100)}%` }} />
          </div>
          <p className="hint">Badges are just for fun: they give no money and change no price. Your best three show next to your name in the Players list. A badge is never taken back.</p>
          {BADGE_GROUPS.map((g) => (
            <div key={g.id} className="badge-group">
              <h3 className="admin-h3">{g.label}</h3>
              <ul className="badge-grid">
                {BADGES.filter((b) => b.group === g.id).map((b) => {
                  const line = lines.get(b.id);
                  const got = line?.earnedMs != null;
                  const hidden = !got && b.secret === true;
                  return (
                    <li key={b.id} className={`${got ? 'badge-card got' : 'badge-card'}${b.secret === true ? ' secret' : ''}`} data-testid={`badge-${b.id}`} data-earned={got ? 'yes' : 'no'} data-secret={b.secret === true ? 'yes' : 'no'}>
                      <BadgeIcon id={b.id} locked={!got} large />
                      <div className="badge-info">
                        <strong>{hidden ? 'Secret badge' : b.name}</strong> <span className={`badge-tier tier-${b.tier}`}>{TIER_NAMES[b.tier]}</span>
                        {got && b.secret === true && <span className="badge-secret-tag"> Secret!</span>}
                        <div className="badge-how">{hidden ? `Hint: ${b.hint ?? 'Keep playing to find it.'}` : b.how}</div>
                        <div className="muted badge-meta">
                          {got && line?.earnedMs != null ? `Earned ${earnedText(line.earnedMs)}` : 'Not earned yet'} · {rarityText(line?.owners ?? 0, view.players)}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
