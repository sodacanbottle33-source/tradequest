// Small pure helpers for the picture of a stock or memecoin (the letters and colour shown while a company has no picture).

/** One letter for a small logo, two for a big one. */
export function logoLetters(ticker: string, size: number): string {
  const chars = Array.from(ticker.trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase());
  if (chars.length === 0) return '?';
  return chars.slice(0, size >= 40 ? 2 : 1).join('');
}

/** A colour that is always the same for the same ticker, readable with white letters on the dark and the light page. */
export function logoColour(ticker: string): string {
  let h = 0;
  for (const ch of ticker) h = (h * 37 + (ch.codePointAt(0) ?? 0)) % 360;
  return `hsl(${h} 45% 34%)`;
}
