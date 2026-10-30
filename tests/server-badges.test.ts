// Achievement badges (server/badges.ts, src/shared/badgeCatalog.ts, docs/world.md §22). The properties that matter: every badge in the list has exactly one
// rule, a badge is given once when the play shows it was earned (never to a computer player, never taken back), a player sees only his own badges page
// but everybody sees the best three next to a name, and the player is told when he gets one. Badges give no money.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { Badges, HOME_RUN_CENTS, RULE_IDS } from '../server/badges';
import { NEW_ACCOUNT_WAIT_MS } from '../server/chat';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { BADGES, BADGES_SHOWN, BADGE_GROUPS, TIER_NAMES, badgeById, bestBadges } from '../src/shared/badgeCatalog';
import { TUTORIAL_STEPS } from '../src/learn/tutorial';
import { STOCK_SECTOR_IDS } from '../src/world/params';
import { Clock } from './helpers/server';

const LONG = 240_000;
const PASSWORD = 'a-good-password';

interface Running {
  app: App;
  server: Server;
  base: string;
  dir: string;
  clock: Clock;
}
const running: Running[] = [];
const dirs: string[] = [];
const streams: AbortController[] = [];
afterEach(async () => {
  while (streams.length > 0) streams.pop()?.abort();
  while (running.length > 0) {
    const r = running.pop() as Running;
    await new Promise<void>((done) => {
      r.server.closeAllConnections?.();
      r.server.close(() => done());
    });
    try {
      r.app.close();
    } catch {
      // already closed by the test
    }
  }
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function boot(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'tq-badge-'));
  dirs.push(dir);
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: dir, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0 });
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const r = { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, clock };
  running.push(r);
  return r;
}

async function call(r: Running, path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(r.base + path, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function signUp(r: Running, name: string): Promise<string> {
  const res = await fetch(r.base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PASSWORD }) });
  expect(res.status).toBe(201);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

async function listen(r: Running, cookie?: string): Promise<{ text(): string }> {
  const controller = new AbortController();
  streams.push(controller);
  const res = await fetch(r.base + '/api/stream', { headers: cookie ? { Cookie: cookie } : {}, signal: controller.signal });
  expect(res.status).toBe(200);
  let text = '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value);
      }
    } catch {
      // aborted by the test
    }
  })();
  return { text: () => text };
}
const until = async (check: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((done) => setTimeout(done, 20));
  }
  return check();
};

const db = (r: Running) => r.app.services.db;
const idOf = (r: Running, name: string): number => (db(r).get<{ id: number }>('SELECT id FROM users WHERE username = ?', name) as { id: number }).id;
const careerOf = (r: Running, name: string): number => (db(r).get<{ id: number }>("SELECT id FROM accounts WHERE user_id = ? AND kind = 'career'", idOf(r, name)) as { id: number }).id;
const companyIds = (r: Running): number[] => db(r).all<{ id: number }>('SELECT id FROM companies ORDER BY id').map((c) => c.id);
const sweep = (r: Running): number => r.app.services.badges.sweep();
/** The badges a player has, as a sorted list of ids. */
const has = (r: Running, name: string): string[] =>
  db(r)
    .all<{ badge: string }>('SELECT badge FROM user_badges WHERE user_id = ? ORDER BY badge', idOf(r, name))
    .map((x) => x.badge);
const withoutWelcome = (ids: string[]): string[] => ids.filter((x) => x !== 'welcome');

let nextOrder = 0;
/** A trade row without the trading rules (the badge rules only read what was saved). */
function plantTrade(r: Running, account: number, opts: { side?: 'buy' | 'sell'; realized?: number; company?: number; ms?: number; short?: boolean } = {}): void {
  nextOrder += 1;
  db(r).run(
    "INSERT INTO trades(account_id, client_order_id, company_id, side, requested, filled, total_cents, mid_cents, spread_cents, impact_cents, realized_cents, tick, created_ms, result_json, short) VALUES (?, ?, ?, ?, 1, 1, 100, 100, 0, 0, ?, 1, ?, '{}', ?)",
    account,
    `plant-${nextOrder}`,
    opts.company ?? (companyIds(r)[0] as number),
    opts.side ?? 'buy',
    opts.realized ?? 0,
    opts.ms ?? r.clock.now(),
    opts.short === true ? 1 : 0,
  );
}
/** Players without a password: real people as far as the rules go (not computer players), each with a Career account. */
function bulkPlayers(r: Running, prefix: string, count: number): string[] {
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = `${prefix}${i}`;
    const id = db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES (?, ?, 'x', 'player', ?)", name, name, r.clock.now()).lastInsertRowid;
    db(r).run("INSERT INTO accounts(user_id, kind, match_id, cash_cents, start_cash_cents, created_ms) VALUES (?, 'career', NULL, 100000, 100000, ?)", id, r.clock.now());
    names.push(name);
  }
  return names;
}

describe('the list of badges', () => {
  it('BADGE-1: every badge has a name, a way to get it, one tier and one rule; none is listed twice; the best three come first by tier', () => {
    const ids = BADGES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(BADGES.map((b) => b.name)).size).toBe(BADGES.length);
    expect([...RULE_IDS].sort()).toEqual([...ids].sort());
    for (const b of BADGES) {
      expect(b.name.trim().length).toBeGreaterThan(1);
      expect(b.how.trim().endsWith('.')).toBe(true);
      expect([1, 2, 3, 4]).toContain(b.tier);
      expect(BADGE_GROUPS.map((g) => g.id)).toContain(b.group);
      expect(Array.from(b.icon).length).toBeGreaterThan(0);
      expect(badgeById(b.id)).toBe(b);
    }
    for (const g of BADGE_GROUPS) expect(BADGES.filter((b) => b.group === g.id).length).toBeGreaterThanOrEqual(4);
    expect(TIER_NAMES.slice(1)).toEqual(['Bronze', 'Silver', 'Gold', 'Diamond']);
    // Highest tier first, then the order of the list; at most three; names this version does not know are left out.
    const all = BADGES.map((b) => b.id);
    const top = bestBadges(all);
    expect(top).toHaveLength(BADGES_SHOWN);
    expect(top.map((id) => badgeById(id)?.tier)).toEqual([...top].map((id) => badgeById(id)?.tier).sort((a, b) => (b as number) - (a as number)));
    expect(top[0]).toBe('profit_100k');
    expect(bestBadges(['welcome', 'first_trade', 'made_up', 'launch_stock'])).toEqual(['launch_stock', 'first_trade', 'welcome']);
    expect(bestBadges([])).toEqual([]);
    expect(bestBadges(['welcome', 'first_trade'], 1)).toEqual(['first_trade']);
  });
});

