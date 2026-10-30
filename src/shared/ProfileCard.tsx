// A player's profile card (docs/world.md §29): opens when a name is clicked anywhere (Players, Chat, Messages, the Shop). It shows the picture with its frame, the
// name in its colour and glow with its title, the net worth and place on the leaderboard, the day he joined, every badge he earned and what he wears. The server
// decides what a player may see of another one (a banned, unknown or computer player has no card); this page only shows what it answers.
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Avatar, OnlineDot, useOnlineWatch } from './Avatar';
import { BadgeIcon } from './BadgeIcon';
import { BADGES } from './badgeCatalog';
import { bannerClass, cosmeticById, PROFILE_SLOTS, SLOTS } from './cosmeticCatalog';
import { trophyFacts, trophyLines } from './extrasUtil';
import { petLabel } from './petCatalog';
import { formatCents } from './format';
import { PlayerName } from './PlayerName';
import { relationLabel, problemText } from './playersUtil';
import { useProfiles } from './profileStore';
import { RoleBadge } from './RoleBadge';
import { joinedText, rankText } from './shopUtil';
import { Skeleton } from './Skeleton';
import { sharedStore, useShared } from './store';
import type { PlayerProfile, TrophyRoom } from './types';

export function ProfileCard({ onShop }: { onShop: () => void }) {
  const { profileFor, user } = useShared();
  if (profileFor === null || !user) return null;
  return <Card key={profileFor} username={profileFor} mine={profileFor === user.username} onShop={onShop} />;
}

function Card({ username, mine, onShop }: { username: string; mine: boolean; onShop: () => void }) {
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The trophy room is a nicety: if it can not be loaded the rest of the card still shows.
  const [trophies, setTrophies] = useState<TrophyRoom | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  const { looks } = useProfiles();
  useOnlineWatch();

  useEffect(() => {
    let alive = true;
    api
      .playerProfile(username)
      .then((p) => {
        if (alive) setProfile(p);
      })
      .catch((e: unknown) => {
        if (alive) setError(problemText(e));
      });
    return () => {
      alive = false;
    };
  }, [username]);

  useEffect(() => {
    let alive = true;
    api
      .trophies(username)
      .then((t) => {
        if (alive) setTrophies(t);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [username]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') sharedStore.closeProfile();
    };
    document.addEventListener('keydown', onKey);
    close.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const look = looks[username];
  const worn = [...SLOTS, ...PROFILE_SLOTS]
    .map((slot) => {
      const id = look?.[slot.id];
      const def = id === undefined ? undefined : cosmeticById(id);
      // A pet is shown with how far it has grown.
      return def ? { slot: slot.label, name: slot.id === 'pet' ? petLabel(def.id, look?.petStage ?? 0) : def.name, rarity: def.rarity } : null;
    })
    .filter((x): x is { slot: string; name: string; rarity: 1 | 2 | 3 | 4 } => x !== null);
  const banner = bannerClass(look);

  return (
    <div
      className="modal-backdrop"
      data-testid="profile-card"
      onMouseDown={(e: { target: unknown; currentTarget: unknown }) => {
        if (e.target === e.currentTarget) sharedStore.closeProfile();
      }}
    >
      <div className="modal profile-card" role="dialog" aria-modal="true" aria-label={`Profile of ${profile?.displayName ?? username}`}>
        <button type="button" ref={close} className="modal-close btn btn-small btn-ghost" onClick={() => sharedStore.closeProfile()} aria-label="Close" data-testid="profile-close">
          ✕
        </button>
        {error && (
          <p className="notice error" role="alert" data-testid="profile-error">
            {error}
          </p>
        )}
        {!profile && !error && (
          <div data-testid="profile-loading">
            <Skeleton rows={4} />
          </div>
        )}
        {profile && (
          <>
            {banner !== '' && <div className={`profile-banner pbanner ${banner}`} aria-hidden="true" data-testid="profile-banner" />}
            <div className={banner === '' ? 'profile-top' : 'profile-top has-banner'}>
              <span className="pfp-wrap profile-pic">
                <Avatar username={profile.username} displayName={profile.displayName} size={84} />
                <OnlineDot username={profile.username} />
              </span>
              <div className="profile-who">
                <PlayerName username={profile.username} name={profile.displayName} link={false} className="profile-name" />
                <span className="muted profile-handle">@{profile.username}</span>
                <span className="profile-role">
                  <RoleBadge role={profile.role} />
                  {!mine && profile.relation !== 'none' && <span className="rel-chip" data-testid="profile-relation">{relationLabel(profile.relation)}</span>}
                  {trophies?.team && (
                    <span className="team-chip" title={trophies.team.name} data-testid="profile-team">
                      [{trophies.team.tag}] {trophies.team.name}
                    </span>
                  )}
                </span>
              </div>
            </div>

            <dl className="profile-facts">
              <div>
                <dt>Net worth</dt>
                <dd className="mono" data-testid="profile-networth">
                  {profile.netWorthCents === null ? '—' : formatCents(profile.netWorthCents)}
                </dd>
              </div>
              <div>
                <dt>Leaderboard</dt>
                <dd data-testid="profile-rank">{rankText(profile)}</dd>
              </div>
              <div>
                <dt>Joined</dt>
                <dd data-testid="profile-joined">{joinedText(profile.memberSinceMs)}</dd>
              </div>
            </dl>

            <section aria-label="Badges">
              <h3>
                Badges <span className="h2-note" data-testid="profile-badge-count">{profile.badges.length} of {BADGES.length}</span>
              </h3>
              {profile.badges.length === 0 ? (
                <p className="muted">No badges yet.</p>
              ) : (
                <div className="profile-badges" data-testid="profile-badges">
                  {profile.badges.map((id) => (
                    <BadgeIcon key={id} id={id} />
                  ))}
                </div>
              )}
            </section>

            {trophies && (
              <section aria-label="Trophy room" className="trophy-room" data-testid="trophy-room">
                <h3>
                  Trophy room <span className="h2-note" data-testid="trophy-count">{trophies.count} trophies</span>
                </h3>
                {trophyLines(trophies).length === 0 ? (
                  <p className="muted">No trophies yet.</p>
                ) : (
                  <ul className="trophy-list" data-testid="trophy-list">
                    {trophyLines(trophies).map((t) => (
                      <li key={t.key}>
                        <span className="trophy-icon" aria-hidden="true">
                          {t.icon}
                        </span>
                        <span>{t.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <dl className="profile-facts trophy-facts" data-testid="trophy-facts">
                  {trophyFacts(trophies).map((f) => (
                    <div key={f.key}>
                      <dt>{f.label}</dt>
                      <dd>{f.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            <section aria-label="What he wears">
              <h3>Looks</h3>
              {worn.length === 0 ? (
                <p className="muted">Nothing from the Shop yet.</p>
              ) : (
                <ul className="profile-worn" data-testid="profile-worn">
                  {worn.map((w) => (
                    <li key={w.slot} className={`rar-chip rar-${w.rarity}`}>
                      {w.name}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="profile-actions">
              {mine ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    sharedStore.closeProfile();
                    onShop();
                  }}
                  data-testid="profile-shop"
                >
                  Open the Shop
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    sharedStore.closeProfile();
                    sharedStore.startCompose(profile.username);
                  }}
                  data-testid="profile-message"
                >
                  Message
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
