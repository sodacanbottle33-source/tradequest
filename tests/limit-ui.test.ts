// Limit orders in the screens (docs/world.md §6.8): the words, the pop-up, and the wiring (the form only sends requests; the server decides).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOOD_FOR_CHOICES, describeLimitEvent, describeOrder, expiryText, kindLabel, limitDirection, timeLeft } from '../src/shared/limitText';
import { SharedStore } from '../src/shared/store';
import type { LimitOrder } from '../src/shared/types';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const order: LimitOrder = {
  id: 7,
  clientOrderId: 'abcdefgh',
  companyId: 3,
  ticker: 'PEPE',
  side: 'buy',
  short: false,
  kind: 'buy',
  qty: 10,
  filled: 0,
  remaining: 10,
  limitCents: 1250,
  leverage: 1,
  stopCents: 0,
  takeCents: 0,
  reservedCents: 12_500,
  state: 'open',
  reason: '',
  avgFillCents: null,
  createdTick: 100,
  expiresTick: 100 + 3600,
  createdMs: 0,
  closedMs: null,
};

describe('limit orders in the screens', () => {
  it('LUI-1: an order is described in plain words, with the right direction for each kind', () => {
    expect(describeOrder(order)).toBe('buy 10 shares of PEPE at $12.50 or lower');
    expect(describeOrder({ ...order, kind: 'sell', side: 'sell', qty: 1 })).toBe('sell 1 share of PEPE at $12.50 or higher');
    expect(describeOrder({ ...order, kind: 'short', side: 'sell', short: true, leverage: 5 })).toBe('short 10 shares of PEPE at $12.50 or higher with 5x leverage');
    expect(describeOrder({ ...order, kind: 'cover', side: 'buy', short: true })).toBe('buy back 10 shares of PEPE at $12.50 or lower');
    expect(['buy', 'cover', 'sell', 'short'].map((k) => limitDirection(k as LimitOrder['kind']))).toEqual(['lower', 'lower', 'higher', 'higher']);
    expect(kindLabel('cover')).toBe('Cover');
    expect(GOOD_FOR_CHOICES.map((g) => g.value)).toEqual(['1h', '1d', '3d']);
  });

  it('LUI-2: the time left is counted in the market\'s ticks (one per second)', () => {
    expect(timeLeft(30)).toBe('under a minute');
    expect(timeLeft(40 * 60)).toBe('40 min');
    expect(timeLeft(5 * 3600 + 12 * 60)).toBe('5 h 12 min');
    expect(timeLeft(3 * 86_400)).toBe('3 days 0 h');
    expect(expiryText(order, 100)).toBe('1 h 00 min left');
    expect(expiryText(order, 100 + 3600)).toBe('ending');
  });

  it('LUI-3: a fill, a part fill, an expiry and an ended order each get their own pop-up', () => {
    const full = describeLimitEvent('fill', { ...order, state: 'filled', filled: 10, remaining: 0, avgFillCents: 1240, reservedCents: 0 });
    expect(full.tone).toBe('good');
    expect(full.title).toBe('Limit order filled');
    expect(full.text).toContain('10 shares');
    expect(full.text).toContain('$12.40');
    const part = describeLimitEvent('fill', { ...order, filled: 4, remaining: 6, avgFillCents: 1250 });
    expect(part.title).toBe('Limit order partly filled');
    expect(part.text).toContain('4 shares of 10');
    expect(part.text).toContain('still waiting');
    const expired = describeLimitEvent('ended', { ...order, state: 'expired', remaining: 0, reservedCents: 0 });
    expect(expired.tone).toBe('neutral');
    expect(expired.title).toBe('Limit order expired');
    const ended = describeLimitEvent('ended', { ...order, state: 'cancelled', remaining: 0, filled: 3, avgFillCents: 1200, reason: 'Your shares are gone, so there was nothing to sell.' });
    expect(ended.title).toBe('Limit order ended');
    expect(ended.text).toContain('Your shares are gone');
    expect(ended.text).toContain('3 shares filled');
  });

  it('LUI-4: the store shows a pop-up for a limit event (newest five kept) and forgets the orders when the player leaves', () => {
    const store = new SharedStore();
    store.noteLimit({ what: 'fill', order: { ...order, state: 'filled', filled: 10, remaining: 0, avgFillCents: 1250 } });
    const toast = store.getSnapshot().toasts[0];
    expect(toast?.ticker).toBe('PEPE');
    expect(toast?.title).toBe('Limit order filled');
    expect(store.getSnapshot().limits).toEqual([]);
    for (let i = 0; i < 6; i++) store.noteLimit({ what: 'ended', order: { ...order, state: 'expired', id: 100 + i } });
    expect(store.getSnapshot().toasts.length).toBe(5);
    for (const t of store.getSnapshot().toasts) store.dismissToast(t.id);
    store.stop();
  });

  it('LUI-5: the form is for Career only, sends the request to the server and shows what the server worked out', () => {
    const panel = code(src('shared', 'TradePanel.tsx'));
    expect(panel).toMatch(/kind === 'career' && priceType === 'limit'/); // a match has no limit orders
    expect(panel).toMatch(/\{kind === 'career' && !plain && \(\s*<div className="segmented" role="group" aria-label="Price type">/); // (a coin with a money pool is spot only, and a bankrupt company is close-only: no limit orders)
    expect(panel).toMatch(/const plain = spotOnly \|\| closeOnly;/);
    for (const call of ['api.placeLimit', 'api.limitEstimate']) expect(panel).toContain(call);
    for (const id of ['limit-estimate', 'limit-reserve', 'limit-when', 'limit-fills-now', 'limit-too-dear', 'open-orders-here']) expect(panel).toContain(`data-testid="${id}"`);
    for (const id of ['type-${t}', 'limit-price-${kind}', 'goodfor-${kind}', 'limit-now-${kind}']) expect(panel).toContain('data-testid={`' + id + '`}');
    // The money is the server's number: the form does not work out the set-aside cash itself.
    expect(panel).toMatch(/limitEstimate\.reserveCents/);
    expect(panel).not.toMatch(/marginOf|feeOf|BigInt\(limit/);
    // A double click or a retry re-sends the same id, so it can place only one order.
    expect(panel).toMatch(/clientOrderId: orderId\.current\.id/);
    expect(panel).toMatch(/L\$\{limitCents\}:\$\{goodFor\}/);
    // The old words "at no interest" are gone (leverage costs interest since the margin update).
    expect(panel).not.toContain('at no interest');
  });

  it('LUI-6: the Account screen lists the open orders with Cancel, and shows the cash that is set aside', () => {
    const account = code(src('shared', 'AccountScreen.tsx'));
    expect(account).toContain('<OpenOrders orders={limits}');
    expect(account).toContain('career.reservedCents');
    expect(account).toContain('data-testid="career-reserved"');
    const open = code(src('shared', 'OpenOrders.tsx'));
    expect(open).toContain('api.cancelLimit');
    expect(open).toMatch(/data-testid=\{`limit-cancel-\$\{o\.id\}`\}/);
    const store = code(src('shared', 'store.ts'));
    expect(store).toContain("addEventListener('limit'");
    expect(store).toContain('api.limitOrders(');
    const api = code(src('shared', 'api.ts'));
    for (const path of ['/api/limit-orders', '/api/limit-orders/estimate', '/api/limit-orders/cancel']) expect(api).toContain(path);
  });
});
