// PayPal TEST payments for Shop looks (server/paypal.ts, server/routes/paypal.ts, src/shared/paypalCatalog.ts, docs/world.md §43). The REAL PayPal client code runs here against a pretend
// PayPal on this computer (tests/helpers/fakePaypal.ts), so nothing talks to the internet. The rules checked: it is off unless the owner sets two settings and can never be pointed at
// real-money PayPal; the server (never the page) picks the price, the look and the player; a look is given only when PayPal confirms a finished payment of exactly the right amount
// for this player and this look; the same order cannot give twice; and the secret never appears in an answer, the log or the database. Even with the settings, PayPal stays hidden until the
// owner presses the PayPal ON/OFF button (PP-25 … PP-30).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { PaypalApiError, UNPAID_KEEP_MS, createPaypalClient, customIdOf, loadPaypalSettings, orderInfoOf, safePaypalBase, type PaypalClient, type PaypalSettings } from '../server/paypal';
import { PAYPAL_FINISHES_PER_MINUTE, PAYPAL_STARTS_PER_MINUTE } from '../server/routes/paypal';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { COSMETICS, type CosmeticDef } from '../src/shared/cosmeticCatalog';
import { PAYPAL_PRICE_CENTS, centsOfPaypalValue, paypalAmountValue, paypalMoneyText, paypalPriceOf } from '../src/shared/paypalCatalog';
import { FAKE_CLIENT_ID, FAKE_SECRET, startFakePaypal, type FakePaypal } from './helpers/fakePaypal';
import { LONG, db, idOf, liveRig, requestId, type Running } from './helpers/chatlive';

// The app is made once per test with a client that is handed to the pretend PayPal of THAT test.
let fake!: FakePaypal;
let real!: PaypalClient;
let beforeCapture: (() => void) | null = null;
const lines: string[] = [];
const client: PaypalClient = {
  createOrder: (input) => real.createOrder(input),
  captureOrder: async (id) => {
    beforeCapture?.();
    return real.captureOrder(id);
  },
  getOrder: (id) => real.getOrder(id),
};
const settingsFor = (base: string): PaypalSettings => loadPaypalSettings({ TQ_PAYPAL_CLIENT_ID: FAKE_CLIENT_ID, TQ_PAYPAL_SECRET: FAKE_SECRET, TQ_PAYPAL_BASE_URL: base }) as PaypalSettings;

const on = liveRig('paypal', 'boss', '12', { paypal: { client, clientId: FAKE_CLIENT_ID }, log: new Logger({ sink: (line) => lines.push(line) }) });
const off = liveRig('paypal-off');
/** A server with the two PayPal settings AND the owner's button pressed to ON (it starts OFF; the button has its own tests below). */
async function bootOn(): Promise<Running> {
  const r = await on.boot();
  r.app.services.paypal.setSwitch(true);
  return r;
}

beforeEach(async () => {
  lines.length = 0;
  beforeCapture = null;
  fake = await startFakePaypal();
  real = createPaypalClient(settingsFor(fake.base));
});
afterEach(async () => {
  await fake.close();
});

const config = async (r: Running, cookie?: string) => on.call(r, '/api/paypal/config', { cookie });
const start = (r: Running, cookie: string | undefined, item: unknown, extra: Record<string, unknown> = {}) => on.call(r, '/api/paypal/orders', { method: 'POST', cookie, body: { item, ...extra } });
const finish = (r: Running, cookie: string | undefined, orderId: unknown) => on.call(r, '/api/paypal/capture', { method: 'POST', cookie, body: { orderId } });
const shop = async (r: Running, cookie: string) => (await on.call(r, '/api/shop', { cookie })).json;
const code = (res: { status: number; json: any }): [number, string] => [res.status, res.json?.error?.code];
const rows = (r: Running) => db(r).all<{ id: string; user_id: number; item: string; amount_cents: number; status: string; capture_id: string | null }>('SELECT id, user_id, item, amount_cents, status, capture_id FROM paypal_orders ORDER BY created_ms, id');
const cashOf = (r: Running, name: string): number => db(r).get<{ c: number }>("SELECT a.cash_cents AS c FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.username = ? AND a.kind = 'career'", name)?.c as number;
const setCash = (r: Running, name: string, cents: number): void => {
  db(r).run("UPDATE accounts SET cash_cents = ? WHERE kind = 'career' AND user_id = (SELECT id FROM users WHERE username = ?)", cents, name);
  r.app.services.social.invalidate();
};
/** Looks that are for sale for money and need no badge, by rarity. */
const sellable = (rarity: number): CosmeticDef[] => COSMETICS.filter((c) => c.rarity === rarity && c.earn === undefined && c.requiresBadge === undefined);
const lookOf = (rarity: number, skip = 0): string => (sellable(rarity)[skip] as CosmeticDef).id;
/** Starts an order for a player and lets the pretend buyer approve it. */
async function approved(r: Running, cookie: string, item: string): Promise<string> {
  const made = await start(r, cookie, item);
  expect(made.status).toBe(200);
  fake.approve(made.json.orderId);
  return made.json.orderId as string;
}

