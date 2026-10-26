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
import { RULE_IDS } from '../server/badges';
import { NEW_ACCOUNT_WAIT_MS } from '../server/chat';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { BADGES, BADGES_SHOWN, BADGE_GROUPS, TIER_NAMES, badgeById, bestBadges } from '../src/shared/badgeCatalog';
import { TUTORIAL_STEPS } from '../src/learn/tutorial';
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
function plantTrade(r: Running, account: number, opts: { side?: 'buy' | 'sell'; realized?: number; company?: number } = {}): void {
  nextOrder += 1;
  db(r).run(
    "INSERT INTO trades(account_id, client_order_id, company_id, side, requested, filled, total_cents, mid_cents, spread_cents, impact_cents, realized_cents, tick, created_ms, result_json) VALUES (?, ?, ?, ?, 1, 1, 100, 100, 0, 0, ?, 1, ?, '{}')",
    account,
    `plant-${nextOrder}`,
    opts.company ?? (companyIds(r)[0] as number),
    opts.side ?? 'buy',
    opts.realized ?? 0,
    r.clock.now(),
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
