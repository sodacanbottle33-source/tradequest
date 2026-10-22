// Small helpers for the owner's admin screens.

/** A fresh id for one admin action. The server keeps it, so sending the same request twice can never act twice. */
export function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `adm-${c.randomUUID()}`;
  return `adm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

/** "250", "1,000.50" → cents (25000, 100050). Null if it is not a plain positive amount with at most two decimals. */
export function dollarsToCents(text: string): number | null {
  const t = text.trim().replace(/^\$/, '').replace(/,/g, '');
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number(((m[2] ?? '') + '00').slice(0, 2));
  return cents > 0 ? cents : null;
}

/** Parses a typed percentage like "-90", "+100" or "−90" (with the typographic minus). Null if it is not a number. */
export function parsePercent(text: string): number | null {
  const t = text.trim().replace(/−/g, '-').replace(/%$/, '').trim();
  if (!/^[+-]?\d{1,4}(\.\d{1,2})?$/.test(t)) return null;
  return Number(t);
}

export function whenText(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