describe('the settings', () => {
  it('PP-1: PayPal is off without both settings; a half-set or wrong setting is a plain error that never repeats the values; real-money PayPal cannot be chosen', () => {
    expect(loadPaypalSettings({})).toBeNull();
    expect(loadPaypalSettings({ TQ_PAYPAL_CLIENT_ID: '  ', TQ_PAYPAL_SECRET: '' })).toBeNull();
    const ok = loadPaypalSettings({ TQ_PAYPAL_CLIENT_ID: FAKE_CLIENT_ID, TQ_PAYPAL_SECRET: FAKE_SECRET }) as PaypalSettings;
    expect(ok.baseUrl).toBe('https://api-m.sandbox.paypal.com');
    expect(ok.clientId).toBe(FAKE_CLIENT_ID);
    expect(ok.secret).toBe(FAKE_SECRET);
    // The secret is there to be used but is not a normal property: it cannot slip into a JSON dump, a log line or a copy.
    expect(Object.keys(ok)).not.toContain('secret');
    expect(JSON.stringify(ok)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify({ ...ok })).not.toContain(FAKE_SECRET);

    const bad = (env: Record<string, string>): string => {
      try {
        loadPaypalSettings({ TQ_PAYPAL_CLIENT_ID: FAKE_CLIENT_ID, TQ_PAYPAL_SECRET: FAKE_SECRET, ...env });
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('this setting should have been refused');
    };
    for (const message of [
      bad({ TQ_PAYPAL_ENV: 'live' }),
      bad({ TQ_PAYPAL_ENV: 'production' }),
      bad({ TQ_PAYPAL_BASE_URL: 'https://api-m.paypal.com' }), // PayPal's real-money servers
      bad({ TQ_PAYPAL_BASE_URL: 'https://api.paypal.com' }),
      bad({ TQ_PAYPAL_BASE_URL: 'https://evil.example.com' }),
      bad({ TQ_PAYPAL_BASE_URL: 'https://api-m.sandbox.paypal.com.evil.example.com' }),
      bad({ TQ_PAYPAL_BASE_URL: 'https://api-m.sandbox.paypal.com:8443' }),
      bad({ TQ_PAYPAL_BASE_URL: 'https://user:pass@api-m.sandbox.paypal.com' }),
      bad({ TQ_PAYPAL_BASE_URL: 'http://api-m.sandbox.paypal.com' }),
      bad({ TQ_PAYPAL_BASE_URL: 'https://127.0.0.1' }),
      bad({ TQ_PAYPAL_BASE_URL: 'not an address' }),
      bad({ TQ_PAYPAL_CLIENT_ID: 'short' }),
      bad({ TQ_PAYPAL_CLIENT_ID: 'has a space inside it which is wrong' }),
      bad({ TQ_PAYPAL_SECRET: 'tiny' }),
      bad({ TQ_PAYPAL_SECRET: 'has a space inside it which is wrong' }),
    ]) {
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain(FAKE_SECRET);
      expect(message).not.toContain(FAKE_CLIENT_ID);
    }
    expect(() => loadPaypalSettings({ TQ_PAYPAL_CLIENT_ID: FAKE_CLIENT_ID })).toThrow(/needs both/);
    expect(() => loadPaypalSettings({ TQ_PAYPAL_SECRET: FAKE_SECRET })).toThrow(/needs both/);
    // The only addresses that work: PayPal's test servers, and this very computer over plain http (for tests).
    expect(safePaypalBase('https://api-m.sandbox.paypal.com/')).toBe('https://api-m.sandbox.paypal.com');
    expect(safePaypalBase('http://127.0.0.1:5555')).toBe('http://127.0.0.1:5555');
    expect(safePaypalBase('http://localhost:5555/')).toBe('http://localhost:5555');
    expect(() => safePaypalBase('https://api-m.paypal.com')).toThrow(/does not take real-money/);
  });

  it('PP-2: the server settings turn PayPal on, or off with a reason (the game still starts)', () => {
    const base = { TQ_DATA_DIR: tmpdir() };
    expect(loadConfig(base).paypal).toBeNull();
    expect(loadConfig(base).paypalProblem).toBeNull();
    const good = loadConfig({ ...base, TQ_PAYPAL_CLIENT_ID: FAKE_CLIENT_ID, TQ_PAYPAL_SECRET: FAKE_SECRET });
    expect(good.paypal?.clientId).toBe(FAKE_CLIENT_ID);
    expect(good.paypalProblem).toBeNull();
    const half = loadConfig({ ...base, TQ_PAYPAL_CLIENT_ID: FAKE_CLIENT_ID });
    expect(half.paypal).toBeNull();
    expect(half.paypalProblem).toMatch(/needs both/);
    const live = loadConfig({ ...base, TQ_PAYPAL_CLIENT_ID: FAKE_CLIENT_ID, TQ_PAYPAL_SECRET: FAKE_SECRET, TQ_PAYPAL_ENV: 'live' });
    expect(live.paypal).toBeNull();
    expect(live.paypalProblem).toMatch(/sandbox/);
    expect(JSON.stringify(live.paypalProblem)).not.toContain(FAKE_SECRET);
  });
});

describe('the prices', () => {
  it('PP-3: test prices are $0.50, $1.00, $2.00 and $5.00 by rarity; every look for sale has one; money is written with whole-number maths', () => {
    expect(PAYPAL_PRICE_CENTS).toEqual([0, 50, 100, 200, 500]);
    for (const c of COSMETICS.filter((x) => x.earn === undefined)) expect(paypalPriceOf(c)).toBe(PAYPAL_PRICE_CENTS[c.rarity]);
    expect(paypalPriceOf({ rarity: 9 })).toBe(0);
    expect([paypalAmountValue(50), paypalAmountValue(100), paypalAmountValue(5), paypalAmountValue(123456)]).toEqual(['0.50', '1.00', '0.05', '1234.56']);
    expect([paypalMoneyText(150), paypalMoneyText(50), paypalMoneyText(123456)]).toEqual(['$1.50', '$0.50', '$1,234.56']);
    expect([centsOfPaypalValue('1.50'), centsOfPaypalValue('1'), centsOfPaypalValue('1.5'), centsOfPaypalValue('0.05')]).toEqual([150, 100, 150, 5]);
    for (const odd of ['1.505', '-1.00', ' 1.00', '1.00 ', '1,00', '', 'abc', '99999999', '1e3', 1.5, null, undefined]) expect(centsOfPaypalValue(odd)).toBeNull();
  });

  it('PP-4: the price is the server\'s: each rarity makes an order for its own amount in US dollars, and nothing the page adds changes it', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    for (const rarity of [1, 2, 3, 4]) {
      // (Every Legendary look for sale needs a badge, so he is given that badge first.)
      const def = COSMETICS.find((c) => c.rarity === rarity && c.earn === undefined) as CosmeticDef;
      if (def.requiresBadge !== undefined) db(r).run('INSERT OR IGNORE INTO user_badges(user_id, badge, earned_ms) VALUES (?, ?, ?)', idOf(r, 'alice'), def.requiresBadge, r.clock.now());
      const item = def.id;
      const made = await start(r, alice, item, { amountCents: 1, amount: '0.01', price: 1, priceCents: 1, currency: 'EUR', userId: 999 });
      expect(made.status).toBe(200);
      expect(Object.keys(made.json).sort()).toEqual(['amountCents', 'item', 'orderId']);
      expect([made.json.item, made.json.amountCents]).toEqual([item, PAYPAL_PRICE_CENTS[rarity]]);
      expect(made.json.orderId).toMatch(/^ORDER/);
      const order = fake.orders.get(made.json.orderId);
      expect(order?.amount).toBe(paypalAmountValue(PAYPAL_PRICE_CENTS[rarity] as number));
      expect(order?.currency).toBe('USD');
      expect(order?.customId).toBe(customIdOf(idOf(r, 'alice'), item));
    }
    expect(rows(r).map((x) => [x.amount_cents, x.status])).toEqual([1, 2, 3, 4].map((rarity) => [PAYPAL_PRICE_CENTS[rarity], 'created']));
    expect(cashOf(r, 'alice')).toBe(100_000); // PayPal never touches Career cash
  }, LONG);
});

