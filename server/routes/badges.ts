// Achievement badges. A signed-in player reads his own Badges page (every badge, which ones he has, how many players have each); the badges of other
// players show only as the few icons next to their name in the player list (server/social.ts). Giving badges is done by the server (server/badges.ts).

import type { Router } from '../router';
import type { Services } from '../services';

export function registerBadgeRoutes(router: Router, s: Services): void {
  router.get('/api/badges', (ctx) => s.badges.view(ctx.requireUser()));
}
