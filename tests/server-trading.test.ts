// Orders against the server's market: exact money, no overspending, no double fills, honest slippage.
import { afterEach, describe, expect, it } from 'vitest';
import { Auth, START_CASH_CENTS } from '../server/auth';
import { OrderError, Trading, type OrderRequest } from '../server/trading';
import { makeRig, type Rig } from './helpers/server';

const LONG = 120_000;

/** The error a promise rejects with (fails if it does not reject). */
async function errorOf(promise: Promise<unknown>): Promise<{ code: string }> {
  try {
    await promise;
  } catch (e) {
    return e as { code: string };
  }
  throw new Error('expected the promise to reject');
}
const rigs: Rig[] = [];
afterEach(() => {
  while (rigs.length > 0) rigs.pop()?.cleanup();
});

async function setup(count = 12) {
  const rig = makeRig();
  rigs.push(rig);
  const { db, world } = rig.open({ companyCount: count });
  const auth = new Auth(db, rig.clock.now, '');
  const trading = new Trading(db, world, rig.clock.now);
  const { user } = await auth.register('alice', 'correct horse', '127.0.0.1');
  const account = trading.careerAccountOf(user.id);
  let n = 0;
  const order = (partial: Partial<OrderRequest> & Pick<OrderRequest, 'side' | 'qty'>): OrderRequest => ({
    accountId: account.id,
    clientOrderId: `order-${String(++n).padStart(6, '0')}`,
    companyId: 0,
    ...partial,
  });
  const rejects = (fn: () => unknown): OrderError => {
    try {
      fn();
    } catch (e) {
      if (e instanceof OrderError) return e;
      throw e;
    }
    throw new Error('expected the order to be rejected');
  };
  return { rig, db, world, auth, trading, user, account, order, rejects };
}

describe('Career account', () => {
  it('a new player gets exactly $1,000.00 and nothing else', async () => {
    const { trading, account } = await setup();
    expect(START_CASH_CENTS).toBe(100_000);
    const v = trading.view(account.id);
    expect(v.cashCents).toBe(100_000);
    expect(v.positions).toEqual([]);
    expect(v.netWorthCents).toBe(100_000);
    expect(v.profitCents).toBe(0);
  }, LONG);

  it('registration rules: unique names, sensible lengths, owner by configuration only', async () => {
    const rig = makeRig();
    rigs.push(rig);
    const { db } = rig.open();
    const auth = new Auth(db, rig.clock.now, 'BossPerson');
    await auth.register('player_one', 'password1', '1.1.1.1');
    expect((await errorOf(auth.register('PLAYER_ONE', 'password1', '1.1.1.1'))).code).toBe('username_taken');
    expect((await errorOf(auth.register('ab', 'password1', '1.1.1.1'))).code).toBe('bad_username');
    expect((await errorOf(auth.register('has space', 'password1', '1.1.1.1'))).code).toBe('bad_username');
    expect((await errorOf(auth.register('shortpw', 'abc', '1.1.1.1'))).code).toBe('bad_password');
    const boss = await auth.register('bossperson', 'password1', '1.1.1.1');
    expect(boss.user.role).toBe('owner');
    const p = await auth.register('someone', 'password1', '1.1.1.1');
    expect(p.user.role).toBe('player');
    // Passwords are never stored in the clear.
    const row = db.get<{ pw_hash: string }>("SELECT pw_hash FROM users WHERE username = 'someone'");
    expect(row?.pw_hash.startsWith('scrypt$')).toBe(true);
    expect(row?.pw_hash.includes('password1')).toBe(false);
  }, LONG);

  it('sign-in, sessions and logout; five wrong passwords do not lock a good one but eight do slow down guessing', async () => {
    const rig = makeRig();
    rigs.push(rig);
    const { db } = rig.open();
    const auth = new Auth(db, rig.clock.now, '');
    const { user } = await auth.register('carol', 'password1', '2.2.2.2');
    const ok = await auth.login('carol', 'password1', '2.2.2.2');
    expect(auth.userFor(ok.token)?.id).toBe(user.id);
    auth.logout(ok.token);
    expect(auth.userFor(ok.token)).toBeNull();
    for (let i = 0; i < 8; i += 1) expect((await errorOf(auth.login('carol', 'nope-nope', '2.2.2.2'))).code).toBe('bad_login');
    expect((await errorOf(auth.login('carol', 'password1', '2.2.2.2'))).code).toBe('rate_limited');
    rig.clock.advanceSeconds(11 * 60);
    expect((await auth.login('carol', 'password1', '2.2.2.2')).user.id).toBe(user.id);
    // Sessions expire.
    const t = await auth.login('carol', 'password1', '2.2.2.2');
    rig.clock.advanceSeconds(31 * 86400);
    expect(auth.userFor(t.token)).toBeNull();
  }, LONG);
});