describe('who may use it', () => {
  it('PP-5: when PayPal is off the page is told so and the other two routes say "not found"; nothing is left to find', async () => {
    const r = await off.boot();
    const alice = await off.signUp(r, 'alice');
    expect((await off.call(r, '/api/paypal/config')).status).toBe(401);
    expect((await off.call(r, '/api/paypal/config', { cookie: alice })).json).toEqual({ enabled: false });
    for (const [path, body] of [
      ['/api/paypal/orders', { item: lookOf(1) }],
      ['/api/paypal/capture', { orderId: 'ORDER000001X' }],
    ] as const) {
      expect(code(await off.call(r, path, { method: 'POST', cookie: alice, body }))).toEqual([404, 'paypal_off']);
      expect((await off.call(r, path, { method: 'POST', body })).status).toBe(401);
    }
    expect(r.app.services.paypal.enabled()).toBe(false);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM paypal_orders')?.n).toBe(0);
    // The Shop itself is not changed by any of this.
    expect((await off.call(r, '/api/shop', { cookie: alice })).json.cashCents).toBe(100_000);
  }, LONG);

  it('PP-6: when PayPal is on, every route needs a signed-in player, and the page only learns the public client ID (never the secret)', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    expect((await config(r)).status).toBe(401);
    expect((await start(r, undefined, lookOf(1))).status).toBe(401);
    expect((await finish(r, undefined, 'ORDER000001X')).status).toBe(401);
    const c = await config(r, alice);
    expect(c.json).toEqual({ enabled: true, env: 'sandbox', clientId: FAKE_CLIENT_ID, currency: 'USD' });
    expect(JSON.stringify(c.json)).not.toContain(FAKE_SECRET);
    expect(fake.calls).toEqual([]); // asking for the settings never calls PayPal
  }, LONG);

  it('PP-7: only the player an order was made for can finish it; somebody else\'s order looks like one that does not exist; badly written ids never reach PayPal', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const bob = await on.signUp(r, 'bob');
    const item = lookOf(1);
    const orderId = await approved(r, alice, item);
    expect(code(await finish(r, bob, orderId))).toEqual([404, 'no_such_order']);
    expect((await shop(r, bob)).owned).toEqual([]);
    expect(code(await finish(r, bob, 'ORDER999999X'))).toEqual([404, 'no_such_order']);
    for (const odd of [undefined, null, 5, '', 'abc', 'a b c d e', 'x'.repeat(65), '../../etc', ['ORDER000001X'], { id: 1 }]) expect(code(await finish(r, alice, odd))).toEqual([400, 'bad_request']);
    expect(fake.captureCalls()).toBe(0);
    expect(rows(r).map((x) => x.status)).toEqual(['created']);
    expect((await finish(r, alice, orderId)).status).toBe(200);
    expect((await shop(r, alice)).owned).toEqual([item]);
    expect((await shop(r, bob)).owned).toEqual([]);
  }, LONG);
});

