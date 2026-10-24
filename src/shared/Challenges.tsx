// Friend 1v1 challenges: the banner that shows a challenge wherever the player is, the button that sends one, and the "Play a friend"
// card of the 1v1 screen. The server decides who may challenge whom, whether the friend is online and when a challenge runs out;
// this only asks and shows what it answered. Time left is counted down from the market's tick stream.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { leftText, msLeftNow } from './challengeUtil';
import { problemText } from './playersUtil';
import { sharedStore, useShared } from './store';
import type { ChallengeAction } from './types';

/** Sends one challenge action and hands the answer (your challenges, and the lobby after a yes) to the store. */
export function useChallengeActions() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (what: ChallengeAction, username: string): Promise<boolean> => {
    setBusy(`${what}:${username}`);
    setError(null);
    try {
      const out = await api.challengeAction(what, username);
      sharedStore.setChallenges(out, out.match);
      return true;
    } catch (e) {
      setError(problemText(e));
      void sharedStore.refreshChallenges();
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, run };
}
export type ChallengeActions = ReturnType<typeof useChallengeActions>;

/** The button next to a friend: challenge him, or (when a challenge is open between you) answer or take it back. */
export function ChallengeButton({ username, actions }: { username: string; actions: ChallengeActions }) {
  const { challenges } = useShared();
  const busy = actions.busy !== null;
  const sent = challenges?.outgoing.find((e) => e.username === username);
  const received = challenges?.incoming.find((e) => e.username === username);
  if (sent) {
    return (
      <span className="people-actions">
        <span className="muted">Challenge sent</span>
        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void actions.run('cancel', username)} data-testid={`challenge-cancel-${username}`}>
          Cancel
        </button>
      </span>
    );
  }
  if (received) {
    return (
      <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void actions.run('accept', username)} data-testid={`challenge-accept-${username}`}>
        Accept challenge
      </button>
    );
  }
  const elsewhere = (challenges?.outgoing.length ?? 0) > 0;
  return (
    <button
      type="button"
      className="btn btn-small btn-primary"
      disabled={busy || elsewhere}
      title={elsewhere ? 'You already challenged another friend. Wait for the answer or cancel it first.' : undefined}
      onClick={() => void actions.run('send', username)}
      data-testid={`challenge-${username}`}
    >
      Challenge to 1v1
    </button>
  );
}

/** Shown on every screen: challenges waiting for your answer, the one you sent, and a line when one ended without a match. */
export function ChallengeBanner() {
  const { user, challenges, challengesTick, tick, challengeNote } = useShared();
  const actions = useChallengeActions();
  const incoming = (challenges?.incoming ?? []).map((e) => ({ e, left: msLeftNow(e, challengesTick, tick) }));
  const outgoing = (challenges?.outgoing ?? []).map((e) => ({ e, left: msLeftNow(e, challengesTick, tick) }));
  const expired = [...incoming, ...outgoing].filter((x) => x.left <= 0).length;
  // A challenge whose time is up disappears at once; the server is asked once to make sure the list agrees.
  useEffect(() => {
    if (expired > 0) void sharedStore.refreshChallenges(true);
  }, [expired]);
  const open = incoming.filter((x) => x.left > 0);
  const mine = outgoing.filter((x) => x.left > 0);
  if (!user || (open.length === 0 && mine.length === 0 && !challengeNote && !actions.error)) return null;
  const busy = actions.busy !== null;
  return (
    <div className="challenge-banner" role="region" aria-label="Friend challenges" data-testid="challenge-banner">
      {open.map(({ e, left }) => (
        <p key={`in-${e.username}`} className="notice info challenge-row" role="status" data-testid={`challenge-incoming-${e.username}`}>
          <span>
            <strong>{e.displayName}</strong> challenges you to a 1v1 <span className="muted">· {leftText(left)} left</span>
          </span>
          <span className="people-actions">
            <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void actions.run('accept', e.username)} data-testid={`banner-accept-${e.username}`}>
              Accept
            </button>
            <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void actions.run('decline', e.username)} data-testid={`banner-decline-${e.username}`}>
              Decline
            </button>
          </span>
        </p>
      ))}
      {mine.map(({ e, left }) => (
        <p key={`out-${e.username}`} className="notice info challenge-row" role="status" data-testid={`challenge-outgoing-${e.username}`}>
          <span>
            Waiting for <strong>{e.displayName}</strong> to accept your challenge <span className="muted">· {leftText(left)} left</span>
          </span>
          <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void actions.run('cancel', e.username)} data-testid={`banner-cancel-${e.username}`}>
            Cancel
          </button>
        </p>
      ))}
      {challengeNote && (
        <p className="notice info challenge-row" role="status" data-testid="challenge-note">
          <span>{challengeNote}</span>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => sharedStore.closeChallengeNote()}>
            Close
          </button>
        </p>
      )}
      {actions.error && (
        <p className="notice error" role="alert" data-testid="challenge-error">
          {actions.error}
        </p>
      )}
    </div>
  );
}

/** On the 1v1 screen: your friends, each with a Challenge button. */
export function PlayFriendCard() {
  const { friends } = useShared();
  const actions = useChallengeActions();
  return (
    <section className="card" aria-label="Play a friend" data-testid="play-friend">
      <h2>
        Play a friend <span className="h2-note">a 1v1 against someone you know</span>
      </h2>
      {actions.error && (
        <p className="notice error" role="alert">
          {actions.error}
        </p>
      )}
      {!friends && <p className="hint">Loading your friends…</p>}
      {friends && friends.friends.length === 0 && <p className="hint">You have no friends yet. Add some in Career → Players, then challenge them here.</p>}
      {friends && friends.friends.length > 0 && (
        <ul className="friend-challenge-list">
          {friends.friends.map((f) => (
            <li key={f.username} data-username={f.username}>
              <span className="player-name">{f.displayName}</span>
              <ChallengeButton username={f.username} actions={actions} />
            </li>
          ))}
        </ul>
      )}
      <p className="hint">
        Your friend must have TradeQuest open. They get your challenge right away and have 2 minutes to accept. Then the two of you get a lobby of your own, nobody else can
        join it, and you both press Ready. If one of you leaves before it starts, the match is cancelled for both.
      </p>
    </section>
  );
}