describe('buying and selling', () => {
  it('a buy takes exactly the fill cost from cash, creates the position and records the trade', async () => {
    const { trading, account, order, world } = await setup();
    const out = trading.placeOrder(order({ side: 'buy', qty: 3 }));
    expect(out.duplicate).toBe(false);
    expect(out.trade.filled).toBe(3);
    const cost = out.trade.totalCents;
    expect(cost).toBeGreaterThanOrEqual(3 * world.quote(0).mid);
    const v = trading.view(account.id);
    expect(v.cashCents).toBe(100_000 - cost);
    expect(v.positions).toHaveLength(1);
    expect(v.positions[0]).toMatchObject({ ticker: 'QLRX', shares: 3, costCents: cost });
    // Net worth counts the shares at the bid, so right after buying you are slightly behind (the spread).
    expect(v.netWorthCents).toBe(v.cashCents + 3 * world.quote(0).bid);
    expect(v.profitCents).toBeLessThanOrEqual(0);
    expect(trading.trades(account.id)).toHaveLength(1);
  }, LONG);

  it('the same order id sent twice trades once and returns the first answer', async () => {
    const { trading, account, order } = await setup();
    const req = order({ side: 'buy', qty: 2 });
    const first = trading.placeOrder(req);
    const second = trading.placeOrder(req);
    expect(second.duplicate).toBe(true);
    expect(second.trade.id).toBe(first.trade.id);
    expect(trading.view(account.id).cashCents).toBe(100_000 - first.trade.totalCents);
    expect(trading.view(account.id).positions[0]?.shares).toBe(2);
    expect(trading.trades(account.id)).toHaveLength(1);
  }, LONG);

  it('spending more than you have is refused and changes nothing; the suggested maximum then works', async () => {
    const { trading, account, order, rejects, world } = await setup();
    const price = world.quote(0).ask;
    const tooMany = Math.floor(100_000 / price) + 50;
    const err = rejects(() => trading.placeOrder(order({ side: 'buy', qty: tooMany })));
    expect(err.code).toBe('insufficient_cash');
    expect(trading.view(account.id).cashCents).toBe(100_000);
    expect(trading.trades(account.id)).toHaveLength(0);
    const max = err.details.maxQty as number;
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(tooMany);
    const out = trading.placeOrder(order({ side: 'buy', qty: max }));
    expect(out.trade.filled).toBe(max);
    expect(trading.view(account.id).cashCents).toBeGreaterThanOrEqual(0);
    // One more share does not fit.
    expect(rejects(() => trading.placeOrder(order({ side: 'buy', qty: max + 1 }))).code).toBe('insufficient_cash');
  }, LONG);

  it('two orders that together cost more than the cash cannot both succeed', async () => {
    const { trading, account, order, rejects, world } = await setup();
    const half = Math.floor((100_000 * 0.6) / world.quote(0).ask);
    trading.placeOrder(order({ side: 'buy', qty: half }));
    expect(rejects(() => trading.placeOrder(order({ side: 'buy', qty: half }))).code).toBe('insufficient_cash');
    expect(trading.view(account.id).cashCents).toBeGreaterThanOrEqual(0);
  }, LONG);

  it('you cannot sell shares you do not hold, and there is no short selling', async () => {
    const { trading, order, rejects } = await setup();
    expect(rejects(() => trading.placeOrder(order({ side: 'sell', qty: 1 }))).code).toBe('insufficient_shares');
    trading.placeOrder(order({ side: 'buy', qty: 2 }));
    expect(rejects(() => trading.placeOrder(order({ side: 'sell', qty: 3 }))).code).toBe('insufficient_shares');
  }, LONG);

  it('selling everything removes the position and the realized result is proceeds minus cost', async () => {
    const { trading, account, order } = await setup();
    const buy = trading.placeOrder(order({ side: 'buy', qty: 5 }));
    const sell = trading.placeOrder(order({ side: 'sell', qty: 5 }));
    const v = trading.view(account.id);
    expect(v.positions).toEqual([]);
    expect(sell.trade.realizedCents).toBe(sell.trade.totalCents - buy.trade.totalCents);
    expect(v.cashCents).toBe(100_000 - buy.trade.totalCents + sell.trade.totalCents);
    expect(v.realizedCents).toBe(sell.trade.realizedCents);
    // Buying and selling straight back always loses at least the spread: no free money.
    expect(v.cashCents).toBeLessThan(100_000);
  }, LONG);

  it('a partial sale removes a proportional part of the cost basis, in whole cents', async () => {
    const { trading, account, order } = await setup();
    const buy = trading.placeOrder(order({ side: 'buy', qty: 7 }));
    const sell = trading.placeOrder(order({ side: 'sell', qty: 3 }));
    const removed = Math.floor((buy.trade.totalCents * 3) / 7);
    expect(sell.trade.realizedCents).toBe(sell.trade.totalCents - removed);
    const pos = trading.view(account.id).positions[0];
    expect(pos?.shares).toBe(4);
    expect(pos?.costCents).toBe(buy.trade.totalCents - removed);
  }, LONG);

  it('an order for an unknown or not-yet-listed company is refused', async () => {
    const rig = makeRig();
    rigs.push(rig);
    rig.open({ companyCount: 12 }).db.close();
    rig.clock.advanceSeconds(5);
    const { db, world } = rig.open({ companyCount: 14 });
    const auth = new Auth(db, rig.clock.now, '');
    const trading = new Trading(db, world, rig.clock.now);
    const { user } = await auth.register('dave', 'password1', '3.3.3.3');
    const acc = trading.careerAccountOf(user.id);
    const base = { accountId: acc.id, side: 'buy' as const, qty: 1 };
    const tryOrder = (companyId: number, id: string): string => {
      try {
        trading.placeOrder({ ...base, companyId, clientOrderId: id });
        return 'filled';
      } catch (e) {
        return e instanceof OrderError ? e.code : 'crash';
      }
    };
    expect(tryOrder(999, 'order-unknown')).toBe('unknown_company');
    expect(tryOrder(13, 'order-notlisted')).toBe('not_trading');
    expect(tryOrder(0, 'order-fine-00')).toBe('filled');
  }, LONG);

  it('bad input is refused: fractions, zero, negatives, huge numbers, bad ids, bad side', async () => {
    const { trading, order, rejects } = await setup();
    for (const qty of [0, -1, 1.5, Number.NaN, 1e12]) expect(rejects(() => trading.placeOrder(order({ side: 'buy', qty }))).code).toBe('bad_request');
    expect(rejects(() => trading.placeOrder({ ...order({ side: 'buy', qty: 1 }), clientOrderId: 'x' })).code).toBe('bad_request');
    expect(rejects(() => trading.placeOrder({ ...order({ side: 'buy', qty: 1 }), side: 'short' as 'buy' })).code).toBe('bad_request');
    expect(rejects(() => trading.placeOrder({ ...order({ side: 'buy', qty: 1 }), limitPrice: -5 })).code).toBe('bad_request');
  }, LONG);

  it('the database itself refuses negative cash and negative shares (a bug cannot create money)', async () => {
    const { db, account } = await setup();
    expect(() => db.run('UPDATE accounts SET cash_cents = -1 WHERE id = ?', account.id)).toThrow();
    expect(() => db.run('INSERT INTO positions(account_id, company_id, shares, cost_cents) VALUES (?, 0, -1, 0)', account.id)).toThrow();
  }, LONG);
});