describe('giving badges', () => {
  it('BADGE-2: everybody real gets Welcome once; computer players get nothing; looking again gives nothing new and keeps the first time', async () => {
    const r = await boot();
    await signUp(r, 'alice');
    await signUp(r, 'boss');
    db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('robot', 'robot', 'bot', 'player', 0)");
    const botId = idOf(r, 'robot');
    db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('robot2', 'robot2', 'x', 'player', 0)");
    db(r).run("INSERT INTO bots(user_id, persona) VALUES (?, 'sam')", idOf(r, 'robot2'));
    const t0 = r.clock.now();
    expect(sweep(r)).toBeGreaterThan(0);
    expect(has(r, 'alice')).toContain('welcome');
    expect(has(r, 'boss')).toContain('welcome');
    expect(has(r, 'robot')).toEqual([]);
    expect(has(r, 'robot2')).toEqual([]);
    r.clock.advanceSeconds(120);
    expect(sweep(r)).toBe(0);
    expect(db(r).get<{ earned_ms: number }>("SELECT earned_ms FROM user_badges WHERE user_id = ? AND badge = 'welcome'", idOf(r, 'alice'))?.earned_ms).toBe(t0);
    expect(botId).toBeGreaterThan(0);
  }, LONG);

  it('BADGE-3: trading badges: the number of trades, a sale at a profit and a limit order that fills; trades in a 1v1 match do not count; nothing is taken back', async () => {
    const r = await boot();
    await signUp(r, 'alice');
    await signUp(r, 'bob');
    await signUp(r, 'cara');
    sweep(r);
    expect(has(r, 'alice')).toEqual(['welcome']);
    plantTrade(r, careerOf(r, 'alice'));
    sweep(r);
    expect(has(r, 'alice')).toEqual(['first_trade', 'welcome']);
    for (let i = 0; i < 8; i += 1) plantTrade(r, careerOf(r, 'alice'));
    sweep(r);
    expect(withoutWelcome(has(r, 'alice'))).toEqual(['first_trade']);
    plantTrade(r, careerOf(r, 'alice'));
    sweep(r);
    expect(withoutWelcome(has(r, 'alice'))).toEqual(['first_trade', 'trades_10']);
    for (let i = 0; i < 90; i += 1) plantTrade(r, careerOf(r, 'alice'));
    sweep(r);
    expect(withoutWelcome(has(r, 'alice'))).toEqual(['first_trade', 'trades_10', 'trades_100']);
    // A sale at a loss is not In the Green; one at a profit is.
    plantTrade(r, careerOf(r, 'bob'), { side: 'sell', realized: -500 });
    sweep(r);
    expect(withoutWelcome(has(r, 'bob'))).toEqual(['first_trade']);
    plantTrade(r, careerOf(r, 'bob'), { side: 'sell', realized: 1 });
    sweep(r);
    expect(withoutWelcome(has(r, 'bob'))).toEqual(['first_profit', 'first_trade']);
    // A match account is a one-off account for one 1v1 match: its trades are not Career trades.
    const matchAccount = db(r).run("INSERT INTO accounts(user_id, kind, match_id, cash_cents, start_cash_cents, created_ms) VALUES (?, 'match', NULL, 100000, 100000, ?)", idOf(r, 'cara'), r.clock.now()).lastInsertRowid;
    plantTrade(r, matchAccount, { side: 'sell', realized: 900 });
    sweep(r);
    expect(has(r, 'cara')).toEqual(['welcome']);
    // A limit order counts once it has filled (even in part), not while it only waits.
    const order = (account: number, fills: number, id: string) =>
      db(r).run(
        "INSERT INTO limit_orders(account_id, company_id, client_order_id, side, qty, filled, limit_cents, created_tick, expires_tick, fills, created_ms) VALUES (?, ?, ?, 'buy', 5, ?, 100, 1, 99, ?, ?)",
        account,
        companyIds(r)[0] as number,
        id,
        fills > 0 ? 1 : 0,
        fills,
        r.clock.now(),
      );
    order(careerOf(r, 'cara'), 0, 'waiting-1');
    sweep(r);
    expect(has(r, 'cara')).toEqual(['welcome']);
    order(careerOf(r, 'cara'), 1, 'filled-1');
    sweep(r);
    expect(has(r, 'cara')).toEqual(['limit_filled', 'welcome']);
    // The trades are wiped (as an account reset might), and the badges stay.
    db(r).run('DELETE FROM trades');
    sweep(r);
    expect(withoutWelcome(has(r, 'alice'))).toEqual(['first_trade', 'trades_10', 'trades_100']);
  }, LONG);

  it('BADGE-4: profit badges: $1,000, $10,000 and $100,000 above the start, only for a player who traded; a later loss does not take them away', async () => {
    const r = await boot();
    await signUp(r, 'alice');
    await signUp(r, 'bob');
    const setProfit = (name: string, cents: number) => db(r).run('UPDATE accounts SET cash_cents = ? WHERE id = ?', 100_000 + cents, careerOf(r, name));
    // Bob has money from a gift but never traded: no profit badge.
    setProfit('bob', 20_000_000);
    plantTrade(r, careerOf(r, 'alice'));
    setProfit('alice', 99_999);
    sweep(r);
    expect(has(r, 'alice').filter((x) => x.startsWith('profit'))).toEqual([]);
    expect(has(r, 'bob').filter((x) => x.startsWith('profit'))).toEqual([]);
    setProfit('alice', 100_000);
    sweep(r);
    expect(has(r, 'alice').filter((x) => x.startsWith('profit'))).toEqual(['profit_1k']);
    setProfit('alice', 1_000_000);
    sweep(r);
    expect(has(r, 'alice').filter((x) => x.startsWith('profit')).sort()).toEqual(['profit_10k', 'profit_1k']);
    // A big jump gives every step on the way at once.
    setProfit('alice', 10_000_000);
    sweep(r);
    expect(has(r, 'alice').filter((x) => x.startsWith('profit')).sort()).toEqual(['profit_100k', 'profit_10k', 'profit_1k']);
    setProfit('alice', 0);
    sweep(r);
    expect(has(r, 'alice').filter((x) => x.startsWith('profit'))).toHaveLength(3);
    // Badges never change anybody's money.
    expect(db(r).get<{ cash_cents: number }>('SELECT cash_cents FROM accounts WHERE id = ?', careerOf(r, 'alice'))?.cash_cents).toBe(100_000);
  }, LONG);

  it('BADGE-5: launching badges: a stock, a memecoin, a picture for your own company, the first player who buys it and ten different players who buy it', async () => {
    const r = await boot();
    await signUp(r, 'alice');
    await signUp(r, 'bob');
    const [c1, c2] = companyIds(r) as [number, number];
    const launch = (name: string, company: number, kind: 'stock' | 'coin') =>
      db(r).run("INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms) VALUES (?, ?, ?, ?, 100, 100, 1, 100, ?)", company, idOf(r, name), kind, `launch-${company}`, r.clock.now());
    launch('alice', c1, 'stock');
    sweep(r);
    expect(withoutWelcome(has(r, 'alice'))).toEqual(['launch_stock']);
    launch('alice', c2, 'coin');
    sweep(r);
    expect(withoutWelcome(has(r, 'alice'))).toEqual(['launch_coin', 'launch_stock']);
    // A picture that somebody else (the owner) set does not count; one the launcher set does.
    db(r).run("INSERT INTO company_pictures(company_id, mime, data, updated_ms, set_by) VALUES (?, 'image/png', ?, 1, ?)", c1, new Uint8Array([1]), idOf(r, 'bob'));
    sweep(r);
    expect(has(r, 'alice')).not.toContain('company_logo');
    db(r).run('UPDATE company_pictures SET set_by = ? WHERE company_id = ?', idOf(r, 'alice'), c1);
    sweep(r);
    expect(has(r, 'alice')).toContain('company_logo');
    expect(has(r, 'bob')).not.toContain('company_logo');
    // Her own buying does not count, a sale does not count, a computer player does not count, a Career account of another player does.
    plantTrade(r, careerOf(r, 'alice'), { company: c1 });
    plantTrade(r, careerOf(r, 'bob'), { company: c1, side: 'sell' });
    db(r).run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('robot', 'robot', 'bot', 'player', 0)");
    const botAccount = db(r).run("INSERT INTO accounts(user_id, kind, match_id, cash_cents, start_cash_cents, created_ms) VALUES (?, 'career', NULL, 1, 1, 0)", idOf(r, 'robot')).lastInsertRowid;
    plantTrade(r, botAccount, { company: c1 });
    sweep(r);
    expect(has(r, 'alice')).not.toContain('first_investor');
    plantTrade(r, careerOf(r, 'bob'), { company: c1 });
    sweep(r);
    expect(has(r, 'alice')).toContain('first_investor');
    expect(has(r, 'alice')).not.toContain('ten_investors');
    // Nine more different players are not enough with bob making nine; ten different players are.
    const buyers = bulkPlayers(r, 'b', 9);
    for (const name of buyers.slice(0, 8)) plantTrade(r, careerOf(r, name), { company: c1 });
    sweep(r);
    expect(has(r, 'alice')).not.toContain('ten_investors');
    plantTrade(r, careerOf(r, buyers[8] as string), { company: c1 });
    plantTrade(r, careerOf(r, buyers[8] as string), { company: c1 });
    sweep(r);
    expect(has(r, 'alice')).toContain('ten_investors');
    expect(has(r, 'bob')).not.toContain('launch_stock');
  }, LONG);

  it('BADGE-6: friends and chat badges: a friend, five friends, a group, a public message, a picture, and one week and one month of having the account', async () => {
    const r = await boot();
    await signUp(r, 'alice');
    const others = bulkPlayers(r, 'f', 6);
    const befriend = (a: string, b: string) => {
      const [x, y] = [idOf(r, a), idOf(r, b)].sort((p, q) => p - q) as [number, number];
      db(r).run("INSERT INTO friendships(user_a, user_b, requester_id, status, created_ms, accepted_ms) VALUES (?, ?, ?, 'accepted', 1, 2)", x, y, x);
    };
    // A request that was not answered is not a friend.
    const [x, y] = [idOf(r, 'alice'), idOf(r, others[0] as string)].sort((p, q) => p - q) as [number, number];
    db(r).run("INSERT INTO friendships(user_a, user_b, requester_id, status, created_ms) VALUES (?, ?, ?, 'pending', 1)", x, y, x);
    sweep(r);
    expect(has(r, 'alice')).toEqual(['welcome']);
    db(r).run('DELETE FROM friendships');
    befriend('alice', others[0] as string);
    sweep(r);
    expect(has(r, 'alice')).toEqual(['first_friend', 'welcome']);
    expect(has(r, others[0] as string)).toContain('first_friend');
    for (const name of others.slice(1, 4)) befriend('alice', name);
    sweep(r);
    expect(has(r, 'alice')).not.toContain('five_friends');
    befriend('alice', others[4] as string);
    sweep(r);
    expect(has(r, 'alice')).toContain('five_friends');
    // A group chat counts once the player is in it (an invitation is not enough); a direct chat is not a group.
    const direct = db(r).run("INSERT INTO conversations(kind, direct_a, direct_b, created_ms, last_ms) VALUES ('direct', ?, ?, 1, 1)", idOf(r, others[0] as string), idOf(r, others[1] as string)).lastInsertRowid;
    db(r).run("INSERT INTO conversation_members(conversation_id, user_id, state, joined_ms) VALUES (?, ?, 'member', 1)", direct, idOf(r, others[5] as string));
    const group = db(r).run("INSERT INTO conversations(kind, title, created_by, created_ms, last_ms) VALUES ('group', 'club', ?, 1, 1)", idOf(r, others[0] as string)).lastInsertRowid;
    db(r).run("INSERT INTO conversation_members(conversation_id, user_id, state, joined_ms) VALUES (?, ?, 'invited', 1)", group, idOf(r, 'alice'));
    sweep(r);
    expect(has(r, 'alice')).not.toContain('first_group');
    expect(has(r, others[5] as string)).not.toContain('first_group');
    db(r).run("UPDATE conversation_members SET state = 'member' WHERE user_id = ?", idOf(r, 'alice'));
    sweep(r);
    expect(has(r, 'alice')).toContain('first_group');
    // The public chat, a picture.
    db(r).run("INSERT INTO chat_messages(user_id, body, created_ms) VALUES (?, 'hi', 1)", idOf(r, 'alice'));
    db(r).run("INSERT INTO user_avatars(user_id, mime, data, updated_ms) VALUES (?, 'image/png', ?, 1)", idOf(r, 'alice'), new Uint8Array([1]));
    sweep(r);
    expect(has(r, 'alice')).toContain('first_chat');
    expect(has(r, 'alice')).toContain('profile_pic');
    // Time: six days is not a week.
    r.clock.advanceSeconds(6 * 86_400);
    sweep(r);
    expect(has(r, 'alice')).not.toContain('week_one');
    r.clock.advanceSeconds(86_400);
    sweep(r);
    expect(has(r, 'alice')).toContain('week_one');
    expect(has(r, 'alice')).not.toContain('month_one');
    r.clock.advanceSeconds(23 * 86_400);
    sweep(r);
    expect(has(r, 'alice')).toContain('month_one');
  }, LONG);

  it('BADGE-7: learn and match badges: lessons, a streak, the whole tutorial, a match played to the end, a win and five wins', async () => {
    const r = await boot();
    await signUp(r, 'alice');
    await signUp(r, 'bob');
    await signUp(r, 'cara');
    const progress = (name: string, lessons: number, best: number, mask = 0) =>
      db(r).run(
        'INSERT INTO learn_progress(user_id, tutorial_mask, xp, streak, best_streak, lessons_done, updated_ms) VALUES (?, ?, 0, 0, ?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET tutorial_mask = excluded.tutorial_mask, best_streak = excluded.best_streak, lessons_done = excluded.lessons_done',
        idOf(r, name),
        mask,
        best,
        lessons,
      );
    progress('alice', 0, 4);
    sweep(r);
    expect(has(r, 'alice')).toEqual(['welcome']);
    progress('alice', 1, 5);
    sweep(r);
    expect(has(r, 'alice')).toEqual(['first_lesson', 'streak_5', 'welcome']);
    progress('alice', 10, 5);
    sweep(r);
    expect(has(r, 'alice')).toContain('lessons_10');
    expect(has(r, 'alice')).not.toContain('lessons_50');
    progress('alice', 50, 5);
    sweep(r);
    expect(has(r, 'alice')).toContain('lessons_50');
    // The whole tutorial: every step. One step short is not enough.
    const full = 2 ** TUTORIAL_STEPS - 1;
    progress('bob', 0, 0, full - 1);
    sweep(r);
    expect(has(r, 'bob')).not.toContain('tutorial_done');
    progress('bob', 0, 0, full);
    sweep(r);
    expect(has(r, 'bob')).toContain('tutorial_done');
    // Matches: playing to the end, winning, and five wins. A forfeit is not "played to the end", and not a win.
    let matchNo = 0;
    const match = (winner: string | null, results: [string, 'win' | 'loss' | 'tie' | 'forfeit'][]) => {
      matchNo += 1;
      db(r).run(
        "INSERT INTO matches(id, state, created_ms, start_tick, end_tick, duration_ticks, start_cash_cents, settled_ms, outcome, winner_user_id) VALUES (?, 'finished', 1, 10, 20, 10, 100000, 2, ?, ?)",
        matchNo,
        winner === null ? 'tie' : 'win',
        winner === null ? null : idOf(r, winner),
      );
      for (const [name, result] of results) db(r).run('INSERT INTO match_players(match_id, user_id, joined_ms, last_seen_ms, active, result) VALUES (?, ?, 1, 1, 0, ?)', matchNo, idOf(r, name), result);
    };
    match(null, [['cara', 'forfeit'], ['bob', 'forfeit']]);
    sweep(r);
    expect(has(r, 'cara')).toEqual(['welcome']);
    match('bob', [['bob', 'win'], ['cara', 'loss']]);
    sweep(r);
    expect(has(r, 'cara')).toEqual(['first_match', 'welcome']);
    expect(has(r, 'bob')).toContain('first_match');
    expect(has(r, 'bob')).toContain('first_win');
    expect(has(r, 'bob')).not.toContain('wins_5');
    for (let i = 0; i < 4; i += 1) match('bob', [['bob', 'win'], ['cara', 'loss']]);
    sweep(r);
    expect(has(r, 'bob')).toContain('wins_5');
    expect(has(r, 'cara')).not.toContain('first_win');
  }, LONG);
});

