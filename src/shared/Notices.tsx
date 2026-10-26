// What the owner wants every page to show at the top: a ban notice for a player whose account was banned, "trading is paused", and
// the owner's announcement. All of it comes from the server; nothing here decides anything.
import { useState } from 'react';
import { whenText } from './adminUtil';
import { useShared } from './store';

export function Notices() {
  const s = useShared();
  const [hidden, setHidden] = useState<string | null>(null);
  const announcement = s.health?.announcement ?? null;
  const key = announcement ? `${announcement.ms}:${announcement.text}` : '';
  const paused = s.health?.paused ?? null;

  return (
    <>
      {s.banned && s.banned.kind === 'kick' && (
        <p className="notice error" role="alert" data-testid="banned-notice">
          You were kicked out for a short time{s.banned.untilMs !== null ? ` (until ${whenText(s.banned.untilMs)})` : ''}
          {s.banned.reason ? `: ${s.banned.reason}.` : '.'} You can still look at the market. You can sign in and trade again after that.
        </p>
      )}
      {s.banned && s.banned.kind !== 'kick' && (
        <p className="notice error" role="alert" data-testid="banned-notice">
          Your account is banned{s.banned.untilMs !== null ? ` until ${whenText(s.banned.untilMs)}` : ''}
          {s.banned.reason ? `: ${s.banned.reason}.` : '.'} You can still look at the market, but you cannot sign in or trade{s.banned.untilMs !== null ? ' until then' : ''}.
        </p>
      )}
      {paused && (
        <p className="notice warn" role="status" data-testid="paused-notice">
          Trading is paused{paused.reason ? `: ${paused.reason}.` : '.'} Prices keep moving, but orders are refused until the owner opens trading again.
        </p>
      )}
      {announcement && hidden !== key && (
        <aside className="announcement" role="status" aria-live="polite" data-testid="announcement">
          <span className="announcement-tag">Announcement</span>
          <span className="announcement-text">{announcement.text}</span>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setHidden(key)}>
            Dismiss
          </button>
        </aside>
      )}
    </>
  );
}
