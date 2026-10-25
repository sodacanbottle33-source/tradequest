// A player's profile picture (or, without one, a coloured circle with the first letter of the name) and the green "online" dot.
// Pictures come from the server (/api/avatar/<username>); the page learns who has one from src/shared/profileStore.ts.
import { useEffect, useState } from 'react';
import { avatarUrl, profileStore, useProfiles } from './profileStore';

/** A colour that is always the same for the same name, readable with white text on the dark and the light page. */
export function colourOf(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return `hsl(${h} 42% 36%)`;
}

export function initialOf(name: string): string {
  const first = Array.from(name.trim().replace(/^@+/, ''))[0];
  return first ? first.toUpperCase() : '?';
}

/** The round picture of one player. `size` is in pixels. */
export function Avatar({ username, displayName, size = 28, className }: { username: string; displayName?: string; size?: number; className?: string }) {
  const { avatars } = useProfiles();
  const version = avatars[username];
  const [failed, setFailed] = useState(false);
  // A new picture (or a removed one) gives the browser another chance.
  useEffect(() => setFailed(false), [version]);
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.45)) };
  if (version !== undefined && !failed) {
    return <img className={className ? `pfp ${className}` : 'pfp'} src={avatarUrl(username, version)} alt="" width={size} height={size} style={style} onError={() => setFailed(true)} data-testid={`avatar-${username}`} />;
  }
  return (
    <span className={className ? `pfp pfp-letter ${className}` : 'pfp pfp-letter'} style={{ ...style, background: colourOf(username) }} aria-hidden="true" data-testid={`avatar-${username}`}>
      {initialOf(displayName ?? username)}
    </span>
  );
}

/** A small green dot when the player has a page open. Shows nothing for a player who is away. The screen that shows it calls useOnlineWatch(). */
export function OnlineDot({ username }: { username: string }) {
  const { online } = useProfiles();
  if (!online.has(username)) return null;
  return <span className="online-dot" role="img" aria-label="Online" title="Online now" data-testid={`online-${username}`} />;
}

/** A screen that shows online dots calls this: the list is fetched while the screen is open. */
export function useOnlineWatch(): void {
  useEffect(() => profileStore.watchOnline(), []);
}

/** The picture and the name of a player side by side, with the online dot. */
export function Person({ username, displayName, size = 24 }: { username: string; displayName: string; size?: number }) {
  return (
    <span className="person">
      <span className="pfp-wrap">
        <Avatar username={username} displayName={displayName} size={size} />
        <OnlineDot username={username} />
      </span>
      <strong>{displayName}</strong>
    </span>
  );
}
