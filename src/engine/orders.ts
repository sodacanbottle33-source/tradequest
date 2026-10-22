// Order types and quantity parsing — see docs/rules.md §6.

import { MAX_ORDER_QTY } from './constants';

export type Side = 'BUY' | 'SELL';

export interface PendingOrder {
  readonly side: Side;
  readonly quantity: number;
  /** Index k when the order was submitted. */
  readonly submittedAt: number;
}

export type QuantityResult = { ok: true; value: number } | { ok: false; reason: string };

const WHOLE_POSITIVE = /^[1-9][0-9]*$/;

/** Parses the quantity text box (§6.2 rule 2). */
export function parseQuantity(text: string): QuantityResult {
  if (!WHOLE_POSITIVE.test(text)) {
    return { ok: false, reason: 'Enter a whole number of shares (1 or more), digits only.' };
  }
  // Longer than 7 digits is always above MAX_ORDER_QTY; check length first so huge inputs never become numbers.
  const value = text.length > 7 ? Infinity : Number(text);
  if (value > MAX_ORDER_QTY) {
    return { ok: false, reason: `The maximum order size is ${MAX_ORDER_QTY.toLocaleString('en-US')} shares.` };
  }
  return { ok: true, value };
}

export function describeOrder(side: Side, quantity: number): string {
  return `${side} ${quantity}`;
}
