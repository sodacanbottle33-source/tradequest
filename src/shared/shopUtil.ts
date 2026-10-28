// The words of the Shop and the profile card (docs/world.md §29). Plain functions, so they can be tested without drawing anything. The server decides who may buy
// what; these only say, in words, why the page already knows a Buy would be refused (the server checks again anyway).
import { badgeById } from './badgeCatalog';
import { priceOf, priceText, type CosmeticDef } from './cosmeticCatalog';
import type { PlayerProfile, ShopView } from './types';

/** Why a thing cannot be bought right now (a badge missing, or not enough cash), or null when it can. */
export function lockReason(def: CosmeticDef, view: Pick<ShopView, 'cashCents' | 'badges'>): string | null {
  if (def.requiresBadge !== undefined && !view.badges.includes(def.requiresBadge)) {
    return `Needs the "${badgeById(def.requiresBadge)?.name ?? def.requiresBadge}" badge`;
  }
  if (view.cashCents < priceOf(def)) return `You need ${priceText(priceOf(def) - view.cashCents)} more`;
  return null;
}

/** "5 March 2026" (the day he joined). */
export function joinedText(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "Rank #3 of 120", or why there is no rank (the owner and players who cannot be ranked). */
export function rankText(p: Pick<PlayerProfile, 'rank' | 'rankedCount'>): string {
  return p.rank === null ? 'Not on the leaderboard' : `Rank #${p.rank} of ${p.rankedCount}`;
}

/** What a buy did to the player, in words. */
export function boughtText(name: string, priceCents: number): string {
  return `You bought ${name} for ${priceText(priceCents)}, and it is on now. The money is gone, so your net worth went down by that much.`;
}