describe('what can be bought', () => {
  it('PP-8: a look that cannot be bought with Career cash cannot be bought with PayPal either, and PayPal is not even asked', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const earned = COSMETICS.find((c) => c.earn !== undefined) as CosmeticDef;
    const badged = COSMETICS.find((c) => c.requiresBadge !== undefined) as CosmeticDef;
    expect(code(await start(r, alice, 12345))).toEqual([400, 'bad_request']);
    expect(code(await start(r, alice, undefined))).toEqual([400, 'bad_request']);
    expect(code(await start(r, alice, 'nope_nothing'))).toEqual([404, 'no_such_item']);
    expect(code(await start(r, alice, earned.id))).toEqual([403, 'not_for_sale']);
    expect(code(await start(r, alice, badged.id))).toEqual([403, 'badge_needed']);
    expect(fake.calls).toEqual([]);
    expect(rows(r)).toEqual([]);
    // One he already owns (here: bought with Career cash) is refused too.
    const item = lookOf(1);
    setCash(r, 'alice', 500_000);
    expect((await on.call(r, '/api/shop/buy', { method: 'POST', cookie: alice, body: { item } })).status).toBe(200);
    expect(code(await start(r, alice, item))).toEqual([409, 'already_owned']);
    expect(fake.calls).toEqual([]);
  }, LONG);

  it('PP-9: a look that needs a badge can be bought with PayPal by a player who has the badge, at the Legendary test price', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const badged = COSMETICS.find((c) => c.requiresBadge !== undefined) as CosmeticDef;
    db(r).run('INSERT OR IGNORE INTO user_badges(user_id, badge, earned_ms) VALUES (?, ?, ?)', idOf(r, 'alice'), badged.requiresBadge as string, r.clock.now());
    const orderId = await approved(r, alice, badged.id);
    const done = await finish(r, alice, orderId);
    expect(done.status).toBe(200);
    expect(done.json.amountCents).toBe(500);
    expect(done.json.owned).toContain(badged.id);
  }, LONG);

  it('PP-10: paying with PayPal gives the look and wears it, takes no Career cash, and the same order can never give it twice', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const item = lookOf(3);
    const orderId = await approved(r, alice, item);
    const done = await finish(r, alice, orderId);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ item, orderId, amountCents: 200, already: false, cashCents: 100_000 });
    expect(done.json.owned).toEqual([item]);
    const def = COSMETICS.find((c) => c.id === item) as CosmeticDef;
    expect(JSON.stringify([done.json.equipped, done.json.gear])).toContain(def.id); // worn at once, like any look he gets
    expect(cashOf(r, 'alice')).toBe(100_000);
    expect(rows(r).map((x) => [x.id, x.user_id, x.item, x.amount_cents, x.status])).toEqual([[orderId, idOf(r, 'alice'), item, 200, 'granted']]);
    expect(rows(r)[0]?.capture_id).toMatch(/^CAPTURE/);
    expect(db(r).get<{ price: number }>('SELECT price_cents AS price FROM user_cosmetics WHERE item = ?', item)?.price).toBe(0);
    expect((await shop(r, alice)).owned).toEqual([item]);
    // Finishing it again (a double click, a reload) says it is done and takes nothing more.
    const again = await finish(r, alice, orderId);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ item, orderId, already: true });
    expect(fake.captureCalls()).toBe(1);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_cosmetics WHERE item = ?', item)?.n).toBe(1);
    expect(r.app.services.paypal.counts()).toEqual({ granted: 1 });
  }, LONG);

  it('PP-11: a player cannot be charged for a look he bought another way after starting the order: it is refused before any money is taken', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const item = lookOf(1);
    const orderId = await approved(r, alice, item);
    setCash(r, 'alice', 500_000);
    expect((await on.call(r, '/api/shop/buy', { method: 'POST', cookie: alice, body: { item } })).status).toBe(200);
    expect(code(await finish(r, alice, orderId))).toEqual([409, 'already_owned']);
    expect(fake.captureCalls()).toBe(0);
    expect(rows(r).map((x) => x.status)).toEqual(['created']);
  }, LONG);

  it('PP-12: if the look becomes his while PayPal is taking the payment, the payment is recorded as paid-but-not-given (no second copy), and finishing again just says so', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const item = lookOf(2);
    const orderId = await approved(r, alice, item);
    beforeCapture = () => db(r).run('INSERT INTO user_cosmetics(user_id, item, bought_ms, price_cents) VALUES (?, ?, ?, 0)', idOf(r, 'alice'), item, r.clock.now());
    const done = await finish(r, alice, orderId);
    expect(done.status).toBe(200);
    expect(done.json.owned).toEqual([item]);
    expect(rows(r).map((x) => x.status)).toEqual(['paid_not_granted']);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_cosmetics WHERE item = ?', item)?.n).toBe(1);
    expect(lines.some((l) => l.includes('already owned it'))).toBe(true);
    expect((await finish(r, alice, orderId)).json.already).toBe(true);
    expect(fake.captureCalls()).toBe(1);
  }, LONG);

  it('PP-13: an order that was being given when the server stopped is finished by trying again (the look is his, the row becomes granted, nothing is taken twice)', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const item = lookOf(1);
    const orderId = await approved(r, alice, item);
    // The server died after PayPal took the payment and the look was written, before the row could say "granted".
    const order = fake.orders.get(orderId);
    if (order) order.captured = true;
    db(r).run("UPDATE paypal_orders SET status = 'granting', capture_id = 'CAPTURE000001' WHERE id = ?", orderId);
    db(r).run('INSERT INTO user_cosmetics(user_id, item, bought_ms, price_cents) VALUES (?, ?, ?, 0)', idOf(r, 'alice'), item, r.clock.now());
    const done = await finish(r, alice, orderId);
    expect(done.status).toBe(200);
    expect(rows(r).map((x) => x.status)).toEqual(['granted']);
    expect(fake.captureCalls()).toBe(0); // it asked what PayPal knows, it did not take the payment again
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_cosmetics WHERE item = ?', item)?.n).toBe(1);
  }, LONG);
});

