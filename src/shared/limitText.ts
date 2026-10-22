// The words of limit orders: how an order is called in a list, how long it has left, and the pop-up when it fills or ends.
// The server decides everything; this only turns its answers into sentences.
import { formatCents } from './format';
import type { ToastText } from './positionNotice';
import type { GoodFor, LimitOrder } from './types';

export const GOOD_FOR_CHOICES: readonly { value: GoodFor; label: string }[] = [
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
  { value: '3d', label: '3 days' },
];

const KIND_LABEL: Readonly<Record<LimitOrder['kind'], string>> = { buy: 'Buy', sell: 'Sell', short: 'Short', cover: 'Cover' };
const KIND_VERB: Readonly<Record<LimitOrder['kind'], string>> = { buy: 'buy', sell: 'sell', short: 'short', cover: 'buy back' };

export function kindLabel(kind: LimitOrder['kind']): string {
  return KIND_LABEL[kind];
}

/** A buy or cover waits for the price to fall to its limit, a sell or short for it to rise to it. */
export function limitDirection(kind: LimitOrder['kind']): 'lower' | 'higher' {
  return kind === 'buy' || kind === 'cover' ? 'lower' : 'higher';
}

const shares = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'share' : 'shares'}`;

/** "buy 10 shares of PEPE at $12.00 or lower" */
export function describeOrder(o: LimitOrder): string {
  const lev = o.leverage > 1 ? ` with ${o.leverage}x leverage` : '';
  return `${KIND_VERB[o.kind]} ${shares(o.qty)} of ${o.ticker} at ${formatCents(o.limitCents)} or ${limitDirection(o.kind)}${lev}`;
}

/** Seconds → "40 min", "5 h 12 min", "2 days 3 h". */
export function timeLeft(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return 'under a minute';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

/** How long an open order still waits (the market's own clock: one tick is one second). */
export function expiryText(o: LimitOrder, tick: number): string {
  const left = o.expiresTick - tick;
  return left > 0 ? `${timeLeft(left)} left` : 'ending';
}

/** What the player is told when an order fills (all or part of it) or ends. */
export function describeLimitEvent(what: 'fill' | 'ended', o: LimitOrder): ToastText {
  const avg = o.avgFillCents !== null ? ` at an average of ${formatCents(o.avgFillCents)}` : '';
  if (what === 'fill') {
    if (o.state === 'filled') {
      return { tone: 'good', title: 'Limit order filled', text: `Your order to ${describeOrder(o)} filled: ${shares(o.filled)}${avg}.` };
    }
    return {
      tone: 'good',
      title: 'Limit order partly filled',
      text: `${shares(o.filled)} of ${o.qty.toLocaleString('en-US')} filled${avg} (order: ${describeOrder(o)}). The rest is still waiting.`,
    };
  }
  const got = o.filled > 0 ? ` ${shares(o.filled)} filled${avg} before it ended.` : '';
  if (o.state === 'expired') {
    return { tone: 'neutral', title: 'Limit order expired', text: `Your order to ${describeOrder(o)} ran out of time without the price getting there.${got}` };
  }
  return { tone: 'neutral', title: 'Limit order ended', text: `Your order to ${describeOrder(o)} ended. ${o.reason}${got ? ` ${got.trim()}` : ''}`.trim() };
}
