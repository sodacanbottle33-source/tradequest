// The trophy room (docs/world.md §36). A signed-in player can look at the trophy room of any real player who is not banned (like the profile card). Everything is read from what
// the game already keeps (server/trophies.ts); this route only asks.

import { HttpError } from '../http';
import type { Router } from '../router';
import type { Services } from '../services';
import { SocialError } from '../social';

export function registerTrophyRoutes(router: Router, s: Services): void {
  const { social, trophies } = s;

  router.get('/api/trophies/:username', (ctx) => {
    ctx.requireUser();
    try {
      const p = social.playerRef(ctx.params.username ?? '');
      return trophies.roomOf(p.id, p.username, p.displayName);
    } catch (error) {
      if (error instanceof SocialError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  });
}
