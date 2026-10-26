// The small tag next to a name that shows what the person is: "Owner" or "Mod" (a moderator the owner chose). Ordinary players have no tag.
// What a role may do is decided by the server; this only shows it.
import type { Role } from './types';

export function RoleBadge({ role, testId }: { role: Role; testId?: string }) {
  if (role === 'owner') {
    return (
      <span className="badge-owner" data-testid={testId}>
        Owner
      </span>
    );
  }
  if (role === 'moderator') {
    return (
      <span className="badge-mod" title="Moderator: can kick and ban ordinary players and look after the public chat" data-testid={testId}>
        Mod
      </span>
    );
  }
  return null;
}