describe('a payment that is not good gives nothing', () => {
  it('PP-14: before the buyer approves, nothing is given; after approving, the same order works', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const item = lookOf(1);
    const made = await start(r, alice, item);
    expect(code(await finish(r, alice, made.json.orderId))).toEqual([409, 'not_paid']);
    expect((await shop(r, alice)).owned).toEqual([]);
    expect(rows(r).map((x) => x.status)).toEqual(['created']);
    fake.approve(made.json.orderId);
    expect((await finish(r, alice, made.json.orderId)).status).toBe(200);
    expect((await shop(r, alice)).owned).toEqual([item]);
  }, LONG);

  it('PP-15: a wrong amount, a wrong currency, another player\'s custom_id, or a payment that is not COMPLETED gives nothing; fixed, the same order then works', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const cases: [string, () => void][] = [
      ['less money', () => (fake.behave.amountOverride = '0.01')],
      ['more money', () => (fake.behave.amountOverride = '5.00')],
      ['a negative amount', () => (fake.behave.amountOverride = '-0.50')],
      ['a different currency', () => (fake.behave.currencyOverride = 'EUR')],
      ['another player', () => (fake.behave.customIdOverride = `tq:${idOf(r, 'alice') + 1}:${lookOf(1)}`)],
      ['another look', () => (fake.behave.customIdOverride = `tq:${idOf(r, 'alice')}:${lookOf(2)}`)],
      ['a payment still pending', () => (fake.behave.captureStatus = 'PENDING')],
      ['an order that is not completed', () => (fake.behave.orderStatus = 'APPROVED')],
      ['a payment that is not a status at all', () => (fake.behave.captureStatus = '')],
    ];
    const mine: string[] = [];
    for (const [index, [why, bend]] of cases.entries()) {
      Object.assign(fake.behave, { amountOverride: null, currencyOverride: null, customIdOverride: null, captureStatus: 'COMPLETED', orderStatus: null });
      const item = lookOf(1, index % sellable(1).length);
      if (mine.includes(item)) continue;
      mine.push(item);
      const orderId = await approved(r, alice, item);
      bend();
      const out = await finish(r, alice, orderId);
      expect([why, ...code(out)]).toEqual([why, 409, 'not_paid']);
      expect((await shop(r, alice)).owned, why).toEqual([]);
    }
    expect(rows(r).every((x) => x.status === 'created')).toBe(true);
    expect(rows(r).length).toBeGreaterThanOrEqual(5);
    // PayPal's answer was fine after all (it was only wrong for a moment): finishing the same orders now gives each look once.
    Object.assign(fake.behave, { amountOverride: null, currencyOverride: null, customIdOverride: null, captureStatus: 'COMPLETED', orderStatus: null });
    for (const x of rows(r)) expect((await finish(r, alice, x.id)).status).toBe(200);
    expect((await shop(r, alice)).owned.slice().sort()).toEqual(mine.slice().sort());
    expect(rows(r).every((x) => x.status === 'granted')).toBe(true);
    expect(cashOf(r, 'alice')).toBe(100_000);
  }, LONG);

  it('PP-16: a payment the buyer\'s bank declines says so (402), gives nothing, and the same order can be tried again', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const item = lookOf(1);
    const orderId = await approved(r, alice, item);
    fake.behave.decline = true;
    const out = await finish(r, alice, orderId);
    expect(code(out)).toEqual([402, 'payment_declined']);
    expect(out.json.error.message).toMatch(/declined/i);
    expect((await shop(r, alice)).owned).toEqual([]);
    expect(rows(r).map((x) => x.status)).toEqual(['created']);
    fake.behave.decline = false;
    expect((await finish(r, alice, orderId)).status).toBe(200);
    expect((await shop(r, alice)).owned).toEqual([item]);
  }, LONG);

  it('PP-17: when PayPal is down or refuses our sign-in, the player gets a plain "try again" (502) with nothing from PayPal in it, nothing is given, and nothing is kept', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const item = lookOf(1);
    fake.behave.refuseToken = true;
    const noSignIn = await start(r, alice, item);
    expect(code(noSignIn)).toEqual([502, 'paypal_unavailable']);
    expect(JSON.stringify(noSignIn.json)).not.toMatch(/client|secret|credential|401|Basic/i);
    expect(rows(r)).toEqual([]);
    fake.behave.refuseToken = false;
    // An order id that PayPal writes in a strange way is never trusted or kept.
    for (const odd of ['../../evil', 'has spaces in it', 'x'.repeat(80), 'abc']) {
      fake.behave.orderIdOverride = odd;
      expect(code(await start(r, alice, item))).toEqual([502, 'paypal_unavailable']);
    }
    fake.behave.orderIdOverride = null;
    expect(rows(r)).toEqual([]);
    const orderId = await approved(r, alice, item);
    fake.behave.down = true;
    expect(code(await start(r, alice, lookOf(1, 1)))).toEqual([502, 'paypal_unavailable']);
    expect(code(await finish(r, alice, orderId))).toEqual([502, 'paypal_unavailable']);
    expect((await shop(r, alice)).owned).toEqual([]);
    expect(rows(r).map((x) => x.status)).toEqual(['created']); // only the order that was really made
    fake.behave.down = false;
    expect((await finish(r, alice, orderId)).status).toBe(200);
    expect(lines.some((l) => /PayPal \(create\) failed/.test(l))).toBe(true);
  }, LONG);

  it('PP-18: two clicks at once take the payment once: one finishes it, the other is told it is already being finished', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const item = lookOf(2);
    const orderId = await approved(r, alice, item);
    fake.behave.captureDelayMs = 250;
    const both = await Promise.all([finish(r, alice, orderId), finish(r, alice, orderId)]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(both.find((x) => x.status === 409)?.json.error.code).toBe('busy');
    expect(both.find((x) => x.status === 200)?.json.already).toBe(false);
    expect(fake.captureCalls()).toBe(1);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM user_cosmetics WHERE item = ?', item)?.n).toBe(1);
    expect((await finish(r, alice, orderId)).json.already).toBe(true);
  }, LONG);
});

