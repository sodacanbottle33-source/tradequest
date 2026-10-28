// A badge drawn as a small round medal: the icon of the badge on a ring whose colour is its tier (bronze, silver, gold, diamond). Hover or long-press
// shows its name and how to get it. `locked` greys it out (a badge the player does not have yet).
import { BADGES_SHOWN, TIER_NAMES, badgeById } from './badgeCatalog';

export function BadgeIcon({ id, locked = false, large = false }: { id: string; locked?: boolean; large?: boolean }) {
  const def = badgeById(id);
  if (!def) return null; // a badge this version of the page does not know about
  // A secret badge that is not earned yet shows as a "?" medal: its name and its way to get it stay hidden, only the hint is shown.
  const hidden = locked && def.secret === true;
  const cls = `badge-icon tier-${def.tier}${locked ? ' locked' : ''}${large ? ' large' : ''}${hidden ? ' secret' : ''}`;
  const label = hidden ? `Secret badge, ${TIER_NAMES[def.tier]}, not earned yet` : `${def.name}, ${TIER_NAMES[def.tier]} badge${locked ? ', not earned yet' : ''}`;
  const title = hidden ? `Secret badge (${TIER_NAMES[def.tier]}): ${def.hint ?? 'Keep playing to find it.'}` : `${def.name} (${TIER_NAMES[def.tier]}): ${def.how}`;
  return (
    <span className={cls} role="img" aria-label={label} title={title} data-badge={id}>
      <span aria-hidden="true">{hidden ? '❓' : def.icon}</span>
    </span>
  );
}

/** The best few badges of a player, shown next to his name in the Players list. */
export function BadgeRow({ ids }: { ids: readonly string[] | undefined }) {
  const shown = (ids ?? []).slice(0, BADGES_SHOWN);
  if (shown.length === 0) return null;
  return (
    <span className="badge-row" data-testid="badge-row">
      {shown.map((id) => (
        <BadgeIcon key={id} id={id} />
      ))}
    </span>
  );
}