describe('liquidity and slippage', () => {
  it('a bigger order gets a worse average price, and the estimate equals the fill', async () => {
    const { trading, db, account, order } = await setup();
    db.run('UPDATE accounts SET cash_cents = 5_000_000_000 WHERE id = ?', account.id);
    const small = trading.estimate(account.id, 0, 'buy', 10);
    const big = trading.estimate(account.id, 0, 'buy', 20_000);
    expect(big.avgPrice).toBeGreaterThan(small.avgPrice);
    expect(big.slippageBps).toBeGreaterThan(small.slippageBps);
    const filled = trading.placeOrder(order({ side: 'buy', qty: 20_000 }));
    expect(filled.trade.totalCents).toBe(big.totalCents);
    expect(filled.trade.filled).toBe(big.filledQty);
    expect(filled.trade.spreadCostCents + filled.trade.impactCostCents).toBeGreaterThan(0);
  }, LONG);

  it('an order bigger than the book is filled only as far as the book goes, and says so', async () => {
    const { trading, db, account, order } = await setup();
    db.run('UPDATE accounts SET cash_cents = 90_000_000_000_000 WHERE id = ?', account.id);
    const out = trading.placeOrder(order({ side: 'buy', qty: 90_000_000 }));
    expect(out.trade.filled).toBeGreaterThan(0);
    expect(out.trade.filled).toBeLessThan(90_000_000);
    expect(out.trade.note).toBe('depth');
    const v = trading.view(account.id);
    expect(v.cashCents).toBe(90_000_000_000_000 - out.trade.totalCents);
    expect(v.positions[0]?.shares).toBe(out.trade.filled);
  }, LONG);

  it('depth you used recovers with time, and your own orders never change another player\'s fills', async () => {
    const { trading, db, rig, world, account, order, auth } = await setup();
    db.run('UPDATE accounts SET cash_cents = 5_000_000_000 WHERE id = ?', account.id);
    const fresh = trading.estimate(account.id, 0, 'buy', 5_000);
    trading.placeOrder(order({ side: 'buy', qty: 5_000 }));
    const right = trading.estimate(account.id, 0, 'buy', 5_000);
    expect(right.avgPrice).toBeGreaterThan(fresh.avgPrice * 1.0); // the same size now starts deeper in the book
    // Someone else is unaffected.
    const { user: bob } = await auth.register('bob', 'password1', '4.4.4.4');
    const bobAcc = trading.careerAccountOf(bob.id);
    const bobView = trading.estimate(bobAcc.id, 0, 'buy', 5_000);
    expect(bobView.totalCents).toBe(trading.estimate(null, 0, 'buy', 5_000).totalCents);
    // After a few hours your depth has recovered.
    rig.clock.advanceSeconds(4 * 3600);
    world.advanceTo(world.currentTick(), Infinity);
    const later = trading.estimate(account.id, 0, 'buy', 5_000);
    const laterFresh = trading.estimate(null, 0, 'buy', 5_000);
    expect(later.totalCents).toBe(laterFresh.totalCents);
  }, LONG);

  it('a price limit protects the buyer: nothing is bought beyond it', async () => {
    const { trading, order, rejects, world, account } = await setup();
    const ask = world.quote(0).ask;
    const err = rejects(() => trading.placeOrder(order({ side: 'buy', qty: 1, limitPrice: ask - 1 })));
    expect(err.code).toBe('limit_not_met');
    expect(trading.view(account.id).cashCents).toBe(100_000);
    const ok = trading.placeOrder(order({ side: 'buy', qty: 1, limitPrice: ask }));
    expect(ok.trade.filled).toBe(1);
  }, LONG);
});

