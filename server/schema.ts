// Database structure. Each migration runs once, in order, inside a transaction; the version is kept in PRAGMA user_version.
// Never edit a migration that has been released — add a new one.

import type { Db } from './sqlite';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'world: clock, companies, state, candles',
    sql: `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per company that has ever been listed. The company's data is derived from the catalog in the program; the
-- database only remembers WHEN it was listed and which ticker sits at which id, so a changed catalog is detected at start.
CREATE TABLE companies (
  id           INTEGER PRIMARY KEY,
  ticker       TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  listing_tick INTEGER NOT NULL,
  listed_ms    INTEGER NOT NULL
);

-- The full simulation state as of a candle boundary (a tick that is a multiple of 10). One row, replaced atomically
-- together with the candles of the same boundary.
CREATE TABLE world_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  tick       INTEGER NOT NULL,
  state      TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);

-- Hourly copies of the state, kept for audit and replay (older ones are thinned out to one per day).
CREATE TABLE checkpoints (
  tick  INTEGER PRIMARY KEY,
  state TEXT NOT NULL
);

-- Candles. "idx" is the 1-based candle number of its resolution (10 ticks, 1 hour, 1 day) counted from genesis.
-- Prices are cents, volume is whole shares. 10-tick candles are kept for 25 hours; hourly and daily candles forever.
CREATE TABLE candles_c10 (
  company_id INTEGER NOT NULL,
  idx        INTEGER NOT NULL,
  open       INTEGER NOT NULL,
  high       INTEGER NOT NULL,
  low        INTEGER NOT NULL,
  close      INTEGER NOT NULL,
  volume     INTEGER NOT NULL,
  PRIMARY KEY (company_id, idx)
) WITHOUT ROWID;

CREATE TABLE candles_h1 (
  company_id INTEGER NOT NULL,
  idx        INTEGER NOT NULL,
  open       INTEGER NOT NULL,
  high       INTEGER NOT NULL,
  low        INTEGER NOT NULL,
  close      INTEGER NOT NULL,
  volume     INTEGER NOT NULL,
  PRIMARY KEY (company_id, idx)
) WITHOUT ROWID;

CREATE TABLE candles_d1 (
  company_id INTEGER NOT NULL,
  idx        INTEGER NOT NULL,
  open       INTEGER NOT NULL,
  high       INTEGER NOT NULL,
  low        INTEGER NOT NULL,
  close      INTEGER NOT NULL,
  volume     INTEGER NOT NULL,
  PRIMARY KEY (company_id, idx)
) WITHOUT ROWID;
`,
  },
  {
    version: 2,
    name: 'players: users, sessions, accounts, positions, trades',
    sql: `
CREATE TABLE users (
  id           INTEGER PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  pw_hash      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'owner')),
  created_ms   INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL
);
CREATE INDEX sessions_by_user ON sessions(user_id);

-- A trading account: the Career account of a player, or a one-off account for a single 1v1 match. Career wealth and
-- match cash can never mix because they are different rows.
CREATE TABLE accounts (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  kind             TEXT NOT NULL CHECK (kind IN ('career', 'match')),
  match_id         INTEGER,
  cash_cents       INTEGER NOT NULL CHECK (cash_cents >= 0),
  start_cash_cents INTEGER NOT NULL CHECK (start_cash_cents >= 0),
  created_ms       INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_career_account ON accounts(user_id) WHERE kind = 'career';

CREATE TABLE positions (
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  company_id INTEGER NOT NULL,
  shares     INTEGER NOT NULL CHECK (shares > 0),
  cost_cents INTEGER NOT NULL CHECK (cost_cents >= 0),
  PRIMARY KEY (account_id, company_id)
) WITHOUT ROWID;

-- Every executed order. (account, client_order_id) is unique, so a repeated request can never trade twice.
CREATE TABLE trades (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES accounts(id),
  client_order_id TEXT NOT NULL,
  company_id      INTEGER NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  requested       INTEGER NOT NULL,
  filled          INTEGER NOT NULL CHECK (filled > 0),
  total_cents     INTEGER NOT NULL,
  mid_cents       INTEGER NOT NULL,
  spread_cents    INTEGER NOT NULL,
  impact_cents    INTEGER NOT NULL,
  realized_cents  INTEGER NOT NULL DEFAULT 0,
  tick            INTEGER NOT NULL,
  created_ms      INTEGER NOT NULL,
  result_json     TEXT NOT NULL,
  UNIQUE (account_id, client_order_id)
);
CREATE INDEX trades_by_account ON trades(account_id, id DESC);

-- How much of the order book a player has used up, per account / company / side (see docs/world.md §6).
CREATE TABLE impact_state (
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  company_id INTEGER NOT NULL,
  side       TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  consumed   REAL NOT NULL,
  tick       INTEGER NOT NULL,
  PRIMARY KEY (account_id, company_id, side)
) WITHOUT ROWID;
`,
  },
  {
    version: 3,
    name: 'news: items, per-company state, cycles, job leases',
    sql: `
-- Every news item ever generated: the headline players read AND the (hidden) move the market will make. Items are written
-- once, ahead of time, and never changed except for the two price marks filled in as time passes. Nothing is deleted.
CREATE TABLE news_items (
  id               INTEGER PRIMARY KEY,
  key              TEXT NOT NULL UNIQUE,
  company_id       INTEGER,
  partner_id       INTEGER,
  sector           TEXT,
  scope            TEXT NOT NULL CHECK (scope IN ('company', 'company+partner', 'sector', 'market')),
  kind             TEXT NOT NULL,
  category         TEXT NOT NULL,
  cycle            INTEGER NOT NULL,
  slot             INTEGER NOT NULL,
  publish_tick     INTEGER NOT NULL,
  start_tick       INTEGER NOT NULL,
  end_tick         INTEGER NOT NULL,
  duration_ticks   INTEGER NOT NULL,
  shape            TEXT NOT NULL,
  immediacy        TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('positive', 'negative', 'uncertain')),
  strength         TEXT NOT NULL,
  realized         REAL NOT NULL,
  perm_share       REAL NOT NULL,
  credibility      REAL,
  headline         TEXT NOT NULL,
  body             TEXT NOT NULL,
  breaking         INTEGER NOT NULL DEFAULT 0,
  source           TEXT NOT NULL DEFAULT 'generator',
  created_ms       INTEGER NOT NULL,
  price_at_publish INTEGER,
  price_at_end     INTEGER,
  CHECK (start_tick >= publish_tick AND end_tick > start_tick)
);
CREATE INDEX news_by_publish ON news_items(publish_tick DESC, id DESC);
CREATE INDEX news_by_company ON news_items(company_id, publish_tick DESC) WHERE company_id IS NOT NULL;
CREATE INDEX news_by_partner ON news_items(partner_id, publish_tick DESC) WHERE partner_id IS NOT NULL;
CREATE INDEX news_by_sector  ON news_items(sector, publish_tick DESC) WHERE sector IS NOT NULL;
CREATE INDEX news_by_scope   ON news_items(scope, publish_tick DESC);
CREATE INDEX news_by_start   ON news_items(start_tick);
CREATE INDEX news_by_end     ON news_items(end_tick);
CREATE INDEX news_by_cycle   ON news_items(cycle, company_id);

-- Last successful generation per company: the cycle it has news for, when that happened, and how much it has had in total.
CREATE TABLE news_company_state (
  company_id        INTEGER PRIMARY KEY,
  generated_through INTEGER NOT NULL,
  last_success_ms   INTEGER NOT NULL,
  items_total       INTEGER NOT NULL DEFAULT 0,
  last_item_tick    INTEGER NOT NULL DEFAULT 0
);

-- Cycles (days) whose sector / economy / viral news exists, so a day is never generated twice.
CREATE TABLE news_cycles (
  cycle        INTEGER PRIMARY KEY,
  generated_ms INTEGER NOT NULL,
  items        INTEGER NOT NULL,
  companies    INTEGER NOT NULL
);

-- Exactly one program may run a job (or the whole server) at a time. A lease runs out if its owner stops renewing it.
CREATE TABLE job_leases (
  name       TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  host       TEXT NOT NULL,
  pid        INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL
);
`,
  },
  {
    version: 4,
    name: '1v1 lobby and matches, virtual-currency wallet',
    sql: `
-- A match: lobby (waiting / ready) -> countdown -> live (exactly duration_ticks on the server clock) -> finished.
-- 'cancelled' is a match that never produced a result (everybody left, or the server restarted during it).
CREATE TABLE matches (
  id               INTEGER PRIMARY KEY,
  state            TEXT NOT NULL CHECK (state IN ('lobby', 'countdown', 'live', 'finished', 'cancelled')),
  created_ms       INTEGER NOT NULL,
  start_tick       INTEGER,
  end_tick         INTEGER,
  duration_ticks   INTEGER NOT NULL,
  start_cash_cents INTEGER NOT NULL,
  settled_ms       INTEGER,
  outcome          TEXT CHECK (outcome IN ('win', 'tie', 'forfeit', 'abandoned')),
  winner_user_id   INTEGER REFERENCES users(id),
  cancel_reason    TEXT,
  CHECK (end_tick IS NULL OR (start_tick IS NOT NULL AND end_tick - start_tick = duration_ticks)),
  CHECK (state <> 'finished' OR (outcome IS NOT NULL AND settled_ms IS NOT NULL))
);
CREATE INDEX matches_by_state ON matches(state);

CREATE TABLE match_players (
  match_id          INTEGER NOT NULL REFERENCES matches(id),
  user_id           INTEGER NOT NULL REFERENCES users(id),
  joined_ms         INTEGER NOT NULL,
  last_seen_ms      INTEGER NOT NULL,
  ready             INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
  -- 1 while the player is in a match that has not ended; at most one such row per user (no double membership).
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  forfeited         INTEGER NOT NULL DEFAULT 0 CHECK (forfeited IN (0, 1)),
  account_id        INTEGER REFERENCES accounts(id),
  final_value_cents INTEGER,
  profit_cents      INTEGER,
  result            TEXT CHECK (result IN ('win', 'loss', 'tie', 'forfeit')),
  reward_cents      INTEGER,
  -- 1 once the player has closed the results screen; the lobby screen then starts fresh.
  dismissed         INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0, 1)),
  PRIMARY KEY (match_id, user_id)
);
CREATE UNIQUE INDEX one_active_match_per_user ON match_players(user_id) WHERE active = 1;
CREATE INDEX match_players_by_user ON match_players(user_id, match_id DESC);

-- Virtual currency won in matches. It is separate from Career cash: nothing here ever changes a Career balance.
CREATE TABLE wallets (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id),
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
  updated_ms    INTEGER NOT NULL
);

-- Every payment, once. The UNIQUE key is what makes "rewards are saved exactly once" true even if settlement ran twice.
CREATE TABLE wallet_ledger (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  delta_cents INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  match_id    INTEGER REFERENCES matches(id),
  created_ms  INTEGER NOT NULL,
  UNIQUE (user_id, reason, match_id)
);
`,
  },
  {
    version: 5,
    name: 'owner tools: trading halts and the admin log',
    sql: `
-- A company whose trading the owner has stopped. Orders for it are refused until the row is removed (the admin log keeps the history).
CREATE TABLE trading_halts (
  company_id INTEGER PRIMARY KEY,
  reason     TEXT NOT NULL,
  halted_ms  INTEGER NOT NULL,
  by_user_id INTEGER NOT NULL REFERENCES users(id)
);

-- Everything the owner did with the admin panel, once each. request_id is chosen by the browser and is UNIQUE, so a
-- double click or a repeated request can never apply the same action twice.
CREATE TABLE admin_log (
  id            INTEGER PRIMARY KEY,
  request_id    TEXT NOT NULL UNIQUE,
  created_ms    INTEGER NOT NULL,
  admin_user_id INTEGER NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL CHECK (action IN ('shock', 'halt', 'resume', 'cash', 'coins')),
  target        TEXT NOT NULL,
  detail_json   TEXT NOT NULL
);
`,
  },
  {
    version: 6,
    name: 'player trades move prices',
    sql: `
-- Every Career trade leaves a small price push behind. Like a news story it is a STORED EVENT: the price engine reads it from this
-- table, so after a restart the replay gives exactly the same prices (docs/world.md §3.2, §8.6). The push is never recomputed from
-- anything that can change later; total is the number that was true when the trade happened.
CREATE TABLE flow_events (
  id            INTEGER PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  trade_id      INTEGER NOT NULL UNIQUE,
  company_id    INTEGER NOT NULL,
  start_tick    INTEGER NOT NULL,
  end_tick      INTEGER NOT NULL,
  duration_ticks INTEGER NOT NULL,
  total         REAL NOT NULL,
  perm_share    REAL NOT NULL,
  created_ms    INTEGER NOT NULL
);
CREATE INDEX flow_events_start ON flow_events(start_tick);

-- The net buying (+) or selling (−) pressure of all players on a company, in shares. It fades with a half-life of 5 minutes.
CREATE TABLE flow_state (
  company_id INTEGER PRIMARY KEY,
  pressure   REAL NOT NULL,
  tick       INTEGER NOT NULL
);

-- The admin log also records changes of the price-impact setting. SQLite cannot change a CHECK, so the table is rebuilt.
ALTER TABLE admin_log RENAME TO admin_log_old;
CREATE TABLE admin_log (
  id            INTEGER PRIMARY KEY,
  request_id    TEXT NOT NULL UNIQUE,
  created_ms    INTEGER NOT NULL,
  admin_user_id INTEGER NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL CHECK (action IN ('shock', 'halt', 'resume', 'cash', 'coins', 'flow')),
  target        TEXT NOT NULL,
  detail_json   TEXT NOT NULL
);
INSERT INTO admin_log(id, request_id, created_ms, admin_user_id, action, target, detail_json)
  SELECT id, request_id, created_ms, admin_user_id, action, target, detail_json FROM admin_log_old;
DROP TABLE admin_log_old;
`,
  },
  {
    version: 7,
    name: 'owner tools: bans, account resets, more admin actions',
    sql: `
-- A banned player cannot sign in and every request of an old session is treated as signed out. until_ms is NULL for "until the owner
-- lifts it"; a ban whose time has passed simply stops counting (the row is only removed by an unban or a new ban).
CREATE TABLE user_bans (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id),
  reason     TEXT NOT NULL,
  banned_ms  INTEGER NOT NULL,
  until_ms   INTEGER,
  by_user_id INTEGER NOT NULL REFERENCES users(id)
);

-- A reset of a Career account does not delete trades (their ids feed the stored price pushes, so they must never be reused).
-- Instead the account remembers the newest trade id at the time; older trades no longer count for its history or realized profit.
ALTER TABLE accounts ADD COLUMN reset_trade_id INTEGER NOT NULL DEFAULT 0;

-- The admin log now has more kinds of action (ban, unban, shares, reset, announce, pause, unpause). The list of allowed names moves
-- into the program (admin.ts) so that adding one never needs another rebuild; the table is rebuilt once more to drop the old CHECK.
ALTER TABLE admin_log RENAME TO admin_log_old;
CREATE TABLE admin_log (
  id            INTEGER PRIMARY KEY,
  request_id    TEXT NOT NULL UNIQUE,
  created_ms    INTEGER NOT NULL,
  admin_user_id INTEGER NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 30),
  target        TEXT NOT NULL,
  detail_json   TEXT NOT NULL
);
INSERT INTO admin_log(id, request_id, created_ms, admin_user_id, action, target, detail_json)
  SELECT id, request_id, created_ms, admin_user_id, action, target, detail_json FROM admin_log_old;
DROP TABLE admin_log_old;
`,
  },
  {
    version: 8,
    name: 'owner tools: companies made by the owner',
    sql: `
-- A company the owner made by hand. The row in "companies" says WHEN it lists; this row says WHAT it is (the catalog is rebuilt from it
-- at every start, so the company is exactly the same one after a restart). Rows are never changed or deleted: a company id, once
-- used, belongs to that company forever (prices, news, trades and positions all refer to it).
CREATE TABLE custom_companies (
  company_id  INTEGER PRIMARY KEY REFERENCES companies(id),
  ticker      TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL UNIQUE,
  sector      TEXT NOT NULL,
  industry    TEXT NOT NULL,
  tier        TEXT NOT NULL,
  personality TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents BETWEEN 100 AND 5000000),
  product1    TEXT NOT NULL,
  product2    TEXT NOT NULL,
  description TEXT NOT NULL,
  created_ms  INTEGER NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id)
);
`,
  },
  {
    version: 9,
    name: 'owner tools: how strongly trades move a company the owner made',
    sql: `
-- Multiplies the price push of player trades (server/flow.ts) for this company: 1 = the dial alone, 10 = strong, 100 = extreme. It
-- changes only the size of FUTURE pushes (each stored push event keeps its own number), never the company itself, so the catalog,
-- the news and every price that was already made stay exactly as they were. Companies saved before this version get 1.
ALTER TABLE custom_companies ADD COLUMN flow_mult INTEGER NOT NULL DEFAULT 1 CHECK (flow_mult IN (1, 10, 100));
`,
  },
  {
    version: 10,
    name: 'automatic trading pauses (circuit breaker)',
    sql: `
-- A company whose trading the market itself paused because its price moved 10 % within 5 minutes (server/breaker.ts). Like an
-- owner's halt, it only stops TRADING, not time: the price keeps moving. Ticks are market seconds; the row is ignored once
-- until_tick has passed and is removed by the next check. One row per company, so a new pause replaces the old one. The
-- prices are in cents; move_bps is the signed move in basis points (-1000 = fell 10 %).
CREATE TABLE auto_pauses (
  company_id INTEGER PRIMARY KEY,
  since_tick INTEGER NOT NULL,
  until_tick INTEGER NOT NULL,
  from_price INTEGER NOT NULL,
  to_price   INTEGER NOT NULL,
  move_bps   INTEGER NOT NULL
);
`,
  },
  {
    version: 11,
    name: 'leverage (margin and debt)',
    sql: `
-- Leverage (server/trading.ts, server/liquidation.ts). A leveraged buy pays only a part of the order from the player's cash (the
-- "margin", the order's value divided by the leverage); the rest is a debt that sits on the position and is repaid out of the
-- proceeds when the shares are sold. "cost_cents" of a position stays what the player paid out of his own cash (the margin).
-- Positions saved before this version have no debt, exactly as they were.
ALTER TABLE positions ADD COLUMN debt_cents INTEGER NOT NULL DEFAULT 0 CHECK (debt_cents >= 0);
-- Per trade: the leverage of a buy (1 to 50; sells and old trades say 1), the debt the trade took on (a buy) or repaid (a sell), and
-- whether the market closed the position by itself because the margin was gone (a liquidation).
ALTER TABLE trades ADD COLUMN leverage INTEGER NOT NULL DEFAULT 1 CHECK (leverage BETWEEN 1 AND 50);
ALTER TABLE trades ADD COLUMN debt_cents INTEGER NOT NULL DEFAULT 0 CHECK (debt_cents >= 0);
ALTER TABLE trades ADD COLUMN forced INTEGER NOT NULL DEFAULT 0 CHECK (forced IN (0, 1));
`,
  },
  {
    version: 12,
    name: 'memecoins',
    sql: `
-- The thirty memecoins (src/world/memecoins.ts). Like the owner's companies (custom_companies) they are part of the catalog, but their
-- numbers are saved here as one piece of JSON, exactly as they were when the coin was added, so editing the program's list later can never
-- change a coin that already exists. There is deliberately no foreign key: the row is written in the same transaction as the company row.
CREATE TABLE meme_companies (
  company_id INTEGER PRIMARY KEY,
  ticker     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL UNIQUE,
  entry_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);

-- Short selling (server/leverage.ts, docs/world.md §6.2). A SHORT position is shares the player has sold without owning: "shares" is
-- how many he owes, "cost_cents" the cash of his own that he put up as margin, and "credit_cents" the money from the sale, which is
-- held on the position (not paid out) until he buys the shares back. Everything before this version is a long position (short = 0).
ALTER TABLE positions ADD COLUMN short INTEGER NOT NULL DEFAULT 0 CHECK (short IN (0, 1));
ALTER TABLE positions ADD COLUMN credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (credit_cents >= 0);
-- Stop-loss and take-profit (server/liquidation.ts): the market price (cents) at which the market closes the whole position by itself.
-- 0 = not set. For a long position the stop is below the price and the take above it; for a short position it is the other way round.
ALTER TABLE positions ADD COLUMN stop_cents INTEGER NOT NULL DEFAULT 0 CHECK (stop_cents >= 0);
ALTER TABLE positions ADD COLUMN take_cents INTEGER NOT NULL DEFAULT 0 CHECK (take_cents >= 0);
-- Per trade: whether it was about a short position (opening or covering one), and whether the market made it by itself because the
-- position's stop-loss ('stop') or take-profit ('take') price was reached ('' for an ordinary order; liquidations use "forced").
ALTER TABLE trades ADD COLUMN short INTEGER NOT NULL DEFAULT 0 CHECK (short IN (0, 1));
ALTER TABLE trades ADD COLUMN auto TEXT NOT NULL DEFAULT '' CHECK (auto IN ('', 'stop', 'take'));
`,
  },
  {
    version: 13,
    name: 'memecoin trading fee',
    sql: `
-- The fee a memecoin order paid, in cents (server/fees.ts, docs/world.md §6.6). Every trade before this version, every stock trade and every
-- 1v1 trade paid none, exactly as they were. "realized_cents" of a trade already has the fee taken out of it.
ALTER TABLE trades ADD COLUMN fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0);
`,
  },
  {
    version: 14,
    name: 'launches and rug pulls',
    sql: `
-- Stocks and memecoins that players launch (server/launch.ts, docs/world.md §12.1). One row per launched company. The player put
-- "spent_cents" of his Career cash in and started out holding "stake_shares" shares of it at "price_cents" (cash turned into shares, so
-- neither profit nor loss). request_id is chosen by the browser and is UNIQUE, so a double click can never launch twice. Companies the
-- owner makes on the Admin "Create stock" tab are not launches (the owner puts no money in and holds nothing).
CREATE TABLE launches (
  company_id   INTEGER PRIMARY KEY REFERENCES companies(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL CHECK (kind IN ('stock', 'coin')),
  request_id   TEXT NOT NULL UNIQUE,
  seed_cents   INTEGER NOT NULL CHECK (seed_cents > 0),
  spent_cents  INTEGER NOT NULL CHECK (spent_cents > 0),
  stake_shares INTEGER NOT NULL CHECK (stake_shares > 0),
  price_cents  INTEGER NOT NULL CHECK (price_cents > 0),
  created_ms   INTEGER NOT NULL
);
CREATE INDEX launches_by_user ON launches(user_id, kind);

-- Every "rug pull": the launching player sold (some or all of) what he held of his own company in one market order. trade_id is that
-- order, once (so repeating the request never counts it twice); received_cents is the cash it paid out (after any debt and the fee).
CREATE TABLE launch_rugs (
  trade_id       INTEGER PRIMARY KEY REFERENCES trades(id),
  company_id     INTEGER NOT NULL REFERENCES launches(company_id),
  user_id        INTEGER NOT NULL REFERENCES users(id),
  shares         INTEGER NOT NULL CHECK (shares > 0),
  received_cents INTEGER NOT NULL CHECK (received_cents >= 0),
  created_ms     INTEGER NOT NULL
);
CREATE INDEX launch_rugs_by_company ON launch_rugs(company_id);

-- Coins the owner made with the earlier owner-only "Create coin" tab become launches of the owner (so the owner can rug pull them too).
INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms)
  SELECT json_extract(l.detail_json, '$.companyId'), l.admin_user_id, 'coin', l.request_id,
         json_extract(l.detail_json, '$.seedCents'), json_extract(l.detail_json, '$.spentCents'),
         json_extract(l.detail_json, '$.stakeShares'), json_extract(l.detail_json, '$.priceCents'), l.created_ms
    FROM admin_log l
   WHERE l.action = 'coin'
     AND json_valid(l.detail_json)
     AND typeof(json_extract(l.detail_json, '$.companyId')) = 'integer'
     AND typeof(json_extract(l.detail_json, '$.seedCents')) = 'integer' AND json_extract(l.detail_json, '$.seedCents') > 0
     AND typeof(json_extract(l.detail_json, '$.spentCents')) = 'integer' AND json_extract(l.detail_json, '$.spentCents') > 0
     AND typeof(json_extract(l.detail_json, '$.stakeShares')) = 'integer' AND json_extract(l.detail_json, '$.stakeShares') > 0
     AND typeof(json_extract(l.detail_json, '$.priceCents')) = 'integer' AND json_extract(l.detail_json, '$.priceCents') > 0
     AND EXISTS (SELECT 1 FROM companies c WHERE c.id = json_extract(l.detail_json, '$.companyId'));
`,
  },
  {
    version: 15,
    name: '1v1 bots',
    sql: `
-- Computer players for the 1v1 lobby (server/lobby/bots.ts, docs/world.md §9.9). A bot is an ordinary row in "users" (its username has a
-- hyphen, which nobody can register, and its password hash can never match) plus a row here that says which style of play it has. The
-- lobby, the match account and the scoring treat it like any other player; only "bots" tells them apart (no reward is paid to a bot, and
-- a lobby holding only a bot is closed).
CREATE TABLE bots (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  persona TEXT NOT NULL UNIQUE
);
`,
  },
  {
    version: 16,
    name: 'margin costs and limit orders',
    sql: `
-- What borrowing costs (server/margin.ts, docs/world.md §6.1). accrued_tick is the tick up to which a position has been charged interest (a
-- leveraged long) or a borrow fee (a short); NULL for a position from before this version, which starts paying from the first minute after the
-- upgrade. charged_cents is the total charged so far, shown on the account page.
ALTER TABLE positions ADD COLUMN accrued_tick INTEGER;
ALTER TABLE positions ADD COLUMN charged_cents INTEGER NOT NULL DEFAULT 0 CHECK (charged_cents >= 0);

-- Limit orders (server/limitOrders.ts, docs/world.md §6.8): an order that waits until the price reaches its limit. An order that OPENS a
-- position (a buy, or a short sale) sets its cash aside when it is placed (reserved_cents leaves accounts.cash_cents and comes back when the
-- order fills, is cancelled or expires), so the same money cannot be promised twice. qty is the whole order, filled what has been traded so far.
CREATE TABLE limit_orders (
  id               INTEGER PRIMARY KEY,
  account_id       INTEGER NOT NULL REFERENCES accounts(id),
  company_id       INTEGER NOT NULL,
  client_order_id  TEXT NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  short            INTEGER NOT NULL DEFAULT 0 CHECK (short IN (0, 1)),
  qty              INTEGER NOT NULL CHECK (qty >= 1),
  filled           INTEGER NOT NULL DEFAULT 0 CHECK (filled >= 0 AND filled <= qty),
  total_cents      INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  limit_cents      INTEGER NOT NULL CHECK (limit_cents >= 1),
  leverage         INTEGER NOT NULL DEFAULT 1 CHECK (leverage >= 1),
  stop_cents       INTEGER NOT NULL DEFAULT 0 CHECK (stop_cents >= 0),
  take_cents       INTEGER NOT NULL DEFAULT 0 CHECK (take_cents >= 0),
  reserved_cents   INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
  state            TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'filled', 'cancelled', 'expired')),
  reason           TEXT NOT NULL DEFAULT '',
  created_tick     INTEGER NOT NULL,
  expires_tick     INTEGER NOT NULL,
  retry_tick       INTEGER NOT NULL DEFAULT 0,
  fills            INTEGER NOT NULL DEFAULT 0,
  created_ms       INTEGER NOT NULL,
  closed_ms        INTEGER,
  UNIQUE (account_id, client_order_id)
);
CREATE INDEX limit_orders_open ON limit_orders(state, company_id);
CREATE INDEX limit_orders_account ON limit_orders(account_id, state, id DESC);
`,
  },
  {
    version: 17,
    name: 'free coin launches',
    sql: `
-- Making a memecoin is nearly free now (server/launch.ts, docs/world.md §12.1): it costs a small launch fee ("fee_cents", paid from the player's
-- cash and gone) and the player may buy some of his own coin at the start or nothing at all, so a launch can have no money put in and no
-- shares held. The old table demanded more than 0 for all three, and SQLite cannot change a CHECK, so the table is rebuilt. Every launch
-- made before this version keeps exactly what it had and paid no fee (0). The rug pulls point at the launches by company id, so the
-- foreign key check waits until the end of this transaction (the rows are back by then).
PRAGMA defer_foreign_keys = ON;
CREATE TABLE launches_stash AS SELECT * FROM launches;
DROP TABLE launches;
CREATE TABLE launches (
  company_id   INTEGER PRIMARY KEY REFERENCES companies(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL CHECK (kind IN ('stock', 'coin')),
  request_id   TEXT NOT NULL UNIQUE,
  seed_cents   INTEGER NOT NULL CHECK (seed_cents >= 0),
  spent_cents  INTEGER NOT NULL CHECK (spent_cents >= 0),
  stake_shares INTEGER NOT NULL CHECK (stake_shares >= 0),
  price_cents  INTEGER NOT NULL CHECK (price_cents > 0),
  created_ms   INTEGER NOT NULL,
  fee_cents    INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0)
);
INSERT INTO launches(company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms, fee_cents)
  SELECT company_id, user_id, kind, request_id, seed_cents, spent_cents, stake_shares, price_cents, created_ms, 0 FROM launches_stash;
DROP TABLE launches_stash;
CREATE INDEX launches_by_user ON launches(user_id, kind);
`,
  },
  {
    version: 18,
    name: 'money pool behind launched coins',
    sql: `
-- The money pool of a memecoin that a player launched (server/pools.ts, docs/world.md §12.2). Every dollar that buyers pay for the coin goes
-- into the pool, a sale is paid out of it (so a sale can never be paid with more than the pool holds), and the player who launched the coin can
-- take everything that is in it (the "rug pull"): the cash goes to him and the coin is dead after that. in_cents is everything ever paid in
-- (the launching player's first buy included), out_cents everything sellers took out, drained_cents what the rug pull took, so always
-- pool_cents = in_cents - out_cents - drained_cents. drained_ms is NULL while the coin is alive. drain_request_id makes a repeated rug pull
-- request return the first answer. A coin launched before this version has no row here and works as it did before (a rug pull is a market sale).
CREATE TABLE coin_pools (
  company_id       INTEGER PRIMARY KEY REFERENCES launches(company_id),
  pool_cents       INTEGER NOT NULL DEFAULT 0 CHECK (pool_cents >= 0),
  in_cents         INTEGER NOT NULL DEFAULT 0 CHECK (in_cents >= 0),
  out_cents        INTEGER NOT NULL DEFAULT 0 CHECK (out_cents >= 0),
  drained_cents    INTEGER NOT NULL DEFAULT 0 CHECK (drained_cents >= 0),
  drained_ms       INTEGER,
  drain_request_id TEXT UNIQUE,
  CHECK (pool_cents = in_cents - out_cents - drained_cents)
);
`,
  },
  {
    version: 19,
    name: 'friends',
    sql: `
-- Friends (server/social.ts, docs/world.md §13). One row per pair of players, stored with the smaller user id first so a pair can never be stored
-- twice. A friend request is a 'pending' row that remembers who sent it (requester_id); accepting it makes it 'accepted'. Declining, cancelling and
-- removing a friend delete the row. Friends share nothing but their names and net worths: no money, no shares, no holdings.
CREATE TABLE friendships (
  user_a       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_ms   INTEGER NOT NULL,
  accepted_ms  INTEGER,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b),
  CHECK (requester_id = user_a OR requester_id = user_b),
  CHECK ((status = 'accepted') = (accepted_ms IS NOT NULL))
);
CREATE INDEX friendships_by_b ON friendships(user_b);
`,
  },
  {
    version: 20,
    name: 'friend challenges and the chat',
    sql: `
-- A friend 1v1 (server/challenges.ts, docs/world.md §14). A challenge is one row from the player who asks to the friend who is asked; it
-- disappears when it is accepted, declined, taken back, or runs out (expires_ms). A match made from one has friends = 1: it is a lobby of
-- exactly those two players, nobody else can join it, and if one of them leaves before it starts it is cancelled for both.
ALTER TABLE matches ADD COLUMN friends INTEGER NOT NULL DEFAULT 0 CHECK (friends IN (0, 1));

CREATE TABLE challenges (
  from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id),
  CHECK (from_id <> to_id),
  CHECK (expires_ms > created_ms)
);
CREATE INDEX challenges_by_to ON challenges(to_id);

-- The public chat room (server/chat.ts, docs/world.md §15). Only the newest messages are kept. A removed message stays in the table (who removed
-- it and when) but is never shown again.
CREATE TABLE chat_messages (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1200),
  created_ms INTEGER NOT NULL,
  deleted_ms INTEGER,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX chat_messages_by_user ON chat_messages(user_id, id DESC);

-- A player the owner stopped from writing: 'mute' until until_ms, or 'ban' until the owner lifts it (until_ms is NULL). One row per player; the
-- latest decision stands. Reading the chat and playing are not affected.
CREATE TABLE chat_restrictions (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('mute', 'ban')),
  until_ms   INTEGER,
  reason     TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  by_user_id INTEGER NOT NULL REFERENCES users(id),
  CHECK ((kind = 'mute') = (until_ms IS NOT NULL))
);

-- Players report messages; the owner sees the open reports in the admin panel. One report per player and message.
CREATE TABLE chat_reports (
  id          INTEGER PRIMARY KEY,
  message_id  INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_ms  INTEGER NOT NULL,
  resolved_ms INTEGER,
  UNIQUE (message_id, reporter_id)
);
CREATE INDEX chat_reports_open ON chat_reports(resolved_ms, message_id);
`,
  },
  {
    version: 21,
    name: 'private chats: conversations, messages, blocks, reports',
    sql: `
-- Private chats (server/messages.ts, docs/world.md §16). A conversation is 'direct' (two players, at most one per pair) or a small 'group'.
CREATE TABLE conversations (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  -- The name of a group (a direct chat is named after the other player).
  title        TEXT,
  -- A direct chat: the two players, the smaller id first.
  direct_a     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  direct_b     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  -- A group: who made it (he invites, removes and renames). He is replaced by the longest-standing member if he leaves.
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_ms   INTEGER NOT NULL,
  last_ms      INTEGER NOT NULL,
  -- A direct chat between players who are not friends starts as a message request: NULL = friends (or no request needed),
  -- 'pending' = the requester wrote one message and waits, 'accepted', 'declined' (the requester is never told which of the two it is).
  request      TEXT CHECK (request IN ('pending', 'accepted', 'declined')),
  requester_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  request_ms   INTEGER,
  CHECK ((kind = 'direct') = (direct_a IS NOT NULL AND direct_b IS NOT NULL)),
  CHECK (direct_a IS NULL OR direct_a < direct_b),
  CHECK (kind = 'direct' OR title IS NOT NULL)
);
CREATE UNIQUE INDEX conversations_direct_pair ON conversations(direct_a, direct_b) WHERE kind = 'direct';
CREATE INDEX conversations_by_requester ON conversations(requester_id, request_ms) WHERE requester_id IS NOT NULL;

-- Who is in a conversation. 'invited' is a group invitation that has not been answered: the player sees the invitation but not the messages.
-- since_id: messages from before the player joined are not shown to him. read_id: the newest message he has read.
CREATE TABLE conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state           TEXT NOT NULL CHECK (state IN ('member', 'invited')),
  invited_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  joined_ms       INTEGER NOT NULL,
  since_id        INTEGER NOT NULL DEFAULT 0,
  read_id         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_by_user ON conversation_members(user_id, state);

CREATE TABLE private_messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1200),
  created_ms      INTEGER NOT NULL
);
CREATE INDEX private_messages_by_conversation ON private_messages(conversation_id, id DESC);
CREATE INDEX private_messages_by_user ON private_messages(user_id, id DESC);

-- A player who blocked another: that player cannot write to him, ask to be his friend or invite him, and his messages in a shared group are hidden.
CREATE TABLE blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_by_blocked ON blocks(blocked_id);

-- A reported private message. The owner sees only what was reported: that message and the few before it, copied here at the time of the report
-- (context_json), so it is still there if the conversation is later trimmed or deleted. One report per player and message.
CREATE TABLE private_reports (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  reporter_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_ms      INTEGER NOT NULL,
  resolved_ms     INTEGER,
  context_json    TEXT NOT NULL,
  UNIQUE (message_id, reporter_id)
);
CREATE INDEX private_reports_open ON private_reports(resolved_ms, message_id);
`,
  },
  {
    version: 22,
    name: 'delete your own private message, profile pictures, weekly leaderboard marks',
    sql: `
-- A player can delete a message he wrote in a private chat (server/messages.ts): it is hidden for everybody in the chat. The row stays, so a report
-- made before the deletion keeps its evidence (the report also holds its own copy), and the writing-speed limits still count it.
ALTER TABLE private_messages ADD COLUMN deleted_ms INTEGER;

-- A player's profile picture (server/profile.ts): one small picture, already shrunk by the browser, kept as the bytes the browser made.
CREATE TABLE user_avatars (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data       BLOB NOT NULL CHECK (length(data) BETWEEN 1 AND 65536),
  updated_ms INTEGER NOT NULL
);

-- The weekly leaderboard (server/social.ts): each ranked player's net worth the first time he was seen in a week (weeks start Monday 00:00 Tokyo time).
-- This week's gain is his net worth now minus this mark; last week's gain is this week's mark minus last week's. Only the last few weeks are kept.
CREATE TABLE weekly_marks (
  week_start_ms   INTEGER NOT NULL,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  net_worth_cents INTEGER NOT NULL,
  PRIMARY KEY (week_start_ms, user_id)
) WITHOUT ROWID;

-- Companies that failed (server/bankruptcy.ts): a weak small company that gets a pile of bad news can go bankrupt. Its price crashes, it stops
-- there for good, and nobody can open a new position in it any more (a player who holds it can still sell it, or cover a short, at that price).
-- The news story with the key 'bankrupt:<company id>:fail' is what freezes the price (like a rug pull's story); this row is what the trading rules read.
CREATE TABLE bankruptcies (
  company_id         INTEGER PRIMARY KEY REFERENCES companies(id),
  declared_tick      INTEGER NOT NULL,
  declared_ms        INTEGER NOT NULL,
  cycle              INTEGER NOT NULL,
  negative_stories   INTEGER NOT NULL,
  window_total       REAL NOT NULL,
  price_before_cents INTEGER NOT NULL
);
`,
  },
  {
    version: 23,
    name: 'learn: tutorial progress, practice lessons, XP, AI teacher usage',
    sql: `
-- Learn (server/learn.ts): the tutorial and the practice lessons. Nothing here touches money, shares, prices or the leaderboards: it is XP for learning only.
-- One row per player: which tutorial steps he finished (bit n-1 of tutorial_mask is step n), his XP and his run of good answers.
CREATE TABLE learn_progress (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tutorial_mask INTEGER NOT NULL DEFAULT 0 CHECK (tutorial_mask >= 0),
  xp            INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  streak        INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
  best_streak   INTEGER NOT NULL DEFAULT 0 CHECK (best_streak >= 0),
  lessons_done  INTEGER NOT NULL DEFAULT 0 CHECK (lessons_done >= 0),
  updated_ms    INTEGER NOT NULL
);

-- How he does on each kind of chart (pattern key as in src/learn/types.ts): used to practise his weak spots more often.
CREATE TABLE learn_pattern_stats (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  seen    INTEGER NOT NULL DEFAULT 0,
  best    INTEGER NOT NULL DEFAULT 0,
  ok      INTEGER NOT NULL DEFAULT 0,
  wrong   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, pattern)
) WITHOUT ROWID;

-- Every lesson handed out. The whole practice chart (what the player sees and what happens next) is stored when the lesson starts, so a lesson
-- stays the same even if the program is updated before he answers. The part that happens next is never sent to the browser before the answer.
-- An open lesson has answered_ms and skipped_ms empty; there is at most one per player. The AI teacher's text is kept once it has been written,
-- so nobody pays twice for the same lesson.
CREATE TABLE learn_lessons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('direction', 'size')),
  pattern     TEXT NOT NULL,
  seed        INTEGER NOT NULL,
  scenario    TEXT NOT NULL,
  issued_ms   INTEGER NOT NULL,
  answered_ms INTEGER,
  skipped_ms  INTEGER,
  choice      TEXT,
  grade       TEXT CHECK (grade IS NULL OR grade IN ('best', 'ok', 'wrong')),
  reason      TEXT,
  outcome_pct REAL,
  coach_text  TEXT,
  coach_ms    INTEGER
);
CREATE INDEX learn_lessons_user ON learn_lessons(user_id, id);

-- How many times the AI teacher was asked, per day (days since 1970, UTC). user_id 0 is the total for everybody; it limits what the whole game can spend.
CREATE TABLE learn_ai_usage (
  day     INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  calls   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
) WITHOUT ROWID;
`,
  },
  {
    version: 24,
    name: 'pictures for stocks and memecoins',
    sql: `
-- A company's picture (server/companyPictures.ts, docs/world.md §20): one small picture per company, already shrunk by the browser, kept as the
-- bytes the browser made. The player who launched the company and the owner can set or remove it; the owner can do so for any company. Only the
-- picture is stored here: it changes nothing about prices, shares or money. "set_by" is who last changed it (empty if that player is deleted).
CREATE TABLE company_pictures (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data       BLOB NOT NULL CHECK (length(data) BETWEEN 1 AND 65536),
  updated_ms INTEGER NOT NULL,
  set_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
`,
  },
  {
    version: 25,
    name: 'moderators and achievement badges',
    sql: `
-- Moderators (server/moderation.ts, docs/world.md §21). The owner chooses them in the admin panel. They are kept in their own table, not in
-- users.role (whose CHECK only allows 'player' and 'owner' and cannot be changed without rebuilding the table everything points at), and the
-- program turns "owner, else listed here, else player" into the role every other part sees. The server setting for the owner is never touched by
-- this table: a moderator row does nothing for a player who is the owner. "appointed_by" is empty if that player is deleted.
CREATE TABLE moderators (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  appointed_ms INTEGER NOT NULL,
  appointed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- A short ban that a moderator (or the owner) gave to kick a player out for a while: 'kick' signs him out and keeps him out for 10 minutes to a day,
-- then he can come back by himself. Everything about a ban works the same way for both kinds; the kind only changes what the player is told.
ALTER TABLE user_bans ADD COLUMN kind TEXT NOT NULL DEFAULT 'ban' CHECK (kind IN ('ban', 'kick'));

-- Achievement badges (server/badges.ts, docs/world.md §22): which badge a player has and when he got it. The list of badges and the rule for each
-- one are in the program, not here, so adding a badge never needs a migration. A badge is never taken back.
CREATE TABLE user_badges (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge     TEXT NOT NULL CHECK (length(badge) BETWEEN 1 AND 40),
  earned_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, badge)
) WITHOUT ROWID;
CREATE INDEX user_badges_by_badge ON user_badges(badge);
`,
  },
  {
    version: 26,
    name: 'public groups, quick invite, pictures in chats, changing your username',
    sql: `
-- Public groups (server/messages.ts, docs/world.md §23). A group is 'private' (only invited friends can be in it, as before) or 'public' (it is listed
-- and any player can join). The player who made the group chooses and can change it.
ALTER TABLE conversations ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public'));
CREATE INDEX conversations_public ON conversations(last_ms DESC) WHERE kind = 'group' AND visibility = 'public';

-- A player the creator took out of a group may not walk back into it when it is public. (Only the player who made the group can invite him again.)
CREATE TABLE group_removed (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_ms      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
) WITHOUT ROWID;

-- Changing your username (server/rename.ts, docs/world.md §25): one row per change. It tells when the last change was (once every 7 days), what it cost,
-- and which names are kept for their old owner for a while so nobody can copy a name somebody just left.
CREATE TABLE username_changes (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_name   TEXT NOT NULL COLLATE NOCASE,
  new_name   TEXT NOT NULL COLLATE NOCASE,
  changed_ms INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL CHECK (cost_cents >= 0)
);
CREATE INDEX username_changes_by_user ON username_changes(user_id, changed_ms DESC);
CREATE INDEX username_changes_by_old_name ON username_changes(old_name, changed_ms);

-- Pictures sent in chats (server/chatPictures.ts, docs/world.md §24). A picture belongs to one message. The bytes are kept only for a while (and only
-- up to a total size); after that "data" is emptied and the message shows "picture expired". The bytes are what the browser made after shrinking.
CREATE TABLE chat_message_pictures (
  message_id INTEGER PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data       BLOB CHECK (data IS NULL OR length(data) BETWEEN 1 AND 131072),
  created_ms INTEGER NOT NULL
);
CREATE INDEX chat_message_pictures_by_time ON chat_message_pictures(created_ms) WHERE data IS NOT NULL;

CREATE TABLE private_message_pictures (
  message_id INTEGER PRIMARY KEY REFERENCES private_messages(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data       BLOB CHECK (data IS NULL OR length(data) BETWEEN 1 AND 131072),
  created_ms INTEGER NOT NULL
);
CREATE INDEX private_message_pictures_by_time ON private_message_pictures(created_ms) WHERE data IS NOT NULL;

-- A reported private message keeps its own copy of the picture, so the owner can still look at it after the writer deleted the message or it expired.
ALTER TABLE private_reports ADD COLUMN picture BLOB;
ALTER TABLE private_reports ADD COLUMN picture_mime TEXT;
`,
  },
];

export function currentVersion(db: Db): number {
  const row = db.get<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/** Applies every migration that has not run yet. Returns the versions that were applied. */
export function migrate(db: Db): number[] {
  const applied: number[] = [];
  let version = currentVersion(db);
  const known = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  if (version > known) throw new Error(`The database is from a newer TradeQuest (schema ${version}, this program knows ${known}). Update the program.`);
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    db.tx(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
    version = m.version;
    applied.push(m.version);
  }
  return applied;
}
