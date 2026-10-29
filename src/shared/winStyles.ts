// The Shop's win styles (docs/world.md §30): how the party looks when the player closes a trade with a profit or launches a company. Only the player himself sees his own party,
// so a style is only a different set of colours, little pictures and places for the confetti, and a colour for the banner. It never changes whether, when or how big a
// celebration is (src/shared/winCelebration.ts decides that from the trade), and the flying parts are the same as without a style (src/ui/hype.ts).
import type { Piece } from '../ui/hype';

export interface WinStyleSpec {
  /** The colours the confetti takes, in turn. */
  readonly palette: readonly string[];
  /** When set, small pictures (emoji) fly instead of coloured bits. */
  readonly glyphs?: readonly string[];
  /** From how many places the confetti bursts: the middle of the screen only, or three (left, middle, right) one after the other, like fireworks. */
  readonly origins?: 1 | 3;
  /** A class on the whole party for the colours of its big number. */
  readonly banner?: string;
}

export const WIN_STYLES: Readonly<Record<string, WinStyleSpec>> = {
  ws_gold: { palette: ['#f5b83d', '#fde68a', '#fbbf24', '#fff7d6', '#d99a1a'], banner: 'ws-gold' },
  ws_candy: { palette: ['#f472b6', '#c084fc', '#60a5fa', '#fb7185', '#f9a8d4', '#fde68a'], banner: 'ws-candy' },
  ws_coins: { palette: ['#f5b83d', '#fde68a'], glyphs: ['🪙'], banner: 'ws-gold' },
  ws_stars: { palette: ['#fde68a', '#ffffff'], glyphs: ['⭐', '✨', '🌟'], banner: 'ws-stars' },
  ws_fireworks: { palette: ['#ef4444', '#f5b83d', '#22c55e', '#60a5fa', '#c084fc', '#ffffff', '#f472b6'], origins: 3 },
  ws_neon: { palette: ['#00ffa3', '#22d3ee', '#ff2d95', '#a3e635'], banner: 'ws-neon' },
  ws_diamond: { palette: ['#e0f2fe', '#67e8f9', '#ffffff', '#a5f3fc'], glyphs: ['💎'], banner: 'ws-diamond' },
  ws_royal: { palette: ['#fde68a', '#f5b83d', '#a78bfa', '#7c3aed'], glyphs: ['👑', '💰'], banner: 'ws-royal' },
};

/** The look of a win style, or null for an id nobody has heard of (so a made-up or old id gives the plain party). */
export function winStyleOf(id: string | undefined | null): WinStyleSpec | null {
  if (id === undefined || id === null) return null;
  return Object.prototype.hasOwnProperty.call(WIN_STYLES, id) ? (WIN_STYLES[id] as WinStyleSpec) : null;
}

/** A confetti piece as drawn: the colour, the little picture if any, and which of the places it flies from (0 = the middle). */
export interface StyledPiece extends Piece {
  readonly glyph?: string;
  readonly origin: 0 | 1 | 2;
}

/**
 * The pieces of a party in the player's style: the same flight (where to, how far, how long) as the plain party, with his colours or pictures. Fireworks send a third of the
 * pieces from each of three places, one place a little after the other. With no style (null) nothing changes.
 */
export function styledPieces(pieces: readonly Piece[], spec: WinStyleSpec | null): StyledPiece[] {
  if (spec === null) return pieces.map((p) => ({ ...p, origin: 0 as const }));
  const spots: readonly (0 | 1 | 2)[] = spec.origins === 3 ? [0, 1, 2] : [0];
  return pieces.map((p, i) => {
    const origin = spots[i % spots.length] as 0 | 1 | 2;
    const glyphs = spec.glyphs;
    return {
      ...p,
      color: spec.palette[i % spec.palette.length] as string,
      // The pictures come in turn too, so every kind shows up whatever the seed.
      ...(glyphs && glyphs.length > 0 ? { glyph: glyphs[i % glyphs.length] as string } : {}),
      origin,
      // The second and third place go off a little later, like rockets one after the other.
      delay: p.delay + origin * 260,
    };
  });
}