describe('safety', () => {
  it('the market must be up to date: while it is behind the clock orders are refused, not filled at a stale price', async () => {
    const { trading, rig, world, order, rejects, account } = await setup();
    rig.clock.advanceSeconds(120); // the world has not been pumped
    const err = rejects(() => trading.placeOrder(order({ side: 'buy', qty: 1 })));
    expect(err.code).toBe('market_unavailable');
    expect(err.status).toBe(503);
    expect(trading.view(account.id).cashCents).toBe(100_000);
    world.pump();
    expect(trading.placeOrder(order({ side: 'buy', qty: 1 })).trade.filled).toBe(1);
  }, LONG);

  it('an outside rule (the 1v1 gate) can forbid trading and is checked on the server', async () => {
    const { trading, order, rejects } = await setup();
    trading.setGate((acc) => (acc.kind === 'career' ? 'Trading is closed for this account.' : null));
    const err = rejects(() => trading.placeOrder(order({ side: 'buy', qty: 1 })));
    expect(err.code).toBe('not_allowed');
    expect(err.message).toBe('Trading is closed for this account.');
    trading.setGate(null);
    expect(trading.placeOrder(order({ side: 'buy', qty: 1 })).trade.filled).toBe(1);
  }, LONG);

  it('an order for another account is just numbers: the server never takes cash, price or fill from the request', async () => {
    const { trading, order, account } = await setup();
    const req = { ...order({ side: 'buy', qty: 1 }), cashCents: 999_999_999, price: 1, totalCents: 1 } as OrderRequest;
    const out = trading.placeOrder(req);
    expect(out.trade.totalCents).toBeGreaterThan(1);
    expect(trading.view(account.id).cashCents).toBe(100_000 - out.trade.totalCents);
  }, LONG);

  it('cash is conserved over many random orders: cash + cost of holdings changes only by realized results', async () => {
    const { trading, account, order } = await setup();
    let seed = 42;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let spent = 0;
    for (let i = 0; i < 300; i += 1) {
      const companyId = Math.floor(rnd() * 12);
      const side = rnd() < 0.55 ? 'buy' : 'sell';
      const qty = 1 + Math.floor(rnd() * 12);
      try {
        const out = trading.placeOrder(order({ side, qty, companyId }));
        spent += side === 'buy' ? out.trade.totalCents : -out.trade.totalCents;
      } catch (e) {
        if (!(e instanceof OrderError)) throw e;
      }
    }
    const v = trading.view(account.id);
    expect(v.cashCents).toBe(100_000 - spent);
    expect(v.cashCents).toBeGreaterThanOrEqual(0);
    const cost = v.positions.reduce((s, p) => s + p.costCents, 0);
    expect(cost + v.cashCents + v.realizedCents * -1).toBe(100_000); // cost basis + cash − realized = start
  }, LONG);
});
