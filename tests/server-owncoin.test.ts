// Coins the owner made with the earlier owner-only "Create coin" tab (before any player could launch): version 14 of the database turns them
// into launches of the owner, so the owner can rug pull them like anybody else. (The rest of launching is tested in server-launch.test.ts.)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';

describe('coins the owner made earlier', () => {
  it('COIN-1: version 14 adds the launches tables; coins the owner made with the earlier owner-only tab become the owner\'s launches; bad rows are skipped', () => {
    expect(MIGRATIONS[MIGRATIONS.length - 1]?.version).toBeGreaterThanOrEqual(14);
    const dir = mkdtempSync(join(tmpdir(), 'tq-launch-mig-'));
    try {
      const db = new Db(join(dir, 'old.sqlite'));
      for (const m of MIGRATIONS.filter((x) => x.version <= 13)) {
        db.tx(() => {
          db.exec(m.sql);
          db.exec(`PRAGMA user_version = ${m.version}`);
        });
      }
      db.run("INSERT INTO users(id, username, display_name, pw_hash, created_ms) VALUES (1, 'boss', 'boss', 'x', 0)");
      for (const [id, ticker] of [[66, 'MPEP'], [67, 'BADD']] as const) db.run('INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (?, ?, ?, 100, 0)', id, ticker, `Name ${ticker}`);
      const log = (req: string, detail: string): void => {
        db.run("INSERT INTO admin_log(request_id, created_ms, admin_user_id, action, target, detail_json) VALUES (?, 5, 1, 'coin', 'MPEP', ?)", req, detail);
      };
      log('req-good-00000001', JSON.stringify({ companyId: 66, name: 'Moon Pepe', seedCents: 50_000, spentCents: 50_000, stakeShares: 125, priceCents: 400 }));
      log('req-junk-00000002', 'not json at all');
      log('req-gone-00000003', JSON.stringify({ companyId: 999, seedCents: 50_000, spentCents: 50_000, stakeShares: 125, priceCents: 400 }));
      log('req-zero-00000004', JSON.stringify({ companyId: 67, seedCents: 50_000, spentCents: 0, stakeShares: 125, priceCents: 400 }));
      log('req-text-00000005', JSON.stringify({ companyId: 67, seedCents: '50000', spentCents: 50_000, stakeShares: 125, priceCents: 400 }));
      expect(migrate(db).filter((v) => v <= 14)).toEqual([14]); // (later versions follow in the same go)
      expect(db.all('SELECT company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms FROM launches')).toEqual([
        { company_id: 66, user_id: 1, kind: 'coin', request_id: 'req-good-00000001', seed_cents: 50_000, spent_cents: 50_000, stake_shares: 125, price_cents: 400, created_ms: 5 },
      ]);
      expect(db.all('SELECT * FROM launch_rugs')).toEqual([]);
      // The tables refuse nonsense.
      expect(() => db.run("INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms) VALUES (67, 1, 'bond', 'req-kind-00000006', 1, 1, 1, 1, 0)")).toThrow();
      expect(() => db.run("INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms) VALUES (67, 1, 'coin', 'req-good-00000001', 1, 1, 1, 1, 0)")).toThrow(); // request ids are unique
      expect(() => db.run("INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms) VALUES (66, 1, 'coin', 'req-dup1-00000007', 1, 1, 1, 1, 0)")).toThrow(); // one launch per company
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('COIN-2: version 17 lets a launch have nothing put in and adds the fee; launches and rug pulls made before it keep every number (fee 0) and still point at each other', () => {
    expect(MIGRATIONS[MIGRATIONS.length - 1]?.version).toBeGreaterThanOrEqual(17);
    const dir = mkdtempSync(join(tmpdir(), 'tq-launch-mig17-'));
    try {
      const db = new Db(join(dir, 'old.sqlite'));
      for (const m of MIGRATIONS.filter((x) => x.version <= 16)) {
        db.tx(() => {
          db.exec(m.sql);
          db.exec(`PRAGMA user_version = ${m.version}`);
        });
      }
      db.run("INSERT INTO users(id, username, display_name, pw_hash, created_ms) VALUES (1, 'boss', 'boss', 'x', 0), (2, 'alice', 'alice', 'x', 0)");
      db.run("INSERT INTO accounts(id, user_id, kind, cash_cents, start_cash_cents, created_ms) VALUES (10, 1, 'career', 100000, 100000, 0), (11, 2, 'career', 100000, 100000, 0)");
      for (const [id, ticker] of [[66, 'MPEP'], [67, 'ACMR'], [68, 'WOWW']] as const) db.run('INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (?, ?, ?, 100, 0)', id, ticker, `Name ${ticker}`);
      const launch = (id: number, user: number, kind: string, req: string, seed: number, stake: number, price: number): void => {
        db.run('INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 7)', id, user, kind, req, seed, stake * price, stake, price);
      };
      launch(66, 2, 'coin', 'req-coin-00000001', 500_000, 2500, 200);
      launch(67, 2, 'stock', 'req-stck-00000002', 500_000, 100, 5000);
      launch(68, 1, 'coin', 'req-coin-00000003', 20_000, 100, 200);
      // Two rug pulls: they refer to the launches by company id (and to trades).
      for (const [tradeId, company] of [[1, 66], [2, 67]] as const) {
        db.run(
          "INSERT INTO trades(id, account_id, client_order_id, company_id, side, requested, filled, total_cents, mid_cents, spread_cents, impact_cents, realized_cents, tick, created_ms, result_json) VALUES (?, 11, ?, ?, 'sell', 5, 5, 900, 200, 1, 1, 0, 50, 8, '{}')",
          tradeId,
          `rug-${tradeId}-abcdef`,
          company,
        );
        db.run('INSERT INTO launch_rugs(trade_id, company_id, user_id, shares, received_cents, created_ms) VALUES (?, ?, 2, 5, 900, 8)', tradeId, company);
      }
      expect(migrate(db)).toEqual([17, 18, 19, 20, 21, 22, 23, 24, 25]); // (25 adds the empty moderator and badge tables) (24 adds the empty company-picture table) (23 adds the Learn tables) (18 adds the empty money-pool table; an old launch never gets a pool; 19 adds the empty friends table; 20 the empty challenges and chat tables; 21 the empty private-chat tables)
      expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(25);
      expect(db.all('SELECT * FROM coin_pools')).toEqual([]);
      // Nothing was lost or changed, and every old launch has paid no fee.
      expect(db.all('SELECT company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms, fee_cents FROM launches ORDER BY company_id')).toEqual([
        { company_id: 66, user_id: 2, kind: 'coin', request_id: 'req-coin-00000001', seed_cents: 500_000, spent_cents: 500_000, stake_shares: 2500, price_cents: 200, created_ms: 7, fee_cents: 0 },
        { company_id: 67, user_id: 2, kind: 'stock', request_id: 'req-stck-00000002', seed_cents: 500_000, spent_cents: 500_000, stake_shares: 100, price_cents: 5000, created_ms: 7, fee_cents: 0 },
        { company_id: 68, user_id: 1, kind: 'coin', request_id: 'req-coin-00000003', seed_cents: 20_000, spent_cents: 20_000, stake_shares: 100, price_cents: 200, created_ms: 7, fee_cents: 0 },
      ]);
      expect(db.all('SELECT trade_id, company_id, shares, received_cents FROM launch_rugs ORDER BY trade_id')).toEqual([
        { trade_id: 1, company_id: 66, shares: 5, received_cents: 900 },
        { trade_id: 2, company_id: 67, shares: 5, received_cents: 900 },
      ]);
      expect(db.all('PRAGMA foreign_key_check')).toEqual([]); // every rug pull still points at a launch that exists
      // The rug pull table still refuses a rug pull on something that is not a launch, and the index is back.
      expect(() => db.run('INSERT INTO launch_rugs(trade_id, company_id, user_id, shares, received_cents, created_ms) VALUES (3, 999, 2, 1, 1, 0)')).toThrow();
      expect(db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'launches'").map((r) => (r as { name: string }).name)).toContain('launches_by_user');
      // A launch with nothing put in and nothing held is allowed now, with a fee; negative numbers and a missing price are still refused.
      db.run("INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (69, 'FREE', 'Name FREE', 100, 0)");
      db.run("INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms, fee_cents) VALUES (69, 2, 'coin', 'req-free-00000004', 0, 0, 0, 200, 9, 200)");
      expect(db.get<{ fee_cents: number }>('SELECT fee_cents FROM launches WHERE company_id = 69')?.fee_cents).toBe(200);
      db.run("INSERT INTO companies(id, ticker, name, listing_tick, listed_ms) VALUES (70, 'NEGG', 'Name NEGG', 100, 0)");
      const bad = (cols: string): void => {
        expect(() => db.run(`INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms, fee_cents) VALUES (70, 2, 'coin', 'req-bad0-00000005', ${cols}, 9, 0)`)).toThrow();
      };
      bad('-1, 0, 0, 200');
      bad('0, -1, 0, 200');
      bad('0, 0, -1, 200');
      bad('0, 0, 0, 0');
      expect(() => db.run("INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms, fee_cents) VALUES (70, 2, 'coin', 'req-bad0-00000006', 0, 0, 0, 200, 9, -1)")).toThrow();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