describe('showing badges', () => {
  it('BADGE-8: a player reads his own badges page (every badge, when he got it, how many have it); it needs a sign-in and looks again when it opens', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    await signUp(r, 'bob');
    expect((await call(r, '/api/badges')).status).toBe(401);
    plantTrade(r, careerOf(r, 'alice'));
    const t = r.clock.now();
    const page = (await call(r, '/api/badges', { cookie: alice })).json;
    expect(page.badges.map((b: any) => b.id)).toEqual(BADGES.map((b) => b.id));
    expect(page.players).toBe(2);
    const by = Object.fromEntries(page.badges.map((b: any) => [b.id, b]));
    expect(by.first_trade).toEqual({ id: 'first_trade', earnedMs: t, owners: 1 });
    expect(by.welcome.earnedMs).toBe(t);
    expect(by.trades_10).toEqual({ id: 'trades_10', earnedMs: null, owners: 0 });
    // Bob's page (opened by him) counted him; Alice's page shows nothing of Bob's own badges except in the count.
    r.clock.advanceSeconds(60);
    const bob = (await call(r, '/api/badges', { cookie: await (async () => { const res = await fetch(r.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: PASSWORD }) }); return (res.headers.get('set-cookie') ?? '').split(';')[0] as string; })() })).json;
    expect(bob.badges.find((b: any) => b.id === 'welcome')).toMatchObject({ earnedMs: t + 60_000, owners: 2 });
    expect(bob.badges.find((b: any) => b.id === 'first_trade')).toMatchObject({ earnedMs: null, owners: 1 });
    expect(Object.keys(bob).sort()).toEqual(['badges', 'players']);
  }, LONG);

  it('BADGE-9: the player list shows each player\'s best three badges (highest tier first) to everybody, and none for a player who has none', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    await signUp(r, 'bob');
    r.clock.advanceSeconds(NEW_ACCOUNT_WAIT_MS / 1000 + 1);
    const t = r.clock.now();
    for (const [name, badge] of [['bob', 'welcome'], ['bob', 'first_trade'], ['bob', 'profit_10k'], ['bob', 'launch_stock'], ['bob', 'wins_5']] as const) {
      db(r).run('INSERT INTO user_badges(user_id, badge, earned_ms) VALUES (?, ?, ?)', idOf(r, name), badge, t);
    }
    const list = (await call(r, '/api/players', { cookie: alice })).json.players as { username: string; badges: string[] }[];
    expect(Object.fromEntries(list.map((p) => [p.username, p.badges]))).toEqual({ alice: [], bob: ['profit_10k', 'wins_5', 'launch_stock'] });
    // The page is for signed-in players, like the rest of the list.
    expect((await call(r, '/api/players')).status).toBe(401);
  }, LONG);

  it('BADGE-10: a player is told over his live stream when he gets a badge, only him, and only once', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    const bob = await signUp(r, 'bob');
    sweep(r);
    const a = await listen(r, alice);
    const b = await listen(r, bob);
    plantTrade(r, careerOf(r, 'alice'));
    expect(sweep(r)).toBe(1);
    expect(await until(() => a.text().includes('event: badges'))).toBe(true);
    expect(a.text()).toContain('"earned":["first_trade"]');
    expect(b.text()).not.toContain('event: badges');
    expect(sweep(r)).toBe(0);
    await new Promise((done) => setTimeout(done, 150));
    expect(a.text().match(/event: badges/g)).toHaveLength(1);
  }, LONG);

  it('BADGE-11: the start-up of the server gives the badges a few seconds later and then now and then (a timer), and closing the server stops it', async () => {
    const r = await boot();
    await signUp(r, 'alice');
    expect(has(r, 'alice')).toEqual([]);
    r.app.start();
    expect(await until(() => has(r, 'alice').includes('welcome'), 9000)).toBe(true);
  }, LONG);
});