describe('keeping secrets and tidy records', () => {
  it('PP-19: the secret appears nowhere: not in any answer, the log, or the database', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const seen: string[] = [];
    const note = (res: { json: any }) => seen.push(JSON.stringify(res.json));
    note(await config(r, alice));
    fake.behave.refuseToken = true;
    note(await start(r, alice, lookOf(1)));
    fake.behave.refuseToken = false;
    const orderId = await approved(r, alice, lookOf(1));
    fake.behave.decline = true;
    note(await finish(r, alice, orderId));
    fake.behave.decline = false;
    note(await finish(r, alice, orderId));
    note(await finish(r, alice, orderId));
    note(await start(r, alice, 'nope'));
    const basic = Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_SECRET}`).toString('base64');
    const dump = JSON.stringify(db(r).all('SELECT * FROM paypal_orders')) + JSON.stringify(db(r).all('SELECT * FROM user_cosmetics'));
    for (const text of [...seen, lines.join('\n'), dump]) {
      expect(text).not.toContain(FAKE_SECRET);
      expect(text).not.toContain(basic);
      expect(text).not.toContain('tok-1');
    }
    expect(lines.some((l) => l.includes('in PayPal TEST mode'))).toBe(true); // the log does say what happened, without the secret
  }, LONG);

  it('PP-20: unpaid orders older than three days are swept when the next one is made; paid ones are kept as the record', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const paid = await approved(r, alice, lookOf(1));
    expect((await finish(r, alice, paid)).status).toBe(200);
    const stale = (await start(r, alice, lookOf(1, 1))).json.orderId as string;
    r.clock.advanceSeconds(UNPAID_KEEP_MS / 1000 - 5);
    const fresh = (await start(r, alice, lookOf(1, 2))).json.orderId as string;
    expect(rows(r).map((x) => x.id).sort()).toEqual([paid, stale, fresh].sort()); // not old enough yet
    r.clock.advanceSeconds(10);
    const last = (await start(r, alice, lookOf(1, 3))).json.orderId as string;
    expect(rows(r).map((x) => [x.id, x.status]).sort()).toEqual(
      [
        [paid, 'granted'],
        [fresh, 'created'],
        [last, 'created'],
      ].sort(),
    );
    expect(code(await finish(r, alice, stale))).toEqual([404, 'no_such_order']);
  }, LONG);

  it('PP-21: at most 10 orders are started and 20 finished per player per minute', async () => {
    const r = await bootOn();
    const alice = await on.signUp(r, 'alice');
    const bob = await on.signUp(r, 'bob');
    const items = COSMETICS.filter((c) => c.earn === undefined && c.requiresBadge === undefined).map((c) => c.id);
    expect(items.length).toBeGreaterThan(PAYPAL_STARTS_PER_MINUTE + 2);
    for (let i = 0; i < PAYPAL_STARTS_PER_MINUTE; i += 1) expect((await start(r, alice, items[i])).status).toBe(200);
    expect(code(await start(r, alice, items[PAYPAL_STARTS_PER_MINUTE]))).toEqual([429, 'rate_limited']);
    expect((await start(r, bob, items[0])).status).toBe(200); // somebody else is not slowed down
    r.clock.advanceSeconds(61);
    expect((await start(r, alice, items[PAYPAL_STARTS_PER_MINUTE])).status).toBe(200);
    for (let i = 0; i < PAYPAL_FINISHES_PER_MINUTE; i += 1) expect(code(await finish(r, alice, 'ORDER999999X'))).toEqual([404, 'no_such_order']);
    expect(code(await finish(r, alice, 'ORDER999999X'))).toEqual([429, 'rate_limited']);
  }, LONG);
});

describe('the PayPal client and the database', () => {
  it('PP-22: the client signs in once and reuses the token, sends the amount as text, asks for no shipping, and reads only what it needs from PayPal\'s answers', async () => {
    const created = await real.createOrder({ amountCents: 150, description: 'x'.repeat(300), customId: 'tq:1:c_sky', requestId: 'req-1' });
    expect(created.id).toMatch(/^ORDER/);
    const order = fake.orders.get(created.id);
    expect([order?.amount, order?.currency, order?.customId]).toEqual(['1.50', 'USD', 'tq:1:c_sky']);
    expect((await real.getOrder(created.id)).status).toBe('CREATED');
    fake.approve(created.id);
    const taken = await real.captureOrder(created.id);
    expect(taken.captureId).toMatch(/^CAPTURE/);
    expect({ ...taken, captureId: 'X' }).toEqual({ id: created.id, status: 'COMPLETED', customId: 'tq:1:c_sky', captureId: 'X', captureStatus: 'COMPLETED', amountCents: 150, currency: 'USD' });
    expect(fake.tokenCalls()).toBe(1);
    expect(fake.calls[0]).toBe('POST /v1/oauth2/token');
    expect(fake.calls.filter((c) => c.startsWith('POST /v2/checkout/orders')).length).toBe(2);
    // PayPal's answer is read defensively: anything missing or strange is "unknown", which can never pass the checks.
    const blank = { id: null, status: null, customId: null, captureId: null, captureStatus: null, amountCents: null, currency: null };
    for (const odd of [null, undefined, 5, 'text', [], [1], {}, { purchase_units: 'x' }, { purchase_units: [null] }, { purchase_units: [{ payments: { captures: [{ amount: { value: 3 } }] } }] }]) expect(orderInfoOf(odd)).toEqual(blank);
    expect(orderInfoOf({ id: 'A', status: 'COMPLETED', purchase_units: [{ custom_id: 'u', payments: { captures: [{ id: 'C', status: 'COMPLETED', custom_id: 'c', amount: { value: '2.00', currency_code: 'USD' } }] } }] })).toEqual({
      id: 'A',
      status: 'COMPLETED',
      customId: 'c',
      captureId: 'C',
      captureStatus: 'COMPLETED',
      amountCents: 200,
      currency: 'USD',
    });
  }, LONG);

  it('PP-23: a slow PayPal times out, an unreachable one is a network error, and a refusal carries PayPal\'s short reason', async () => {
    const slow = createPaypalClient(Object.assign(Object.create(settingsFor(fake.base)) as PaypalSettings, { timeoutMs: 120 }));
    const made = await slow.createOrder({ amountCents: 50, description: 'x', customId: 'tq:1:c_sky', requestId: 'r' });
    fake.approve(made.id);
    fake.behave.captureDelayMs = 600;
    const timedOut = await slow.captureOrder(made.id).catch((e: unknown) => e);
    expect(timedOut).toBeInstanceOf(PaypalApiError);
    expect((timedOut as PaypalApiError).kind).toBe('timeout');
    fake.behave.captureDelayMs = 0;
    await new Promise((done) => setTimeout(done, 700)); // let the slow one finish on the pretend side
    const gone = (await real.captureOrder(made.id).catch((e: unknown) => e)) as PaypalApiError;
    expect([gone.kind, gone.status, gone.issue]).toEqual(['http', 422, 'ORDER_ALREADY_CAPTURED']);
    const missing = (await real.getOrder('NOSUCHORDER1').catch((e: unknown) => e)) as PaypalApiError;
    expect([missing.kind, missing.status]).toEqual(['http', 404]);
    const refused = createPaypalClient(settingsFor(fake.base));
    fake.behave.refuseToken = true;
    const noToken = (await refused.createOrder({ amountCents: 50, description: 'x', customId: 'tq:1:c_sky', requestId: 'r' }).catch((e: unknown) => e)) as PaypalApiError;
    expect(noToken.message).toMatch(/refused the sign-in/);
    expect(noToken.message).not.toContain(FAKE_SECRET);
    await fake.close();
    const nobody = (await createPaypalClient(settingsFor(fake.base)).createOrder({ amountCents: 50, description: 'x', customId: 'tq:1:c_sky', requestId: 'r' }).catch((e: unknown) => e)) as PaypalApiError;
    expect(nobody).toBeInstanceOf(PaypalApiError);
    expect(nobody.kind).toBe('network');
  }, LONG);

  it('PP-24: schema step 32 adds only the PayPal order table, upgrades an older database, refuses nonsense and goes with the player when he is deleted', () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1] as (typeof MIGRATIONS)[number];
    expect(last.version).toBe(32);
    expect(last.sql).toContain('CREATE TABLE paypal_orders');
    expect(last.sql).not.toMatch(/ALTER TABLE|DROP /);
    const dir = mkdtempSync(join(tmpdir(), 'tq-paypal-db-'));
    const d = new Db(join(dir, 'old.sqlite'));
    try {
      d.tx(() => {
        for (const m of MIGRATIONS.filter((x) => x.version <= 31)) {
          d.exec(m.sql);
          d.exec(`PRAGMA user_version = ${m.version}`);
        }
      });
      d.run("INSERT INTO users(id, username, display_name, pw_hash, role, created_ms) VALUES (1, 'a', 'a', 'x', 'player', 1)");
      expect(migrate(d)).toEqual([32]);
      expect(d.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(32);
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM paypal_orders')?.n).toBe(0);
      const add = (id: string, user: number, cents: number, status: string) =>
        d.run('INSERT INTO paypal_orders(id, user_id, item, amount_cents, status, capture_id, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, NULL, 1, 1)', id, user, 'c_sky', cents, status);
      add('ORDER000001X', 1, 50, 'created');
      expect(() => add('ORDER000001X', 1, 50, 'created')).toThrow(); // one row per PayPal order
      expect(() => add('ORDER000002X', 1, 0, 'created')).toThrow(); // an order has a price
      expect(() => add('ORDER000003X', 1, -5, 'created')).toThrow();
      expect(() => add('ORDER000004X', 1, 50, 'refunded')).toThrow(); // only the four known states
      expect(() => add('ORDER000005X', 99, 50, 'created')).toThrow(); // for a player who exists
      for (const status of ['granting', 'granted', 'paid_not_granted']) add(`ORDER_${status}`, 1, 50, status);
      d.run('DELETE FROM users WHERE id = 1');
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM paypal_orders')?.n).toBe(0);
      expect(migrate(d)).toEqual([]);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, LONG);
});

describe('the owner\'s PayPal ON/OFF button', () => {
  const adminGet = (r: Running, cookie?: string) => on.call(r, '/api/admin/paypal', { cookie });
  const press = (r: Running, cookie: string | undefined, body: Record<string, unknown>) => on.call(r, '/api/admin/paypal', { method: 'POST', cookie, body });
  const logRows = (r: Running) => db(r).all<{ action: string; target: string; detail_json: string }>("SELECT action, target, detail_json FROM admin_log WHERE action = 'paypal_switch' ORDER BY id");
  const flag = (r: Running) => db(r).get<{ value: string }>("SELECT value FROM meta WHERE key = 'paypal_on'")?.value ?? null;

  it('PP-25: with the two settings but the button not pressed, PayPal starts OFF: the page is told so, no order can be started, PayPal is never called', async () => {
    const r = await on.boot();
    const alice = await on.signUp(r, 'alice');
    expect(r.app.services.paypal.configured()).toBe(true);
    expect(r.app.services.paypal.enabled()).toBe(false);
    expect((await config(r, alice)).json).toEqual({ enabled: false });
    expect(code(await start(r, alice, lookOf(1)))).toEqual([404, 'paypal_off']);
    expect(code(await finish(r, alice, 'ORDER000001X'))).toEqual([404, 'no_such_order']); // finishing only looks in our own records, so it still answers plainly
    expect(fake.calls).toEqual([]);
    expect(rows(r)).toEqual([]);
    expect(flag(r)).toBeNull();
    const boss = await on.signUp(r, 'boss');
    expect((await adminGet(r, boss)).json).toEqual({ configured: true, on: false, showing: false, env: 'sandbox', orders: {} });
    // The Shop is untouched.
    expect((await shop(r, alice)).cashCents).toBe(100_000);
  }, LONG);

  it('PP-26: only the owner may look at or press the button: nobody signed out, no ordinary player, and the answers never hold a secret or the client ID', async () => {
    const r = await on.boot();
    const alice = await on.signUp(r, 'alice');
    const boss = await on.signUp(r, 'boss');
    for (const [cookie, want] of [[undefined, 401], [alice, 403]] as const) {
      expect((await adminGet(r, cookie)).status).toBe(want);
      expect((await press(r, cookie, { requestId: requestId(), on: true })).status).toBe(want);
    }
    expect(code(await press(r, alice, { requestId: requestId(), on: true }))).toEqual([403, 'owner_only']);
    expect(code(await adminGet(r, alice))).toEqual([403, 'owner_only']);
    // Nothing changed, nothing was logged.
    expect(flag(r)).toBeNull();
    expect(logRows(r)).toEqual([]);
    const seen = await adminGet(r, boss);
    expect(seen.status).toBe(200);
    const text = JSON.stringify([seen.json, (await press(r, boss, { requestId: requestId(), on: true })).json]);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toContain(FAKE_CLIENT_ID);
  }, LONG);

  it('PP-27: the owner switches PayPal on and the page sees it at once; a payment then works; switching off hides it again and stops NEW orders, but an order already started can still be finished', async () => {
    const r = await on.boot();
    const alice = await on.signUp(r, 'alice');
    const boss = await on.signUp(r, 'boss');
    const item = lookOf(1);
    const turnedOn = await press(r, boss, { requestId: requestId(), on: true });
    expect(turnedOn.status).toBe(200);
    expect(turnedOn.json).toEqual({ ok: true, duplicate: false, configured: true, on: true, showing: true, env: 'sandbox', orders: {} });
    expect((await config(r, alice)).json).toEqual({ enabled: true, env: 'sandbox', clientId: FAKE_CLIENT_ID, currency: 'USD' });
    expect(flag(r)).toBe('1');
    // One order is started and approved; another is started and not yet approved.
    const first = await approved(r, alice, item);
    const second = await approved(r, alice, lookOf(2));
    const turnedOff = await press(r, boss, { requestId: requestId(), on: false });
    expect(turnedOff.json).toEqual({ ok: true, duplicate: false, configured: true, on: false, showing: false, env: 'sandbox', orders: { created: 2 } });
    expect(flag(r)).toBeNull();
    expect((await config(r, alice)).json).toEqual({ enabled: false });
    expect(code(await start(r, alice, lookOf(3)))).toEqual([404, 'paypal_off']);
    // The buyer approved before the owner pressed OFF: the money was approved, so the look is still given.
    const done = await finish(r, alice, first);
    expect(done.status).toBe(200);
    expect(done.json.owned).toContain(item);
    expect(rows(r).map((x) => [x.id, x.status])).toEqual([[first, 'granted'], [second, 'created']]);
    expect(cashOf(r, 'alice')).toBe(100_000);
    // Switched on again, the page sees it again, and the other order can be finished too.
    expect((await press(r, boss, { requestId: requestId(), on: true })).json.showing).toBe(true);
    expect((await config(r, alice)).json.enabled).toBe(true);
    expect((await finish(r, alice, second)).status).toBe(200);
    expect((await adminGet(r, boss)).json.orders).toEqual({ granted: 2 });
  }, LONG);

  it('PP-28: the button\'s state lives in the database, not in memory: a flag written there is followed at once, and removing it switches PayPal off', async () => {
    const r = await on.boot();
    const alice = await on.signUp(r, 'alice');
    db(r).run("INSERT INTO meta(key, value) VALUES ('paypal_on', '1')");
    expect((await config(r, alice)).json.enabled).toBe(true);
    // Anything but a clean "1" is OFF.
    for (const odd of ['0', '', 'true', 'yes', '11']) {
      db(r).run("UPDATE meta SET value = ? WHERE key = 'paypal_on'", odd);
      expect((await config(r, alice)).json).toEqual({ enabled: false });
    }
    db(r).run("DELETE FROM meta WHERE key = 'paypal_on'");
    expect(r.app.services.paypal.enabled()).toBe(false);
  }, LONG);

  it('PP-29: a press needs a true/false answer and a request id; a repeated press is not done twice; every real press is written once to the admin log', async () => {
    const r = await on.boot();
    const boss = await on.signUp(r, 'boss');
    for (const body of [{ requestId: requestId() }, { requestId: requestId(), on: 'yes' }, { requestId: requestId(), on: 1 }, { requestId: requestId(), on: null }, { requestId: requestId(), on: 'true' }]) {
      expect(code(await press(r, boss, body))).toEqual([400, 'bad_request']);
    }
    for (const body of [{ on: true }, { requestId: 'x', on: true }, { requestId: 12345678, on: true }]) {
      expect((await press(r, boss, body)).status).toBe(400);
    }
    expect(flag(r)).toBeNull();
    expect(logRows(r)).toEqual([]);

    const id = requestId();
    const one = await press(r, boss, { requestId: id, on: true });
    expect([one.status, one.json.duplicate, one.json.on]).toEqual([200, false, true]);
    const again = await press(r, boss, { requestId: id, on: true });
    expect([again.status, again.json.duplicate, again.json.on]).toEqual([200, true, true]);
    await press(r, boss, { requestId: requestId(), on: false });
    // The first press is sent again late: it is a repeat, so it does not switch PayPal back on.
    const late = await press(r, boss, { requestId: id, on: true });
    expect([late.json.duplicate, late.json.on]).toEqual([true, false]);
    expect(flag(r)).toBeNull();
    expect(logRows(r).map((x) => [x.action, x.target, JSON.parse(x.detail_json)])).toEqual([
      ['paypal_switch', 'on', { on: true }],
      ['paypal_switch', 'off', { on: false }],
    ]);
    expect(JSON.stringify(logRows(r))).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(logRows(r))).not.toContain(FAKE_CLIENT_ID);
    // The owner sees the same two lines in the admin panel's log.
    const state = await on.call(r, '/api/admin/state', { cookie: boss });
    expect(JSON.stringify(state.json)).toContain('paypal_switch');
  }, LONG);

  it('PP-30: without the two settings PayPal cannot be switched ON (409, nothing written), can always be switched OFF, and a flag left behind still shows nothing to players', async () => {
    const r = await off.boot();
    const alice = await off.signUp(r, 'alice');
    const boss = await off.signUp(r, 'boss');
    expect(r.app.services.paypal.configured()).toBe(false);
    expect((await off.call(r, '/api/admin/paypal', { cookie: boss })).json).toEqual({ configured: false, on: false, showing: false, env: 'sandbox', orders: {} });
    const refused = await off.call(r, '/api/admin/paypal', { method: 'POST', cookie: boss, body: { requestId: requestId(), on: true } });
    expect(code(refused)).toEqual([409, 'paypal_not_set_up']);
    expect(refused.json.error.message).toMatch(/TQ_PAYPAL_CLIENT_ID/);
    expect(db(r).get('SELECT value FROM meta WHERE key = ?', 'paypal_on')).toBeUndefined();
    expect(db(r).all("SELECT id FROM admin_log WHERE action = 'paypal_switch'")).toEqual([]);
    // A flag left in the database (the settings were taken away later) shows nothing to players and can be switched off.
    db(r).run("INSERT INTO meta(key, value) VALUES ('paypal_on', '1')");
    expect((await off.call(r, '/api/paypal/config', { cookie: alice })).json).toEqual({ enabled: false });
    const stale = (await off.call(r, '/api/admin/paypal', { cookie: boss })).json;
    expect([stale.configured, stale.on, stale.showing]).toEqual([false, true, false]);
    const cleared = await off.call(r, '/api/admin/paypal', { method: 'POST', cookie: boss, body: { requestId: requestId(), on: false } });
    expect([cleared.status, cleared.json.on]).toEqual([200, false]);
    expect(db(r).get('SELECT value FROM meta WHERE key = ?', 'paypal_on')).toBeUndefined();
    // With no settings an order cannot be finished either.
    expect(code(await off.call(r, '/api/paypal/capture', { method: 'POST', cookie: alice, body: { orderId: 'ORDER000001X' } }))).toEqual([404, 'paypal_off']);
  }, LONG);
});
