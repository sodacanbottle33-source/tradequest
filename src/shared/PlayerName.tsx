// A player's name as everybody sees it (docs/world.md §29): in the colour and glow he bought in the Shop, with his title under it, and a click opens his profile
// card. A player who wears nothing gets a plain bold name (inside the same click target), exactly as before the Shop existed.
import { nameClasses, titleOf } from './cosmeticCatalog';
import { useProfiles } from './profileStore';
import { sharedStore } from './store';

export function PlayerName({ username, name, link = true, className }: { username: string; name: string; link?: boolean; className?: string }) {
  const { looks } = useProfiles();
  const look = looks[username];
  const classes = nameClasses(look);
  const title = titleOf(look);
  const label = <strong className={['pname', classes, className].filter(Boolean).join(' ')}>{name}</strong>;
  const body = link ? (
    <button type="button" className="pname-btn" onClick={() => sharedStore.openProfile(username)} title={`Open ${name}'s profile`} data-testid={`profile-open-${username}`}>
      {label}
    </button>
  ) : (
    label
  );
  if (title === null) return body;
  return (
    <span className="pname-wrap">
      {body}
      <span className="ptitle" data-testid={`title-${username}`}>
        {title}
      </span>
    </span>
  );
}