const DAY = 86_400_000;
/** A match account for a player (a one-off account: its trades never count for Career badges). */
const matchAccountOf = (r: Running, name: string): number =>
  db(r).run("INSERT INTO accounts(user_id, kind, match_id, cash_cents, start_cash_cents, created_ms) VALUES (?, 'match', NULL, 100000, 100000, ?)", idOf(r, name), r.clock.now()).lastInsertRowid as number;
const openPosition = (r: Running, account: number, company: number, short = false): void => {
  db(r).run('INSERT INTO positions(account_id, company_id, shares, cost_cents, short) VALUES (?, ?, 5, 500, ?)', account, company, short ? 1 : 0);
};

describe('the second batch of badges (docs/world.md §28)', () => {
  it('BADGE-12: the list grew to 64 (12 more for daily goals and ranked 1v1, 8 more for predictions, the weekly podium and teams); four are secret and each secret one has a hint; the others have none; the best three still start with the highest tier', () => {
    expect(BADGES).toHaveLength(64);
    const secret = BADGES.filter((b) => b.secret === true);
    expect(secret.map((b) => b.id).sort()).toEqual(['all_sectors', 'chatterbox', 'lesson_learned', 'trade_days_7']);
    for (const b of BADGES) {
      if (b.secret === true) expect((b.hint ?? '').trim().endsWith('.')).toBe(true);
      else expect(b.hint).toBeUndefined();
    }
    expect(BADGES.find((b) => b.id === 'all_sectors')?.how).toContain(String(STOCK_SECTOR_IDS.length));
    expect(HOME_RUN_CENTS).toBe(50_000);
    expect(BADGES.find((b) => b.id === 'home_run')?.how).toContain('$500');
    // The new diamond badges come after the old Whale, so Whale still leads the best three.
    expect(bestBadges(BADGES.map((b) => b.id))[0]).toBe('profit_100k');
  });

  it('BADGE-13: trading habits: ten winners, a $500 Home Run, trades on seven different days and a thousand trades; a match account never counts', async () => {
    const r = await boot();
    await signUp(r, 'alice');
    await signUp(r, 'bob');
    const alice = careerOf(r, 'alice');
    const start = r.clock.now();
    // Nine trades at a profit, one at a loss and one at zero are not ten winners; the tenth profit is.
    for (let i = 0; i < 9; i += 1) plantTrade(r, alice, { side: 'sell', realized: 10 + i });
    plantTrade(r, alice, { side: 'sell', realized: -300 });
    plantTrade(r, alice, { side: 'sell', realized: 0 });
    sweep(r);
    expect(has(r, 'alice')).not.toContain('winners_10');
    plantTrade(r, alice, { side: 'sell', realized: 1 });
    sweep(r);
    expect(has(r, 'alice')).toContain('winners_10');
    // A profit of $499.99 is not a Home Run; $500.00 is.
    expect(has(r, 'alice')).not.toContain('home_run');
    plantTrade(r, alice, { side: 'sell', realized: HOME_RUN_CENTS - 1 });
    sweep(r);
    expect(has(r, 'alice')).not.toContain('home_run');
    plantTrade(r, alice, { side: 'sell', realized: HOME_RUN_CENTS });
    sweep(r);
    expect(has(r, 'alice')).toContain('home_run');
    // Match trades: a big win and ten wins in a 1v1 match give no Career badge.
    const bobMatch = matchAccountOf(r, 'bob');
    for (let i = 0; i < 12; i += 1) plantTrade(r, bobMatch, { side: 'sell', realized: HOME_RUN_CENTS * 2 });
    sweep(r);
    expect(has(r, 'bob')).toEqual(['welcome']);
    // Seven different days: six days with many trades each are not enough, a seventh day is. The day is the calendar day (UTC).
    const bobCareer = careerOf(r, 'bob');
    const day0 = Math.floor(start / DAY) * DAY;
    for (let d = 0; d < 6; d += 1) for (let k = 0; k < 3; k += 1) plantTrade(r, bobCareer, { ms: day0 + d * DAY + k * 1000 });
    sweep(r);
    expect(has(r, 'bob')).not.toContain('trade_days_7');
    plantTrade(r, bobCareer, { ms: day0 + 6 * DAY + DAY - 1 });
    sweep(r);
    expect(has(r, 'bob')).toContain('trade_days_7');
    // Two minutes on either side of midnight are two days.
    const cara = (await signUp(r, 'cara'), careerOf(r, 'cara'));
    for (let d = 0; d < 6; d += 1) plantTrade(r, cara, { ms: day0 + d * DAY + 5000 });
    plantTrade(r, cara, { ms: day0 + 10 * DAY - 1000 });
    plantTrade(r, cara, { ms: day0 + 10 * DAY + 1000 });
    sweep(r);
    expect(has(r, 'cara')).toContain('trade_days_7');
    // A thousand trades: 999 are not enough.
    const dave = (await signUp(r, 'dave'), careerOf(r, 'dave'));
    db(r).tx(() => {
      for (let i = 0; i < 999; i += 1) plantTrade(r, dave);
    });
    sweep(r);
    expect(has(r, 'dave')).not.toContain('trades_1000');
    plantTrade(r, dave);
    sweep(r);
    expect(has(r, 'dave')).toContain('trades_1000');
    expect(has(r, 'dave')).toContain('trades_100');
  }, LONG);

  it('BADGE-14: Diamond Hands: a long position still open, first bought a week ago and never sold from; every other case gives nothing', async () => {
    const r = await boot();
    for (const n of ['alice', 'bob', 'cara', 'dave', 'erin', 'fay']) await signUp(r, n);
    const [c1, c2] = companyIds(r) as [number, number];
    const now = r.clock.now();
    const week = 7 * DAY;
    // Alice: bought just under a week ago and still holds: not yet.
    plantTrade(r, careerOf(r, 'alice'), { company: c1, ms: now - week + 1000 });
    openPosition(r, careerOf(r, 'alice'), c1);
    // Bob: bought long ago, sold a little: no.
    plantTrade(r, careerOf(r, 'bob'), { company: c1, ms: now - 30 * DAY });
    plantTrade(r, careerOf(r, 'bob'), { company: c1, ms: now - 20 * DAY, side: 'sell', realized: 5 });
    openPosition(r, careerOf(r, 'bob'), c1);
    // Cara: a short position opened long ago: no (it is not a long position).
    plantTrade(r, careerOf(r, 'cara'), { company: c1, ms: now - 30 * DAY, short: true });
    openPosition(r, careerOf(r, 'cara'), c1, true);
    // Dave: bought long ago, holds, never sold: yes. A sale of ANOTHER company does not matter.
    plantTrade(r, careerOf(r, 'dave'), { company: c1, ms: now - 30 * DAY });
    plantTrade(r, careerOf(r, 'dave'), { company: c2, ms: now - 10 * DAY, side: 'sell', realized: 5 });
    openPosition(r, careerOf(r, 'dave'), c1);
    // Erin: bought long ago but the position is gone (no row): no.
    plantTrade(r, careerOf(r, 'erin'), { company: c1, ms: now - 30 * DAY });
    // Fay: holds a company that went bankrupt: no.
    plantTrade(r, careerOf(r, 'fay'), { company: c2, ms: now - 30 * DAY });
    openPosition(r, careerOf(r, 'fay'), c2);
    db(r).run('INSERT INTO bankruptcies(company_id, declared_tick, declared_ms, cycle, negative_stories, window_total, price_before_cents) VALUES (?, 1, ?, 1, 3, 1, 100)', c2, now - DAY);
    sweep(r);
    expect(has(r, 'alice')).not.toContain('hold_7d');
    for (const n of ['bob', 'cara', 'erin', 'fay']) expect(has(r, n)).not.toContain('hold_7d');
    expect(has(r, 'dave')).toContain('hold_7d');
    // One more second and Alice has held for a whole week.
    r.clock.advanceSeconds(1);
    sweep(r);
    expect(has(r, 'alice')).toContain('hold_7d');
    // A position in a 1v1 match account does not count.
    const match = matchAccountOf(r, 'erin');
    plantTrade(r, match, { company: c1, ms: now - 30 * DAY });
    openPosition(r, match, c1);
    sweep(r);
    expect(has(r, 'erin')).not.toContain('hold_7d');
  }, LONG);

  it('BADGE-15: Spread Out and Collector count the different stock sectors a player has bought (memecoins, sales, shorts and match trades do not); unknown companies are ignored', async () => {
    const r = await boot();
    await signUp(r, 'alice');
    await signUp(r, 'bob');
    const sectors = [...STOCK_SECTOR_IDS];
    // 13 fake companies, one per stock sector, plus a memecoin and an unknown company, so every sector can be reached in this small test world.
    const map = new Map<number, string>();
    sectors.forEach((sector, i) => map.set(9000 + i, sector));
    map.set(9100, 'meme');
    const service = new Badges({ db: db(r), now: r.clock.now, publishTo: () => undefined, profitOf: () => 0, sectorOf: (id) => map.get(id) });
    const give = (name: string) => service.sweep(idOf(r, name));
    const alice = careerOf(r, 'alice');
    for (let i = 0; i < 4; i += 1) plantTrade(r, alice, { company: 9000 + i });
    give('alice');
    expect(has(r, 'alice')).not.toContain('sectors_5');
    // The same sector again, a memecoin, an unknown company, a sale, a short and a match trade add nothing.
    plantTrade(r, alice, { company: 9000 });
    plantTrade(r, alice, { company: 9100 });
    plantTrade(r, alice, { company: 9999 });
    plantTrade(r, alice, { company: 9004, side: 'sell' });
    plantTrade(r, alice, { company: 9005, short: true });
    plantTrade(r, matchAccountOf(r, 'alice'), { company: 9006 });
    give('alice');
    expect(has(r, 'alice')).not.toContain('sectors_5');
    plantTrade(r, alice, { company: 9004 });
    give('alice');
    expect(has(r, 'alice')).toContain('sectors_5');
    expect(has(r, 'alice')).not.toContain('all_sectors');
    // All of them: one short of the whole market is not enough.
    for (let i = 5; i < sectors.length - 1; i += 1) plantTrade(r, alice, { company: 9000 + i });
    give('alice');
    expect(has(r, 'alice')).not.toContain('all_sectors');
    plantTrade(r, alice, { company: 9000 + sectors.length - 1 });
    give('alice');
    expect(has(r, 'alice')).toContain('all_sectors');
    // Nothing is given twice, and a sweep for everybody works too.
    expect(service.sweep()).toBeGreaterThanOrEqual(0);
    expect(db(r).all("SELECT COUNT(*) AS n FROM user_badges WHERE user_id = ? AND badge IN ('sectors_5', 'all_sectors') GROUP BY badge", idOf(r, 'alice')).every((x: any) => x.n === 1)).toBe(true);
    expect(has(r, 'bob')).toEqual(['welcome']);
    // Without a way to look up sectors the two badges are never given (and nothing breaks).
    const blind = new Badges({ db: db(r), now: r.clock.now, publishTo: () => undefined, profitOf: () => 0 });
    plantTrade(r, careerOf(r, 'bob'), { company: 9000 });
    blind.sweep();
    expect(has(r, 'bob')).not.toContain('sectors_5');
  }, LONG);

  it('BADGE-16: the real game wires the sector lookup: buying the companies of the test world gives Spread Out', async () => {
    const r = await boot();
    await signUp(r, 'alice');
    const companies = r.app.services.world.companies;
    const kinds = new Set(companies.map((c) => c.sector).filter((x) => x !== 'meme'));
    expect(kinds.size).toBeGreaterThanOrEqual(5);
    const seen = new Set<string>();
    for (const c of companies) {
      if (c.sector === 'meme' || seen.has(c.sector)) continue;
      seen.add(c.sector);
      plantTrade(r, careerOf(r, 'alice'), { company: c.id });
      sweep(r);
      expect(has(r, 'alice').includes('sectors_5')).toBe(seen.size >= 5);
    }
    expect(seen.size).toBeLessThan(STOCK_SECTOR_IDS.length);
    expect(has(r, 'alice')).not.toContain('all_sectors');
  }, LONG);

  it('BADGE-17: Lesson Learned: only a long buy made BEFORE the company went bankrupt counts; Chatterbox needs 100 messages that were not deleted', async () => {
    const r = await boot();
    for (const n of ['alice', 'bob', 'cara', 'dave']) await signUp(r, n);
    const [c1] = companyIds(r) as [number];
    const now = r.clock.now();
    db(r).run('INSERT INTO bankruptcies(company_id, declared_tick, declared_ms, cycle, negative_stories, window_total, price_before_cents) VALUES (?, 1, ?, 1, 3, 1, 100)', c1, now);
    plantTrade(r, careerOf(r, 'alice'), { company: c1, ms: now - 1000 }); // before: yes
    plantTrade(r, careerOf(r, 'bob'), { company: c1, ms: now + 1000 }); // after: no
    plantTrade(r, careerOf(r, 'cara'), { company: c1, ms: now - 1000, short: true }); // a short seller who sold first: no
    plantTrade(r, careerOf(r, 'dave'), { company: c1, ms: now - 1000, side: 'sell' }); // a sale: no
    sweep(r);
    expect(has(r, 'alice')).toContain('lesson_learned');
    for (const n of ['bob', 'cara', 'dave']) expect(has(r, n)).not.toContain('lesson_learned');
    // Chatterbox: 99 messages and one deleted one are 99 that count.
    const id = idOf(r, 'bob');
    db(r).tx(() => {
      for (let i = 0; i < 99; i += 1) db(r).run("INSERT INTO chat_messages(user_id, body, created_ms) VALUES (?, 'hi', ?)", id, now + i);
      db(r).run("INSERT INTO chat_messages(user_id, body, created_ms, deleted_ms) VALUES (?, 'oops', ?, ?)", id, now, now);
    });
    sweep(r);
    expect(has(r, 'bob')).not.toContain('chatterbox');
    db(r).run("INSERT INTO chat_messages(user_id, body, created_ms) VALUES (?, 'hi', ?)", id, now);
    sweep(r);
    expect(has(r, 'bob')).toContain('chatterbox');
    expect(has(r, 'bob')).toContain('first_chat');
  }, LONG);

  it('BADGE-18: the higher tiers: $1,000,000 profit, 3 launches, 25 buyers of one company, 25 friends, 100 lessons and 25 match wins, each at its exact number', async () => {
    const r = await boot();
    await signUp(r, 'alice');
    await signUp(r, 'bob');
    // Profit: $999,999.99 is not a Tycoon, $1,000,000.00 is.
    plantTrade(r, careerOf(r, 'alice'));
    db(r).run('UPDATE accounts SET cash_cents = ? WHERE id = ?', 100_000 + 99_999_999, careerOf(r, 'alice'));
    sweep(r);
    expect(has(r, 'alice')).not.toContain('profit_1m');
    expect(has(r, 'alice')).toContain('profit_100k');
    db(r).run('UPDATE accounts SET cash_cents = ? WHERE id = ?', 100_000 + 100_000_000, careerOf(r, 'alice'));
    sweep(r);
    expect(has(r, 'alice')).toContain('profit_1m');
    // Launches: two are not enough; the third counts whatever its kind.
    const ids = companyIds(r);
    const launch = (company: number, kind: 'stock' | 'coin') =>
      db(r).run("INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms) VALUES (?, ?, ?, ?, 100, 100, 1, 100, ?)", company, idOf(r, 'bob'), kind, `l-${company}`, r.clock.now());
    launch(ids[0] as number, 'stock');
    launch(ids[1] as number, 'coin');
    sweep(r);
    expect(has(r, 'bob')).not.toContain('launch_3');
    launch(ids[2] as number, 'coin');
    sweep(r);
    expect(has(r, 'bob')).toContain('launch_3');
    // 25 different buyers of one company: 24 are not enough (ten and the first investor come on the way). Alice already bought it above, so she is the first of them.
    const buyers = bulkPlayers(r, 'b', 24);
    for (const name of buyers.slice(0, 23)) plantTrade(r, careerOf(r, name), { company: ids[0] as number });
    sweep(r);
    expect(has(r, 'bob')).toContain('ten_investors');
    expect(has(r, 'bob')).not.toContain('fan_club');
    plantTrade(r, careerOf(r, buyers[23] as string), { company: ids[0] as number });
    sweep(r);
    expect(has(r, 'bob')).toContain('fan_club');
    // 25 friends.
    const pals = bulkPlayers(r, 'f', 25);
    const befriend = (a: string, b: string) => {
      const [x, y] = [idOf(r, a), idOf(r, b)].sort((p, q) => p - q) as [number, number];
      db(r).run("INSERT INTO friendships(user_a, user_b, requester_id, status, created_ms, accepted_ms) VALUES (?, ?, ?, 'accepted', 1, 2)", x, y, x);
    };
    for (const name of pals.slice(0, 24)) befriend('alice', name);
    sweep(r);
    expect(has(r, 'alice')).toContain('five_friends');
    expect(has(r, 'alice')).not.toContain('friends_25');
    befriend('alice', pals[24] as string);
    sweep(r);
    expect(has(r, 'alice')).toContain('friends_25');
    // 100 lessons and 25 match wins.
    db(r).run('INSERT INTO learn_progress(user_id, tutorial_mask, xp, streak, best_streak, lessons_done, updated_ms) VALUES (?, 0, 0, 0, 0, 99, 1)', idOf(r, 'bob'));
    sweep(r);
    expect(has(r, 'bob')).toContain('lessons_50');
    expect(has(r, 'bob')).not.toContain('lessons_100');
    db(r).run('UPDATE learn_progress SET lessons_done = 100 WHERE user_id = ?', idOf(r, 'bob'));
    sweep(r);
    expect(has(r, 'bob')).toContain('lessons_100');
    for (let i = 1; i <= 25; i += 1) {
      db(r).run("INSERT INTO matches(id, state, created_ms, start_tick, end_tick, duration_ticks, start_cash_cents, settled_ms, outcome, winner_user_id) VALUES (?, 'finished', 1, 10, 20, 10, 100000, 2, 'win', ?)", i, idOf(r, 'alice'));
      db(r).run("INSERT INTO match_players(match_id, user_id, joined_ms, last_seen_ms, active, result) VALUES (?, ?, 1, 1, 0, 'win')", i, idOf(r, 'alice'));
      if (i === 24) {
        sweep(r);
        expect(has(r, 'alice')).toContain('wins_5');
        expect(has(r, 'alice')).not.toContain('wins_25');
      }
    }
    sweep(r);
    expect(has(r, 'alice')).toContain('wins_25');
  }, LONG);

  it('BADGE-19: the badges page still lists every badge, secret ones too (the page hides them, the server does not decide that), and a secret badge counts like any other when earned', async () => {
    const r = await boot();
    const alice = await signUp(r, 'alice');
    await signUp(r, 'bob');
    db(r).run('INSERT INTO user_badges(user_id, badge, earned_ms) VALUES (?, ?, ?)', idOf(r, 'alice'), 'chatterbox', r.clock.now());
    const page = (await call(r, '/api/badges', { cookie: alice })).json;
    expect(page.badges).toHaveLength(64);
    expect(page.badges.find((b: any) => b.id === 'chatterbox')).toMatchObject({ earnedMs: r.clock.now(), owners: 1 });
    expect(page.badges.find((b: any) => b.id === 'lesson_learned')).toEqual({ id: 'lesson_learned', earnedMs: null, owners: 0 });
  }, LONG);
});
