// The pop-up text for positions the market closed by itself, and the store that holds the pop-ups.
import { describe, expect, it } from 'vitest';
import { describeNotice } from '../src/shared/positionNotice';
import { SharedStore } from '../src/shared/store';
import type { PositionNotice } from '../src/shared/types';

const base: PositionNotice = { reason: 'liquidated', account: 'career', ticker: 'PEPE', short: false, shares: 10, priceCents: 1234, realizedCents: -50_000, tick: 5 };

describe('position pop-ups', () => {
  it('TOAST-1 a liquidation says "You were liquidated" and the loss', () => {
    const t = describeNotice(base);
    expect(t.tone).toBe('bad');
    expect(t.title).toBe('You were liquidated');
    expect(t.text.includes('PEPE')).toBe(true);
    expect(t.text.includes('$500.00')).toBe(true);
    expect(t.text.includes('long')).toBe(true);
  });

  it('TOAST-2 a liquidated short is called a short, and a match is named', () => {
    const t = describeNotice({ ...base, short: true, account: 'match' });
    expect(t.text.includes('short')).toBe(true);
    expect(t.text.includes('1v1 match')).toBe(true);
  });

  it('TOAST-3 a take-profit with a gain is good news, a stop-loss with a loss is bad', () => {
    const take = describeNotice({ ...base, reason: 'take', realizedCents: 12_345 });
    expect(take.tone).toBe('good');
    expect(take.title).toBe('Take-profit hit');
    expect(take.text.includes('+$123.45')).toBe(true);
    expect(take.text.includes('sold')).toBe(true);
    const stop = describeNotice({ ...base, reason: 'stop', realizedCents: -2_000, short: true });
    expect(stop.tone).toBe('bad');
    expect(stop.title).toBe('Stop-loss hit');
    expect(stop.text.includes('bought back')).toBe(true);
    expect(stop.text.includes('−$20.00')).toBe(true);
  });

  it('TOAST-4 one share is "1 share"; zero result is neutral', () => {
    const t = describeNotice({ ...base, reason: 'stop', shares: 1, realizedCents: 0 });
    expect(t.tone).toBe('neutral');
    expect(t.text.includes('1 share ')).toBe(true);
  });

  it('TOAST-6 a margin call is a warning: it says how much is lost, where the market closes the position, and to sell to keep what is left', () => {
    const t = describeNotice({ ...base, reason: 'margin_call', realizedCents: -7_500, priceCents: 9_100, liqPriceCents: 9_000, leverage: 10 });
    expect(t.tone).toBe('bad');
    expect(t.title).toBe('Margin call');
    expect(t.text.includes('PEPE')).toBe(true);
    expect(t.text.includes('−$75.00')).toBe(true);
    expect(t.text.includes('or below $90.00')).toBe(true);
    expect(t.text.includes('Sell')).toBe(true);
    // A short is closed at or above its price; a warning without a price says nothing about one.
    const short = describeNotice({ ...base, reason: 'margin_call', short: true, realizedCents: -100, liqPriceCents: 1_500 });
    expect(short.text.includes('short')).toBe(true);
    expect(short.text.includes('or above $15.00')).toBe(true);
    expect(describeNotice({ ...base, reason: 'margin_call', realizedCents: -100 }).text.includes('The market closes it')).toBe(false);
  });

  it('TOAST-5 the store keeps the newest five, closes one on request and lets them expire', async () => {
    const store = new SharedStore();
    for (let i = 0; i < 7; i++) store.addToast({ ...base, tick: i }, 150);
    expect(store.getSnapshot().toasts.length).toBe(5);
    expect(store.getSnapshot().toasts[0]?.id).toBe(3);
    store.dismissToast(3);
    expect(store.getSnapshot().toasts.length).toBe(4);
    store.dismissToast(999); // unknown: nothing happens
    expect(store.getSnapshot().toasts.length).toBe(4);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(store.getSnapshot().toasts.length).toBe(0);
  });
});
