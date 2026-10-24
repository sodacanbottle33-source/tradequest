# TradeQuest — the persistent world (engine version 4)

This document describes the shared, server-run market: how it keeps time, how prices are made, how news is made and moves
them, how trading works against limited liquidity, how the server stays correct across restarts, and how it is tested.
Section numbers are referred to from comments in the code. The older single-player modes (Classic, Market, Live practice)
are described in `rules.md` and are not changed by anything here.

## 1. What was asked for, and where each part lives

| Requirement | Where |
|---|---|
| One permanent, server-run market that never resets and survives restarts | §3, `server/world/runtime.ts` |
| Prices from interacting factors; candles are exactly 10 ticks | §5, `src/world/sim.ts`, `candles.ts` |
| Hundreds of fictional companies, expandable | §4, `src/world/catalog.ts` |
| Market cap = price × shares outstanding | §4 |
| Liquidity-aware trading: bid/ask, depth, impact, partial fills | §6, `src/world/liquidity.ts`, `server/trading.ts` |
| Player trades move prices (buying pushes up, selling pushes down, thin companies most) | §8.6, `server/flow.ts` |
| News that really works, saved by the server, ≥ 3 per company per day | §7, `src/world/newsgen.ts`, `server/news/` |
| News moves the real price, once, with a record | §7.3 |
| Rare viral events with fictional people | §7.4 |
| Persistent history, no daily deletion | §3.5, §7.2 |
| Monitoring, no duplicate schedulers | §8.3 |
| 1v1 lobbies and exactly-3-minute matches | §9, `server/lobby/service.ts`, `src/world/matchRules.ts` |
| 1v1 bots: a computer opponent when nobody else is waiting (after 10 s alone, or "Play a bot now"); real players always come first | §9.9, `server/lobby/bots.ts` |
| Automatic trading pauses after a big 5-minute move (by company size) | §8.5, `server/breaker.ts` |
| Owner-only tools: rug / crash / pump, trading halts and pause-all, give or take cash, coins and shares, bans, account reset, announcement, audit log | §8.5, `server/admin.ts`, `server/halts.ts`, `server/auth.ts` |
| The owner can make a company of his own (name, ticker, sector, size, personality, price) while the market runs | §4.1, §8.5, `server/customStock.ts`, `WorldRuntime.loadOwnCompany` |
| Any player can launch a memecoin or a stock of his own (the size comes from the money; a coin costs a $2.00 fee and the first buy is optional, a stock needs at least $100 put in and a $10.00 fee; the money also sets a stock's starting price) and rug pull it (a stock: sell his whole stake in one order; a coin has a real money pool behind it that the rug pull takes, §12.2) | §12.1, §12.2, `server/launch.ts`, `server/customCoin.ts`, `server/customStock.ts`, `WorldRuntime.recordOwnCoin` |
| Screens for all of the above | `src/shared/` (Career, 1v1 and News in the menu; profile menu; owner admin panel) |

## 2. Why news never appeared

The question was asked first, so it is answered first. **News never appeared because it had never been built.** I searched
`src/`, `docs/` and `tests/`: the only mentions of news were sentences in `rules.md` and the README saying "no news yet
(Stage 3)". Before this work the market was a plain random walk (engine versions 1–3). There was no news generator, no
place to store news, no link from a story to a price, no API and no screen. Nothing was failing silently — there was
nothing to fail. (The "notices" list in the old app shows order messages such as "order filled"; it is not a news feed.)

Two design problems would also have stopped a naive feed from working, and both are avoided here:

* In the old modes the market lived inside the browser tab. Anything a tab generated vanished when it closed, and two
  players could never see the same story. News now lives in the server's database.
* A feed that is only filled "when a player opens the page" has gaps whenever nobody is online. News here is written
  ahead of time by the server on its own schedule (§7.2), independent of players.

## 3. The persistent market

### 3.1 The clock
`tick = floor((server time − genesis) / 1 second)`. `genesis` is a whole hour chosen once, at the first start of a
database (now minus the warm-up days, default 7), and then never changes. Browsers cannot influence the tick: they
only receive it. A candle is exactly 10 ticks (10 s); an hour is 360 candles; a day is 8 640 candles.

### 3.2 Determinism
The state of the market at tick *t* is a **pure function of (world seed, catalog, stored news)**. Every random number is
read from a seeded counter-based stream by position (`hashUniformAt(seed, k)`), so no hidden state needs to be remembered
to continue. Consequences that are tested:

* A server stopped and restarted gives exactly the prices and candles of one that never stopped.
* A crash that loses the ticks since the last save gives the same prices (the lost ticks are replayed).
* Three days of downtime are caught up in one pass with no jump and no gap; the candles are the same as if the server had
  been running.

Code in `src/world` and `src/engine` may not use `Math.random`, `Date.now`, `Math.exp/log/sin/cos/pow/sqrt`, etc. (this is
enforced by `tests/static.test.ts`), so results do not depend on the machine.

### 3.3 Saving
State is saved in one database transaction together with the finished candles and the news price records (§7.3):
at every candle boundary while within 60 ticks of the clock, and every full hour while catching up. A checkpoint is kept
every hour. If nothing was saved for a few ticks the next start replays them.

### 3.4 Catching up
On start the server computes the clock tick and simulates forward in chunks (one hour per chunk, each chunk in its own
transaction) until it is within a tick of the clock. While catching up, trading is refused if the market is more than
30 ticks behind the clock (`MAX_TRADING_LAG_TICKS`), so a player never trades on a stale price.

### 3.5 What is kept
* 10-tick candles for 25 hours, hourly and daily candles forever, checkpoints thinned out over time.
* **All news is kept forever.** Nothing deletes news daily; `news_items` only grows.
* Trades and accounts are never deleted.

## 4. Companies, shares and market cap

The catalog is deterministic and independent of the world seed: company *n* is the same company in every world. Company
numbers 0–65 are hand-written (names, sectors, products, tiers, volatility, shares outstanding); numbers beyond that are
generated procedurally from a fixed catalog seed (names, tickers, CEOs, headquarters, products). `TQ_COMPANIES`
chooses how many exist (default 66; the engine supports up to 65 024). Adding companies later never changes an existing
company or its history: a new company has a `listingTick` in the future (`LISTING_DELAY_TICKS = 600`) and starts trading at
its base price at that tick. Tickers are unique; a restart with a catalog whose existing tickers moved is refused rather
than corrupting history.

**Market cap = price × shares outstanding**, computed from the same price shown on the chart (`marketCapCents`; exact below about
$90 trillion, approximate above that, and it never throws: a $10 mega-cap pumped to the top price of $1,000,000 a share has about $18 quadrillion (1.85×10¹⁸ cents),
and an error there once turned `/api/market` into a 500 for everybody, `OSTK-12`, `WCA-11`). The server
returns it in `/api/market` and `/api/market/:ticker`, with float, 24-hour volume, high/low and liquidity.

Thirteen sectors, five size tiers (micro … mega) and seven personalities (steady, income, growth, cyclical, volatile,
turnaround, declining) differentiate volatility, liquidity and how strongly a company follows its sector and the market.

### 4.1 Companies made by the owner (`server/customStock.ts`, `custom_companies`, schema 8)

The owner's *Create stock* tab adds a company to the running market. The catalog stays a pure function: `buildCatalog(count,
listingTickOf, own)` takes a map of hand-given entries (`own`, id → `CatalogEntry`) that replace the curated/procedural entry
of that id; the first 66 ids are curated, so an owner company is always id ≥ 66 (the next free number, i.e. the current
company count, which is why `TQ_COMPANIES` must be at least 66). Companies are append-only, so no existing company or history
changes, and the per-company random streams depend only on (seed, id), never on the count.

*Storing.* One admin transaction writes the `companies` row, the `custom_companies` row (ticker, name, sector, industry, tier,
personality, price in cents, two products, description, who and when) and the `admin_log` row (`stock`). The listing tick is
`ceil((max(sim tick, clock) + 30) / 10) × 10`: about 30–40 seconds ahead, on a 10-tick boundary. The database is the source of
truth; at every start the catalog is built with the saved rows, so a restart brings the company back exactly.

*Starting it live (no restart).* After the commit, `WorldRuntime.loadOwnCompany(id)` rebuilds the catalog, checks that every
existing company is byte-for-byte unchanged, restores the simulation from a snapshot padded with one empty slot, grows the
statistics and rollups, adds a candle builder, binds the news generator and schedules the company's own news, then replays the
stored events that already fall in the loaded window for the new company only (company and partner stories keep all their
effects; market and sector stories apply to the new company's share of them). Live objects are swapped in last, so a failure
leaves the running market untouched; the row stays saved and the company is loaded at the next start. Until the DB and the live
market agree, a second stock is refused (`409 restart_needed`). The result is the same prices, candles and news as saving
the row and restarting the server (tests `OSTK-8` and `OSTK-9` compare them over six hours, with a crash restart).

*Trade strength (schema 9, retired).* Schema 9 added `custom_companies.flow_mult` (1, 10 or 100) so the owner could make trades push one
of their own stocks harder. The game no longer has that choice: every company, the owner's included, is pushed with the one strength
of §8.6, and the column is kept (migrations are never edited) but ignored, as is an old `meta.flow_level`. `OSTK-14` checks that
neither the form nor the list offers a choice, that the routes `/api/admin/stock-sensitivity` and `/api/admin/flow` are gone (404)
and that an old value in the database changes nothing.

*Limits.* Name 3–40 characters and ticker 3–5 letters A–Z, both new (case-insensitive); price $2.00–$1,000.00 at creation;
at most 400 hand-made companies in all (the owner's and the stocks players launch, §12.1); a company cannot be deleted (it can be halted). Tests: `tests/server-own-stock.test.ts`.

## 5. The price model

### 5.1 Factors (per tick, per company)
`price = round(F · (1 + D))`, clamped to $1.00 … $1,000,000 (`MAX_PRICE`, 10⁸ cents: just above the dearest real share, Berkshire Hathaway A at about $700,000; it was $50,000, then $1,000,000,000 for a while; cents are kept as whole numbers, which is why the ceiling cannot be "none"), where

* **F** — the fundamental value: a slow random trend inside a *regime* (up, flat, down; changes about every 3 days), a slow
  pull toward the company's long-run anchor, the permanent part of company news, and the company's response to the
  **market** and **sector** moods. Market and sector moods are their own random processes with half-lives of hours.
* **D** — a fast deviation that always relaxes toward zero: random noise scaled by the company's volatility and a
  **volatility regime V** (calm/stormy; big moves raise it, it decays), **momentum M**, order-flow **pressure Q**, a pull
  of the traded price back to F, and the temporary part of news.

Sentiment scales news a little (±30 %) when the mood agrees or disagrees with the story. All constants are in
`src/world/params.ts` with the reason for each.

### 5.2 Candles
`CandleBuilder` folds ticks into candles: candle *n* covers ticks 10(*n*−1)+1 … 10*n*; open = previous close; high/low
include every tick; hourly and daily candles are exact folds of the 10-tick candles. The tests check these identities
on stored data.

## 6. Liquidity-aware trading

Every stock has a simulated order book (`liquidity.ts`): a **bid** and **ask** around the mid price (spread depends on
liquidity and volatility) and 20 price levels on each side. The touch holds 0.04 %–0.30 % of the stock's average daily
volume (more for liquid stocks), each deeper level a bit more. A market order walks the ladder:

* the average price is worse than the touch (**price impact / slippage**), and the result separates `spreadCost` from
  `impactCost`;
* if the order is bigger than the 20 levels hold, it is **partially filled** and the rest is reported as unfilled
  (`note: 'depth'`); a limit price also stops the walk (`note: 'limit'`);
* depth a player has consumed recovers with a 5-minute half-life, **per account** — so buying and instantly selling a
  large amount loses money, and nobody else's orders change *your* fill (they can change the price you start from, §8.6).
  A client still cannot move a price by sending a number: only the server turns a filled Career order into a price push.

The server alone decides prices and quantities of fills. A client sends only `ticker`, `side`, `qty`, a `clientOrderId`
(and optionally `limitPrice`). The server:

* rejects an order that costs more cash than the account has (`insufficient_cash`, with `maxQty`), or sells more shares
  than are held (a short sale is a sell with `short: true`, §6.2); a buy or short may use leverage (§6.1);
* is **idempotent**: `UNIQUE(account_id, client_order_id)` means a double click or a retried request returns the original
  result and never executes twice;
* never accepts a balance, price or fill from the client; and refuses orders for companies that are not trading yet or
  when the market is behind the clock;
* offers `/api/market/:ticker/estimate` which uses the *same* function as the order, so the estimate and the fill match.

Net worth values positions at the current **bid** (what they could be sold for), minus the debt of a leveraged position (§6.1). All money is integer cents.

### 6.1 Leverage (`server/leverage.ts`, `server/liquidation.ts`, schema 11, tests `server-leverage`, `server-lobby` LEV-28, `pens`)

A **buy** (and a **short**, §6.2) can use a whole leverage from 1× to 50× (`MAX_LEVERAGE`), in Career and in 1v1.

* **Margin and debt.** The player pays the **margin** out of his cash: the order's value divided by the leverage, rounded **up** to a
  whole cent (`marginOf`, exact with BigInt). The rest of the value is the **debt** of the position (`positions.debt_cents`). There
  is **interest** on the debt in Career (§6.7); a 1v1 match has none. (Memecoin orders pay the fee of §6.6, the same at any leverage.) `positions.cost_cents` is the cash the player put in (the margin); the real average price of a share
  is (cost + debt) / shares (`avgCostCents`). Each position is its own (**isolated**) margin: losing one never touches other cash
  or shares.
* **Selling** repays the debt that belongs to the shares sold (all of it when all shares go, otherwise in proportion, rounded
  down: `debtShare`). The cash that arrives is `max(0, proceeds − debt repaid)`; the realized profit is what arrived minus the
  removed part of the cash put in. A second buy adds its margin and its debt to the same position.
* **Liquidation.** When `shares × market price ≤ debt` the position is **closed by the market itself** (`Liquidator`): the position
  is deleted and a trade row is written (a sell at the market price, `forced = 1`, with the debt shown, realized = minus the cash
  put in). No cash comes back, and the player never loses more than the margin. The liquidation does not itself push the price
  (it is the market closing a loan, not a sale into the order book).
  * It is checked at **every tick**, including the ticks the server replays after having been off: the liquidator is attached as the
    world's step observer **before** `world.init()` runs the catch-up, so a price that touched the line while nobody was watching still
    closes the position at the tick it happened (`created_ms = msOfTick(tick)`). A failure in it can never stop the market (the
    observer is called inside a try/catch, and the liquidator and the circuit breaker each have their own).
  * To stay cheap it keeps one number per company in memory (the highest `debt / shares` of any position with debt) and only looks at
    the database when the price is at or below it. The table is rebuilt whenever a leveraged trade or an owner tool changes a
    position with debt, and every 10 minutes anyway.
  * **1v1:** a position of a match account is only closed while its match is `live` and up to its last tick; after that it is left
    alone, so a price move after the end cannot change a result that is about to be settled.
* **Refusals.** `bad_request` for a leverage that is not a whole number from 1 to 50 (on the order and on the estimate; a sell
  ignores the field). `insufficient_cash` when the **margin** is more than the cash (the message says "at Nx leverage" and gives
  `maxQty` at that leverage). `leverage_too_high` when the cost of opening above the mid price (spread, thin book, the player's own
  push) would use more than half of the margin (`OPEN_COST_LIMIT = 0.5`) or the combined position would be liquidated at once: you
  cannot be liquidated by the act of buying. The error carries the highest leverage that works (`maxLeverageFor`).
* **Estimate.** `/api/market/:ticker/estimate?...&leverage=N` returns the same figures the order will use plus `leverage`, `netCents`
  (a buy: the margin; a sell: the proceeds minus the debt repaid), `debtCents`, `liqPrice` (the highest whole-cent price at which the
  position is wiped out) and `maxLeverage`.
* **Valuation.** A position is worth `max(0, value − debt)` (`equityCents`) in net worth, and in a match's final score
  (`settle`: cash + Σ max(0, closing price × shares − debt)). Player price impact (§8.6) counts the filled shares, so a leveraged order
  pushes the price as hard as an unleveraged one of the same size, which means leverage lets a player push a thin stock around with
  little cash. The trade-offs that come with it (the owner's `Stop trading`, the automatic pauses, and the price floor of $1.00)
  are unchanged.
* **Owner tools.** Taking shares takes the matching part of the debt with them; a reset removes positions and their debts together;
  both tell the liquidator to look again.
* **1v1 rewards.** The winner is paid the larger of the profit or $50 (§9.4). With big leverage a lucky match can pay a large
  amount of virtual currency. It is virtual currency only (no cash value), so this was left as it is.

### 6.2 Short selling (`server/trading.ts`, `server/leverage.ts`, `server/liquidation.ts`, schema 12, tests `server-shorts`)

An order carries a flag `short`. With `side: 'sell', short: true` it **opens or adds to a short** (sells shares the player does not
own, at the bid side of the book); with `side: 'buy', short: true` it **covers** (buys back, all or part). Without the flag the
old long rules apply unchanged. Career and 1v1; stocks and memecoins alike.

* **One side per company.** An account is long XOR short in a company: a short order while holding shares, or a buy while short,
  is refused with `position_conflict` and a sentence that says what to do first.
* **Money.** The sale's proceeds are not paid out: they are kept on the position as `positions.credit_cents`. The player pays a
  **margin** from cash, `marginOf(proceeds, leverage)` (rounded up; it is `positions.cost_cents`). The position's **collateral** is
  `credit + cost` (`collateralOf`). More shorting adds to all three. A short row has `short = 1`, `debt_cents = 0`.
* **Covering** a part removes the proportional part of credit and cost (rounded down for credit, the rest for cost); the cash that
  arrives is `max(0, collateral part − buy-back cost)`; realized = cash that arrived − cost part removed. Covering all closes the row.
* **Equity** (`equityOf`) of a short is `max(0, collateral − price × shares)`, never negative, so the most a short can lose is its
  margin. Net worth marks a short at the **ask** in Career (what covering would cost) and at the mid in a match's final score.
* **Liquidation.** A short is wiped out when `mid × shares ≥ collateral` (`isShortLiquidated`); its liquidation price is
  `ceil(collateral / shares)` (`shortLiquidationPrice`). The liquidator (§6.1) closes it at the tick it happens, with a forced
  *buy* trade (`short = 1`, `forced = 1`), nothing comes back, including for the ticks replayed after the server was off.
* **Refusals.** `leverage_too_high` when the cost of opening (selling below the mid) would use more than half of the margin
  (`OPEN_COST_LIMIT`) or the whole short would be liquidated the moment it opens (`maxShortLeverageFor` gives the highest leverage
  that works); `insufficient_cash` when the margin is more than the cash (`maxQty` given).
* **Estimate.** `/api/market/:ticker/estimate?...&short=1` returns the same numbers the order will use plus `short` and
  `creditCents`, `liqPrice` for the short.
* **Owner tools.** `adjustShares` refuses a player whose position is short (`short_position`, 400). A reset removes shorts with the rest.
* **1v1 settle** uses `equityOf` for every position (long and short) at the final candle's close.

### 6.3 Stop-loss and take-profit (`server/trading.ts` `setExits` / `closeByExit`, `server/liquidation.ts`, `POST /api/positions/exits`)

A position row stores `stop_cents` and `take_cents` (0 = none). They can be sent with the order that opens the position
(`stopPrice`, `takePrice`; `null` = none) or set / removed later with `POST /api/positions/exits` (`{ticker, stopPrice?, takePrice?, account?}`).

* **Sides.** A long: stop below the market price, take above. A short: stop above, take below. A price on the wrong side of the current
  mid is refused with `bad_exit`, and so is a stop at or beyond the position's liquidation price (the market would close it first and the
  stop could never fire) and a short's take-profit below the $1.00 floor. A price that is not a positive whole number of cents, or an
  order that closes a position carrying prices, is a `bad_request`. Selling or covering everything removes the row and its exits.
* **Watching.** The liquidator (§6.1) keeps, per company, a band `[low, high]` outside which one of its positions is wiped out or
  triggered, and looks at the database only when the price leaves the band. The table is rebuilt whenever a trade, an owner tool
  or `setExits` may have changed a watched position (and every 10 minutes).
* **Executing.** When the market price reaches the stop or take price, the liquidator calls `trading.closeByExit`, which places an
  **ordinary market order** for the whole position (a sell for a long, a cover for a short) inside the tick observer: it pays the
  spread, walks the book and, in Career, pushes the price like the player's own order would. The trade is marked `auto = 'stop'` or
  `'take'` and shown in the trade list as *Stop-loss* / *Take-profit*.
* **When it cannot trade** (`OrderError`: the company is halted or paused, or the server is catching up) the position stays and the
  next tick tries again. So a stop never fires from a price in the past: after downtime, the order is placed when the market has caught
  up, at the then-current price. A liquidation (no order needed) always goes first.
* **1v1.** Exits of a match account only run while the match is live and up to its last tick (as liquidations do).

### 6.4 The live order book (`src/world/liquidity.ts` `bookScale`, `server/flow.ts` `bookTilt`, `server/world/runtime.ts`)

The bid / ask ladder is not fixed: it is tilted by the net pressure of the players' orders (the same pressure that pushes the price, §8.6).
`FlowService.bookTilt(company, tick)` returns `pressure / bookDepth` clamped to ±1; `bookScale(side, tilt)` turns it into a size factor
(each level's size is multiplied by 1 ∓ `BOOK_TILT_GAIN` (0.6) × tilt: asks thinner and bids thicker under net buying, the reverse under net selling; the factor is kept between `BOOK_TILT_MIN` (15 %) and `BOOK_TILT_MAX` (160 %), and 0 pressure is exactly the old book). The **same ladder**
is used for fills, for the estimate and for the displayed book, so the book you see is the book your order walks. It reacts to other players'
Career orders (each player's order changes everybody's book) and fades as the pressure fades. The depth endpoint returns `pressure` (2 decimals). The page refreshes the
book every 2 seconds, shows the best 8 rows of the 20 levels, and the footer says "All 20 levels" (the Total counts all levels, not only the rows shown).

### 6.5 Pop-ups for automatic closes (`PositionClosed`, SSE event `position`)

When the liquidator closes a position (liquidated / stop / take) it hands the list to `onClosed`; `server/app.ts` looks up the account's
owner and publishes an SSE event `position` to that user only (`hub.publishTo`): `{reason, account, ticker, short, shares, priceCents, realizedCents, tick}`.
The browser (`src/shared/store.ts`) shows a pop-up (`Toasts.tsx`, text in `positionNotice.ts`) at once, for 12 seconds, and refreshes the account. Nothing is
decided in the browser.

### 6.7 Interest, the borrow fee and the margin call (`server/margin.ts`, migration 16, tests `server-margin`)

Borrowing costs money in **Career**. A 1v1 match (three minutes) pays nothing.

* **Interest on a leveraged long.** The debt grows by `debt × rate × time`: **10 % a year** on a stock, **40 %** on a memecoin (`interestBps`). It is added to `positions.debt_cents`, so it lowers what the position is worth to its
  owner and raises the price at which the market closes it (the liquidator is told to look again, `markDirty`).
* **Borrow fee on a short.** The money from the sale that sits on the position (`credit_cents`) shrinks by `credit × rate × time` (`borrowBps`): **0.5 % a year** for a very liquid stock up to **10.5 %** for a thin one
  (`50 + (1 − liquidity) × 1000` basis points), **40 %** for a memecoin. The fee never takes more than the credit.
* **Counted exactly.** `positions.accrued_tick` is the tick up to which the position has paid. Every 60 ticks (`step`), and before any order that changes the position (`Trading.placeOrder` calls `settle` first), the cost for the
  ticks since then is worked out with BigInt whole cents (`accrue`). Less than a cent owed means nothing is charged and the time keeps counting; when something is charged, `accrued_tick` moves forward only by the ticks that paid for it
  (to the nearest tick), so cutting time into small steps changes the total by no more than a cent or so (MARGIN-3); an order settles the position and starts a new count, so a part of a cent can be dropped there. (On a loan of millions
  one tick costs more than a cent and the part of a cent a tick cannot show is left out of each minute's charge: under 0.4 %, in the player's favour.) `positions.charged_cents` keeps the sum, shown on the account screen. A position from before migration 16 (`accrued_tick` NULL) starts paying from the first settle.
* **Replay.** The charge runs in the market's step observer, before the liquidator, also for ticks replayed after the server was off, so a restart gives the same debts as staying on.
* **Margin call.** Every 5 ticks, a Career position that has lost three quarters of the cash put in (equity ≤ 25 % of `cost_cents`, still above 0) gets one warning, an SSE `position` event with `reason: 'margin_call'` (plus `leverage`
  and `liqPriceCents`); the pop-up says to sell some or all to keep what is left. It can warn again after the position is back above 50 %. Warnings are only sent while the market is live (`world.lagTicks <= 5`), never while it catches up.
  There is no partial liquidation: the warning is only a warning.
* **Screens.** The trade panel shows "Interest on the debt" or "Borrow fee", the rate and about how much it is per day, before the order; the account screen shows the rate and what has been paid so far for each position. The estimate carries `rateBps` and `costDayCents`.

### 6.6 The memecoin trading fee (`server/fees.ts`, `server/trading.ts`, schema 13, tests `server-memefees`)

Memecoin orders pay a fee; stock orders do not (the old 0.1 % fee on every order is not in this version). One constant, `MEME_FEE_BPS = 50` (0.5 %), in `server/fees.ts`;
`new Trading(db, world, now, feeBps)` takes another rate (tests do; the game never does). `feeOf(total, bps)` is the fee in whole cents, rounded UP, exact with BigInt.

* **Who pays.** A company in the `'meme'` sector, on a **Career** account. A 1v1 match account never pays (both players start equal and are scored on the published price), and a stock never does.
* **On what.** The VALUE of the order (what the book fills the shares for, with the player's own price push included), not the margin: a 50× order of $10 of cash is $500 of value and pays $2.50.
* **Which orders.** Every buy, sell, short and cover, and the closing the market makes by itself at a stop-loss or take-profit (`closeByExit` goes through `placeOrder`, so it is the same code).
  The market's own **liquidation carries no fee** (its trade row keeps the default `fee_cents = 0`): the margin is already lost.
* **How it is paid.** *Opening* (a buy, or a short sale): cash falls by `margin + fee`; the position's `cost_cents` is the margin only, so liquidation prices, collateral and leverage limits are the same with or without a fee
  (FEE-14). *Closing* (a sell, or a cover): the fee comes out of what would come back (a long: value − debt; a short: collateral part − cost of buying back) and is capped at it, so a position that comes back with nothing pays nothing (FEE-8).
* **Profit figures.** `trades.realized_cents` has the fee taken out: an opening trade says `−fee`, a closing trade `received − cost removed` with `received` already after the fee. So `realizedCents` of the account plus the open positions'
  unrealized profit equals net worth − start cash, exactly as before (FEE-3).
* **Estimates.** `estimate` returns `feeCents` and `feeBps`; `netCents` already has the fee in it (opening: `margin + fee`; closing: what comes back − fee). `affordableQty` / `affordableShortQty` count the fee, so
  "most you can buy" is exact (FEE-12). An order the cash covers without the fee but not with it is refused with `insufficient_cash`, the message says "including a fee of …" and `details` has `{cost, fee, cash, maxQty}` (FEE-13).
* **Stored.** Migration 13 adds `trades.fee_cents` (default 0, never negative); every trade before it, every stock trade and every match trade says 0. `TradeView.feeCents` and the estimate carry it to the screens
  (the trade panel's fee rows, the trade list's **Fee** column, the sentence after an order).

### 6.8 Limit orders (`server/limitOrders.ts`, `server/routes/limits.ts`, migration 16 table `limit_orders`, tests `server-limit`, `limit-ui`)

A **limit order** waits in the market until the price reaches the limit the player typed. **Career only**: a 1v1 match is three minutes of market orders, and the form shows no Market/Limit switch there.

* **Four kinds.** Buy, sell, short and cover, with the leverage, stop-loss and take-profit of an order that opens a position (they apply when it fills; a stop must be on the right side of the *limit*, which is the price it will trade at).
* **When it trades.** A buy or cover waits until the ask is at or below the limit, a sell or short until the bid is at or above it. The order is then sent through `Trading.placeOrder` with the limit as its price limit, so it pays the spread, walks the order book, pays the memecoin fee and pushes the price like any other order,
  and **nothing is ever filled above (a buy) or below (a sell) the limit**. A price that has already gapped past the limit fills at the better real price. If the book at that price is too thin, the part that filled is booked and the rest keeps waiting (tried again every 5 ticks, `RETRY_TICKS`).
  The check runs in the market's step observer once per tick, after the margin charge and the liquidator.
* **Cash is set aside.** An order that *opens* a position takes what it could cost at its limit (`Trading.openingReserve`: the margin of `qty × limit` at its leverage, plus the fee) out of the player's cash when it is placed, so the same money cannot be promised twice or spent elsewhere. It comes back when the order fills
  (the real cost is then paid like any order's), ends, expires or is cancelled. The set-aside cash still counts in **net worth** (`AccountView.reservedCents`), so placing an order never changes it. A partial fill sets aside cash for the rest; if the player no longer has it, the rest is cancelled with a sentence saying so.
* **Shares are promised.** An order that *closes* a position sets no cash aside; instead all the open orders of one company and side together may never ask for more shares than the position holds (`insufficient_shares`, which says how many are already promised). If the position is smaller when the price is reached (a stop-loss closed it), the order trades what is left; if it is gone, the order ends at once (`step` checks every tick), so it can never open a position by accident.
* **Time and number.** Each order is good for 1 hour, 1 day (default) or 3 days (`GOOD_FOR_TICKS`; one tick is one second) and ends by itself with the cash returned; at most 20 open orders per account (`too_many_orders`).
* **Only in the live market.** Nothing fills while the server is catching up (`world.lagTicks > 3`), as with stop-losses, so there is no filling on prices from the past. A halted or not-yet-trading company, a banned player and a rate-limited order just wait. An owner reset of the account ends its orders with no refund (the reset already restored the cash).
* **Safe to retry.** `(account, clientOrderId)` is unique, so a second POST returns the first order. Each trade an order makes has the id `limit-<order id>-<n>`, so a fill can never be booked twice; one order's fills and refunds are one database transaction (`attempt`), all or nothing, and a restart keeps every order (the table is the only state).
* **Routes (signed in, Career).** `GET /api/limit-orders?state=open|all&limit=` (the player's own orders only), `GET /api/limit-orders/estimate?ticker&side&qty&limit&leverage&short` (the cash that would be set aside, the most shares that fit, `fillsNow`; the form shows these numbers and works out none of its own),
  `POST /api/limit-orders` and `POST /api/limit-orders/cancel`. Rate limit 40 per 10 seconds. An SSE event `limit` `{what: 'fill' | 'ended', order}` goes to the owner of the order only, and the browser shows a pop-up and refreshes the account.
* **Screens.** The trade panel has a Market/Limit switch (a new company always starts on Market): limit price with quick buttons (−1 %, −3 %, −5 %, −10 % from the ask for a buy, + from the bid for a sell, and *Now*), *Good for*, and a preview with the set-aside cash, the cash afterwards and when it will trade. Under the form are the open orders of that company; **My account** shows
  *Set aside in open orders*, the *Open orders* list with *Cancel*, and marks trades that came from a limit order.
* **No money machine.** An automatic "buy a little lower, sell a little higher" robot (30 stocks, about $5,000 an order, ±0.4 %, re-placed every simulated minute) *lost* 4.4 % of $1 million in two simulated hours on the random-walk market: every fill pays the spread and the price move that follows its own push, and nothing in the price is predictable from the order book.
  (A probe, not a test; it is not part of the project.)

## 7. News

### 7.1 Generation (`src/world/newsgen.ts`, `newsText.ts`)
The generator is a pure function of `(world seed, catalog, day)`. For each company and each 24-hour **cycle** (day) it
creates:

* **three core stories**, one in each third of the day (with a margin so they are never stacked at the edges), always
  with three different headlines and at least two different categories;
* **extra stories** sometimes (30 % and 7 %);
* an **earnings report** every fiscal quarter, which is **3 days** of the market (on the same day of the quarter for ever, at a company-specific offset; it replaces one core story), with real numbers: profit per share against what analysts expected, revenue, the change on a year ago (§7.5);
* for a company listed during the day, a **listing announcement** first, and its three core stories fall between listing
  and the end of the day;
* for the market: **sector stories** (about 0.7 per sector per day), **economy stories** (about 0.65 per day) and rare
  **viral stories** (§7.4).

Headlines come from ~280 hand-written templates in 11 company categories (product, partnership, management, legal,
operations, financial, analyst, contract, research, incident, demand) filled with the company's own name, products,
CEO/CFO, headquarters and a partner company. The text is template-based: **there is no AI text generation**.

Every story has a **public** side — headline, body, category, direction (positive / negative / uncertain), strength
(minor / moderate / major / extreme), a *breaking* label — and a **hidden** side: the *realised* move (what the market
will really do), how much of it is permanent, and, for viral stories, how credible the source is. Headline and reality
agree most of the time (about 70–88 % depending on category) but not always, so a headline is a clue, never a guarantee.

### 7.2 Storage and scheduling (`server/news/service.ts`, `scheduler.ts`)
* **Table `news_items`** — one row per story: `key` (unique), company / partner / sector / scope, kind, category, day
  (`cycle`), `slot`, `publish_tick`, `start_tick`, `end_tick`, duration, shape, immediacy, direction, strength, hidden
  `realized` and `perm_share`, `credibility`, headline, body, `breaking`, `source`, `created_ms`, and the price records
  `price_at_publish` / `price_at_end`. Newest-first order is `publish_tick DESC, id DESC`.
* **Written ahead.** A whole day is generated at once, in one transaction per day. Stories are stored before they are
  published and hidden from players until `publish_tick ≤ the market's tick`.
* **No duplicates.** Every story has a deterministic unique key (`c{company}:{day}:{slot}`, `s{sector}:{day}:{n}`,
  `m:{day}:{n}`, `v:{day}:{n}`) and is written with `INSERT OR IGNORE`. Running a day twice — after a crash, or by two
  copies of the program — cannot create a second copy. Tested, including with a second service holding stale memory.
* **Progress is saved**: `news_company_state` (per company: generated through which day, time of last success, items
  written) and `news_cycles` (per day). A new company with no state is generated from its listing day on.
* **Missed schedule recovery.** On every run the scheduler looks at what is missing and writes it: after 20 days of
  downtime it writes the 20 missing days in one pass (tested).
* **Scheduler** — every 30 s, inside the server process, independent of players, it takes a lease, makes sure news exists
  through *clock + 12 hours*, checks the result and records `lastRun / lastSuccess / lastError`. Its failures are logged as
  errors and counted; they are never swallowed.
* **The market cannot run on missing news.** The price engine asks the news service for the stories of the next 6 hours.
  If that fails, the market *stops visibly* (`/api/health` shows `stalled` and the reason, trading is refused) and resumes
  by itself when the news can be written again. It never silently continues without news.
* **If the generator would produce fewer than 3 core stories for a company, generation throws** and the whole day is
  rolled back, so a day with a missing company cannot be stored.

### 7.3 How news moves the price
A story becomes **effects**, one per affected stock (the company; its partner at 35 % for partnership stories; every
company of the sector for sector stories; every company for economy stories). An effect has:

* a **total move** = `sign × realised size × company news sensitivity`, where the size is drawn from the story's real
  strength (minor ≈ 0.2 %, moderate ≈ 0.7 %, major ≈ 2 %, extreme ≈ 5 %, each × 0.6…1.5) — the *real* outcome, not the headline;
* a **shape** whose weights add up to exactly 1: `burst` (6 ticks, immediate reaction), `front` (front-loaded) or `ramp`
  (gradual build-up and fade), and a **duration**;
* a **permanent share** (kept in the fundamental value) and a temporary share (fades back);
* an **onset**: immediate stories react within 0–2 ticks; gradual ones start 20–90 s after publication.

Because an effect is a pure function of `tick − startTick` with weights that sum to 1, **each story is applied exactly
once in total** — not once per tick — no matter when the server stops and restarts. This is tested three ways: restart
equality, an independent replay, and the weights-sum-to-1 property tests in `world-effects.test.ts`.

**Records.** For every company story the server records the price just before publication (`price_at_publish`) and the
price at the last tick of its effect (`price_at_end`), inside the same transaction as the market state. The *outcome* is
shown to players only after both exist. Owner-only `/api/debug/effects/:ticker` lists, for a company, every story that is
affecting its price, with the hidden numbers.

Measured in the sandbox over four simulated days (12 companies, 166 finished stories): all 332 stored prices equal an
independent replay of the market from the stored stories; compared with the same market without news, every story moved
its stock in the direction of its hidden outcome (mean 0.58 % per story).

### 7.4 Rare viral events
Per day, 62 % of days have none, 30 % one, 8 % two. A viral story has a fictional **person** (influencer, founder,
official, investor, whistleblower…) or a **clip/rumour**, a credibility, and a realised outcome that may be large. Stories
from low-credibility sources often fade: the generator adds a follow-up story 20–60 minutes later whose real move is
the opposite of the first, 50–90 % as large (it is published as the rumour being walked back). All are labelled *breaking* when they are viral, extreme, or major and market-wide. The people are
invented; no real person, company or ticker is used.

### 7.5 Earnings and fundamentals (`src/world/fundamentals.ts`, `server/earnings.ts`, `server/routes/earnings.ts`, tests `world-earnings`, `server-earnings`)
A company's numbers are a pure function of `(world seed, company, quarter)`; nothing is stored. A fiscal quarter is **3 days** (not 91, so a player sees
reports often; four quarters make a "year" of 12 days).

* **Consensus** (what analysts expect, public in advance): profit per share in *mills* ($0.001, so a cheap stock's quarter is not a rounding error) and revenue.
  It follows a slow wave around a level fitted to the company's sector and character (`SECTOR_FINANCE` P/E and margin; growth stocks are dear,
  declining ones cheap). The wave is a triangle between −amplitude and +amplitude, so earnings and P/E never run away.
* **Actual** = consensus + **surprise**, and the surprise is tied to the earnings *news item*: a positive item beats, a negative one misses, an uncertain one
  is in line or mixed (EPS beat/revenue miss and the reverse), and the item's strength sets the size (minor 1–3 %, moderate 3–7 %, major 7–15 %, extreme 15–30 %).
  So the numbers in the headline always agree with the headline, and the price follows the story exactly as it follows every other story (§7.3). The
  generator keeps its old order of random draws, so other stories of a world do not change.
* **Revenue** = profit ÷ the company's net margin. **Year on year** compares with the consensus level a year (12 days) ago. **Trailing profit** is the
  last four reports; **P/E** = the current price ÷ trailing profit (a live price, one decimal).
* Headlines say the figures ("Autopilar posts third-quarter profit of 41.2¢ a share, beating the 38.0¢ expected, as revenue rises 6 % on the year");
  the wording lives in `EARNINGS_TEMPLATES` with a `{qn}` slot for the quarter.
* **API (public):** `GET /api/market/:ticker/earnings?limit=` → trailing profit, P/E, trailing revenue, net margin, the **next report** (date and consensus
  only) and the last reports (default 8, ≤ 40); `GET /api/earnings?hours=` (1–72, default 24) → `upcoming[]` (soonest first) and `recent[]` (latest first).
  A memecoin, or a company that does not trade yet, answers `applies:false`. Only reports whose publish tick has come are shown; the direction, strength
  and hidden move of an unpublished report never reach the answer (EARNSRV-2 checks the keys).
* **Screens:** an "Earnings" panel on every stock's page (profit per share, P/E, next report, a table of reports with beat/miss and how the price reacted) and
  an **Earnings** tab with the calendar (next 24 h / recent 24 h).
* **Older worlds:** a report published before this feature has a headline with no numbers; it is detected (its stored direction/strength/tick do not match
  the model) and shown as "legacy" with no figures, and it does not enter the trailing sum (the model's numbers are used there). Reports from the
  first start with this version on follow the 3-day schedule; the old 90-day offsets are not reused.

### 7.6 What players see
`GET /api/news`, `/api/market/:ticker/news` (own + partner + sector + economy stories), `/api/news/:id`. Filters:
`category`, `breaking=1`, `limit` (≤ 100), `before=<cursor>` for paging. Unpublished stories are never returned. The
hidden realised move, permanent share and source credibility **never leave the server** (a test fails if any such field
name appears in a response). Live: the server pushes a `news` event on the stream at publication time.

## 8. The server

### 8.1 Structure
`server/` is a dependency-free Node program (only `node:` modules; SQLite is `node:sqlite`, **Node ≥ 22.13 required**):
`app.ts` builds everything and does not listen (tests drive it directly); `main.ts` listens (and also serves the built
site from `dist/` if it exists). Routes: `routes/core.ts` (health, accounts, market, candles, book, estimate, orders,
stream), `routes/news.ts` and `routes/lobby.ts`.

### 8.2 Accounts and safety
Passwords are hashed with scrypt; sessions are random tokens in an `HttpOnly; SameSite=Lax` cookie, stored hashed; sign-in
and sign-up are rate limited; order rate limit 40 per 10 s per user; request bodies are limited to 16 KB; POST requests
from other websites are refused (origin check); the owner role comes only from the server operator (`TQ_OWNER`, or the first
line of `data/owner.txt`, written by `npm run owner -- <username>`) and is checked on the server for every owner-only route
(§8.5). A **banned** player (table `user_bans`, §8.5) is treated as signed out on every request, whatever cookie his browser holds:
`Auth.userFor` returns null while a ban is in force, `login` answers 403 `banned` with the reason (only after the password was
right, so the ban status of an account is not revealed to strangers), and `/api/me` reports the ban to the page that holds the
cookie so it can say why. Nothing sent by a browser can set a price, a fill, a balance or a role.

### 8.3 One program, one schedule, and monitoring
* A **server lease** in the database (30 s, renewed every 10 s) stops a second TradeQuest server from starting on the same
  data folder ("Another TradeQuest server is using this database"). A crashed server's lease runs out by itself, and a
  lease whose owner process no longer exists on the same computer is taken over immediately.
* A separate **news-scheduler lease** (90 s) stops two schedulers from working at once; the second one skips its turn.
* Even without leases the unique keys make duplicates impossible; leases only prevent wasted and conflicting work.
* `GET /api/health` returns: tick, clock tick, lag, catching-up, stalled reason, saved tick, companies, listed, engine
  version, SSE client count, the last problems from the log, and the news summary (generated-through day, companies behind,
  companies below 3 stories today, item counts, scheduler last run/success/error). `ok` is false if any of these is wrong.
  `GET /api/news/health` returns the news part alone.

### 8.4 Scale
Per tick the cost is proportional to the number of companies (about 25 random numbers each). Measured with
`npx tsx tools/bench-world.ts` in the development sandbox (one CPU core, **not** the owner's computer):

| Companies | History speed | Catching up after downtime | One live second | Worst of 120 live seconds | News per day | Database after 15 days |
|-----------|---------------|----------------------------|-----------------|---------------------------|--------------|------------------------|
| 300 | 1.82 M company-ticks/s | 9,023 ticks/s (3 days of downtime in 28.7 s) | 0.09 ms | 20.4 ms | 1,022 | 94 MB |
| 1,000 | 1.22 M company-ticks/s | 2,131 ticks/s (3 days of downtime in 121.6 s) | 0.18 ms | 38.2 ms | 3,383 | 310 MB |

So the live clock has a huge margin (a tick must finish inside 1,000 ms). The cost that grows is catching up after a long
stop: a month of downtime with 1,000 companies would take about 20 minutes, during which the market is visibly "catching
up" and trading is closed. The database grows roughly 20 MB per day at 1,000 companies (news text and hourly / daily
candles are kept forever by design; 10-tick candles are kept 25 hours). Thousands of companies would need the per-tick
loop moved to a worker thread (not done). `TQ_COMPANIES` sets the number (default 66, up to 5,000); companies are only ever
added, never removed.

### 8.5 Owner tools (`server/admin.ts`, `server/halts.ts`, `server/routes/admin.ts`)
**Who is the owner.** Exactly one username, set only by whoever runs the server: `TQ_OWNER` wins, otherwise the first line of
`data/owner.txt` (`^[A-Za-z0-9_]{3,20}$`, anything else stops the server with a clear message). At every start
`auth.applyOwner()` makes that user the owner and demotes every other owner; with nothing configured nobody is the owner. The
role is read from the database on every request, so changing the owner needs a restart and nothing a browser sends can
change it. All admin routes (`GET /api/admin/state`, `POST /api/admin/shock|halt|stock|flow|cash|coins|shares|ban|unban|reset|announce|pause`) answer 401 when nobody is
signed in and 403 `owner_only` for anyone who is not the owner. Every POST carries a `requestId`; the same id is accepted once
(`admin_log.request_id` is UNIQUE) and answered 409 `request_id_reused` afterwards, so a double click or a retry cannot apply an
action twice.

**Moving a price is a news story, not a hack.** `Admin.shock` builds an ordinary `NewsDraft` (source `admin`, slot 900) with the
chosen shape (instant = burst over 6 ticks, fast = front over 300 ticks, slow = front over one hour), writes it to `news_items`
together with its `admin_log` row in one transaction, and only then hands it to the world (`WorldRuntime.scheduleEvent`). The
event starts at least 4 ticks in the future (`EVENT_START_DELAY_TICKS`), because the effect book refuses events that begin at
or before a tick that has been processed. If the start lies beyond the window of news already loaded, `scheduleEvent` loads the
next window instead (this keeps the "price at publish" mark that the news list uses to show what the price really did).
Because the event is a stored row, the §3.2 rule still holds: prices are a pure function of (seed, catalog, stored events) and a
restart replays the move exactly (`tests/server-admin.test.ts` ADM-10 stops a server in the middle of a move and compares every
price and candle with a server that never stopped).

**Hitting the requested percent.** A target multiplier `m` (−99 % … +900 %) is turned into the event's total effect with
`solveTotal`, a bisection on the logarithm: per tick the factor is multiplied by `1 + effect + permanent`, so the total that
gives `m` over the shape is found numerically. The realised result is close to the request but not exact, because the price
also moves randomly while the event plays out; the screen says "about". The price stays within $1.00 … $1,000,000.

**Halts.** `trading_halts` (company id, reason, time, who) is mirrored in memory (`Halts`). `Trading.checkMarket` refuses an
order for a halted company with `OrderError('halted', …, 403)` for both Career and 1v1 orders; prices, candles and news keep
running. The market list and the company page show a Halted badge. Halts survive restarts.

**Automatic pauses (circuit breaker; `server/breaker.ts`, table `auto_pauses`, schema 10, tests `server-breaker`).** Real exchanges
stop trading in a stock for a few minutes when its price runs too far too fast; the market does the same by itself. Every 5 market
seconds `CircuitBreaker.step(tick)` (called from `WorldRuntime.stepOnce` through `setStepObserver`, wrapped so that it can never
stop the market) notes each company's price. A company is paused for 5 minutes (300 ticks) when its price is a *band* or more away,
up or down, from the oldest price noted in the last 5 minutes. The band depends on the size class, as real exchanges use wider bands
for riskier stocks: **mega and large 10 %, mid 15 %, small 30 %, micro 45 %** (`BREAKER_BANDS`). One flat 10 % was tried first and
rejected: this market's small stocks move 10 % in 5 minutes about a third of the time on their own (micro-cap median 6 %, small 4 %,
mid 1.9 %, large 1.2 %), which paused about a hundred stocks an hour. With these bands the natural rate is about 7 pauses an hour in
the whole market (small stocks about once in four hours, mid once in a day, large almost never), while a player's pushes (§8.6) and
big news still trip them. While paused: orders are refused like a halt (`OrderError('halted', …, 403)` with `details.auto`,
`moveBps` and `reopensInTicks`, the text "Trading in X is paused automatically: the price fell 12.3% within 5 minutes; reopens in
about 4 minutes"), the market list and company page show **Paused**, the admin "Halted now" list shows it marked *Auto*, and
the price keeps moving. At the end the row is removed, the company reopens at its current price and the 5-minute clock starts
afresh (so it is not paused again at once for the move that was already stopped). *Not* watched: a company while one of the owner's
own price moves (event key `admin:…`) is running — the watching starts afresh when it is over, so pumps and crashes from the admin
panel never trigger it —, a company the owner has halted, and everything while the owner has paused all trading. While the market
replays the past after downtime, a pause that would already be over is not made. The owner's *Resume* also reopens an automatic pause
at once (and writes the usual `resume` log row). A pause is stored (`since_tick`, `until_tick`, the two prices, the move in basis
points), so a restart keeps it until it runs out. Switch off for tests with `AppOptions.autoPauses: false`. The rule never changes a
price and is not part of the world engine (`WORLD_ENGINE_VERSION` is unchanged).

**Cash and coins.** `adjustCash` changes Career cash and the account's start cash by the same amount (a gift is a deposit, so
it does not appear as trading profit); taking more than the player has is refused. `adjustCoins` changes the 1v1 wallet and
writes a `wallet_ledger` row (`admin_grant` / `admin_take`). Both are limited to $1,000,000,000 per action.

**Shares.** `adjustShares` gives (positive) or takes (negative) shares of one trading company, up to 1,000,000 at a time. The shares
are valued at the current bid (what net worth uses); that value is the position's cost and is added to (or taken from) the
account's start value, so a gift never shows as profit or loss. Taking more than the player holds is refused.

**Bans.** `banPlayer` writes `user_bans` (reason, time, optional end, who) and the log entry in one transaction; the owner and the
acting user cannot be banned. A ban lasts 1 – 8,760 hours or until lifted; a ban whose end has passed simply stops counting. Right
after the commit the server leaves the player's 1v1 lobby (`MatchService.leave`: a lobby is left, a live match is a forfeit) and
closes his open streams (`SseHub.dropUser`; the browser reconnects as a guest). The player's money, shares and coins are not
touched, his sessions are kept (so an unban brings the old session back), and `unbanPlayer` removes the row. A ban belongs to the
username: it cannot stop the same person from creating a new account.

**Reset.** `resetPlayer` gives the Career account `START_CASH_CENTS` (cash and start value), deletes its positions and order-book
usage (`impact_state`) and sets `accounts.reset_trade_id` to the newest trade id. Trades are never deleted — their ids name the
stored price pushes (`flow_events.key = f<tradeId>`, UNIQUE), and SQLite may reuse the id of a deleted newest row — instead
`Trading.view` and `Trading.trades` only count trades with a larger id, so history and realized profit start from zero.

**Pause all.** `meta.trading_paused` (reason, time) is read by `Halts`: while set, `isHalted` is true for every company, the
market list shows every company as halted, and orders (Career and 1v1) are refused with `OrderError('halted', …)` saying that
trading is paused for the whole market; single-company halts keep working and are named first. Prices, candles and news continue.

**Announcement.** `meta.announcement` (text up to 200 characters, time). `/api/health` carries it (and the pause) for every
visitor; changes, halts and pauses are also pushed as a `notice` event on the live stream, so open pages update at once.

**Making a company.** `POST /api/admin/stock {requestId, name, ticker, sector, tier, personality, priceCents, industry?, description?}`
(`Admin.createStock`) validates with `makeEntry` (400 `bad_request`, 409 `name_taken` / `ticker_taken` / `restart_needed` /
`too_few_companies`), writes the company in one transaction, loads it into the running market (§4.1), refreshes the cached views,
publishes a `notice` event so open pages reload their company list, and answers `{ticker, name, companyId, listingTick,
startsInSeconds, loaded}`; `loaded: false` means it is saved and will start with the next server start. `GET /api/admin/state`
carries `stocks` (the owner's companies, newest first) and `stockForm` (the choices and limits the form shows).

**Audit log.** `admin_log` records every action once: id, request id, time, admin user, action (`shock`, `halt`, `resume`, `cash`,
`coins`, `flow`, `ban`, `unban`, `shares`, `reset`, `announce`, `pause`, `unpause`, `stock`), target and details as JSON. The admin panel
shows the latest 60. The allowed action names are checked in the program (`AdminAction`), not by a database CHECK, so adding one
needs no table rebuild.

**Screens.** The profile button (`src/shared/ProfileMenu.tsx`) has Log in / Create account for guests and My account / Admin
panel (owner only) / Log out for signed-in users. The admin panel (`AdminScreen`, `AdminMarket`, `AdminStocks`, `AdminBroadcast`, `AdminPlayers`,
`AdminLog`) is not in the top menu; it is reached only from the owner's profile menu, and the page leaves it if the user is not (or
is no longer) the owner. Risky actions (ban, reset, pause all, price moves) take two clicks, and each confirmation carries its own
request id. Every visitor's page shows, at the top (`Notices.tsx`): the announcement (dismissable per visitor), a "trading is
paused" notice, and, for a player whose session ended because of a ban, the ban and its reason.

### 8.6 Player trades move prices (`server/flow.ts`, tests `server-flow`)
Until this section's feature existed, the price was a pure function of the simulation and the news; what players did had no effect on
it. Now every filled **Career** order pushes the price of that company: buying up, selling down, thin and small companies the most.

**The model.** All players share one **pressure** per company: net shares bought minus sold, fading with a half-life of 5 minutes
(`FLOW_HALF_LIFE_TICKS`, the same time the order book needs to recover). The push for a pressure `P` is the square-root law found
in real markets:

    push = gain × σ × sign(P) × √(|P| / depth)

`σ` is the company's typical move over 5 minutes (`vol3m × √(300/180)`), `depth` the number of shares in its 20-level book
(`bookDepth`), `gain` the one fixed strength (`FLOW_GAIN` = 1, the real-market size). The push depends only on the pressure, never on how the trades were cut up, so one big
order and many small ones push exactly the same (FLOW-8). Pressure never counts for more than 3 books and one order never pushes
by more than 25 %. Example for a $1,000 order: a $26 M company with a 5,500-share book moves about
0.7 %; a $445 M company about 0.08 %; a $79 B company about 0.003 %.

**How it reaches the price.** An order's *change* in push becomes a stored event (`kind 'flow'`, shape `front`, 30 ticks, 25 % of
it permanent, total = `FLOW_MOVE_SHARE` 0.4 × push). It is written to `flow_events` in the same transaction as the trade, handed to
the world (`WorldRuntime.scheduleEvent`) only after the commit, and read by the price engine exactly like a news story. So §3.2
still holds: prices are a function of (seed, catalog, stored events) and a restart replays the same prices, also in the middle of
a push (FLOW-12). `flow_state` keeps the pressure per company so it survives a restart too. The simulation (`src/world`), its
parameters and the engine version are unchanged; the only type-level change is `'flow'` in `EventKind`. Composite news hooks
(`combineHooks` in `app.ts`) give the world the news events and the stored flow events together.

**No free money.** If only the mid price moved, "buy, wait, sell" would make money from your own push. So the trader pays
`FLOW_PAID_SHARE` 0.6 × |push| on top of the book prices (`applyMarkup`: every fill price is moved against him), while only 0.4
reaches the price. His own push is therefore always worth less to him than it costs (FLOW-10 compares buy-wait-sell at 3, 40, 150
and 700 seconds with a twin world without pushes). The estimate (`GET /api/market/:ticker/estimate`) uses the same function as
the order and adds `moveBps` and `paidBps` (basis points, one decimal), shown in the trade panel as "Effect on the price". The
limit price and `maxQty` are checked after the markup, so "max" stays exact (FLOW-11).

*Order size ceiling.* With prices that can reach $1,000,000 a share, the cost of an order (and of a gift of shares) could pass
the whole-number range of a JavaScript number (2^53 cents). `maxOrderShares(price)` is the largest order that stays inside it; a
bigger one is refused with `400 too_large` and `maxQty` instead of crashing (`OSTK-13`). The admin "give shares" action has the
same guard.

**What is left out.** 1v1 match accounts: a match is scored on the one published price, so a player must not be able to lift that
price with his own order (FLOW-14). Worlds without the real news service (`news: null`, some tests) have no flow service either.

**One fixed strength.** There is no dial and no per-stock setting: every Career trade in every company pushes with `FLOW_GAIN` = 1,
the size of the real market, so only thin, small companies move visibly and a big company hardly moves at all (a $400 B mega-cap
sold by one player moves about a thousandth of a percent). Older databases may still hold `meta.flow_level` (the former dial) and
`custom_companies.flow_mult`; both are ignored, and the old log entries (`flow`, `sens`) are still shown in the admin log. Tests
make pushes stronger or switch them off through the test-only option `AppOptions.flowGain`, so that effects show in seconds of market.

**Storage.** Migration 6 (schema 6): `flow_events` (one row per trade that moved a price: key `f<tradeId>`, start/end tick,
duration, total, permanent share), `flow_state` (pressure and tick per company) and a rebuilt `admin_log` whose CHECK allows the
action `flow`. The upgrade keeps every existing row (FLOW-13).

## 9. 1v1 lobbies and matches

Code: rules `src/world/matchRules.ts` (pure functions), service `server/lobby/service.ts` (`MatchService`), routes
`server/routes/lobby.ts`, tables in migration 4 (`matches`, `match_players`, `wallets`, `wallet_ledger`), screens
`src/shared/LobbyScreen.tsx` and `MatchScreen.tsx`. A lobby waits for a real second player; if none comes, a **bot** (a computer player, §9.9, `server/lobby/bots.ts`, migration 15) can take the other seat.

### 9.1 The idea: a match is a window on the one shared market
A match starts at server tick **S** (always a multiple of 10) and ends at tick **E = S + 180**. One tick is one second of
the server clock, so a match lasts exactly 180 s. Nothing is copied or restarted: both players see the **same** global
prices, news and clock. Each player trades a private **match account** created when the match goes live with exactly
**$1,000.00** (100,000 cents), separate from the Career account. Match orders fill against the same liquidity model as
normal orders (spread, depth, impact, partial fills) but only change the player's own match account and their own used-up
depth, never the shared price, so any number of matches can run at the same time without affecting each other or the market.

### 9.2 Life of a match
1. **Lobby.** `POST /api/lobby/join` puts the player into the oldest lobby that has exactly one player, or opens a new
   one. A player can be in at most one unfinished match (a unique index enforces it). A lobby shows `1/2`, then `2/2`.
2. **Ready.** With 2/2 the lobby is in `ready_check`. Each player presses Ready (`POST /api/lobby/ready`); a second player
   arriving resets the ready flags. When both are ready the server starts the **countdown**: start tick S is the next
   multiple of 10 that is at least 10 ticks away (`matchStartTick`), so the countdown is 10–19 s.
3. **Live.** At tick S the server creates both match accounts and the match is `live`. The browsers show a timer made from
   the server's ticks (`end tick − current tick`); both players see the same number.
4. **Settling.** The result is computed when the saved market has reached tick E (see 9.5).
5. **Finished.** Results (profit, final value, result, reward) are stored once. Each player closes the results screen
   with `POST /api/lobby/dismiss`; this only hides it for that player. Finished matches stay in the history
   (`GET /api/matches`).

### 9.3 Where the three minutes are enforced
* The database refuses a match whose `end_tick − start_tick` is not `duration_ticks` (a CHECK constraint), and
  `duration_ticks` is always `MATCH_TICKS` = 180. The browser cannot send a start, an end or a duration.
* **Trading gate** (`MatchService.gate`, called by the order and estimate routes for match accounts): an order is accepted only
  if the match is `live`, `S ≤ current tick < E`, the server clock has not reached E, the market is not lagging by more than
  3 ticks, and the player has not forfeited. Orders sent late are refused with an explanation, whatever the browser's timer says.
* **Scoring uses the stored candle** that closes at tick E (10-tick candle number E/10), not "whatever the price is when
  the server gets around to it". So the result is the same if settlement runs a second late, or after a restart.
* The browser timer is only a display. If a browser's clock is wrong, nothing changes on the server.

### 9.4 Scoring and rewards (`decideMatch`)
* Final value = match cash + shares valued at the **mid** price of the final tick (a leveraged position: minus its debt, never below
  nothing, §6.1). (Career accounts are valued at the bid,
  the price you could actually sell at; for a 3-minute contest between two players both using the same rule, mid is
  fairer. This is a choice; the constant lives in `server/trading.ts`.)
* Profit = final value − $1,000.00. Greater profit wins; exactly equal profit (to the cent) is a **tie**.
* **Winner:** paid their match profit **or $50, whichever is more**, as virtual currency (`winnerReward`).
  **Loser:** paid **$50.00**. **Tie:** both are paid $50.00. **Forfeit:** the player who left is paid $0 and the opponent is
  the winner (paid like any winner: their profit or $50, whichever is more). **Both forfeit:** the match is `abandoned`,
  nobody wins, nobody is paid.
* The reward goes to the virtual-currency **wallet** (`wallets`), never to Career money, and Career money is never read
  or changed by a match. Constants and the rule: `src/world/matchRules.ts`.
* **Decision by the owner (2026-10-16):** the first version paid the winner only a positive profit, which meant a winner
  who earned $6.88 (or lost less than the other player) was paid less than the loser's $50. The owner chose "the larger of
  profit or $50" for the winner, so winning never pays less than losing. Anyone can still collect $50 per match by
  playing, so rewards are small virtual currency with no cash value.

### 9.5 Saved exactly once
Settlement runs in one database transaction that first checks that the match is still `live` (a second call finds it
`finished` and does nothing), then writes the result, the ledger line and the wallet change together; if anything fails
the whole transaction is undone and settlement is tried again later. As a second layer, `wallet_ledger` has
`UNIQUE (user_id, reason, match_id)` and the wallet is only credited when the ledger line was really new, so even a
second settlement that got past the state check could not pay twice. Tests call settlement repeatedly and check the wallet.

### 9.6 Leaving, disconnecting, restarting
* **Lobby / countdown:** the page polls `/api/lobby` every 2 s, which tells the server the player is still there. A player
  not heard from for 15 s is removed; leaving on purpose is the same and has no penalty. If someone leaves a countdown the
  match goes back to the lobby (the other player waits) or is cancelled if nobody is left.
* **Live, browser closed or connection lost:** the match keeps running. The player's account stays (shares are valued at
  the end like any other). They can open the page again and are taken back to the live match.
* **Live, "Forfeit" pressed:** counts as a forfeit (see 9.4). The page asks "Really forfeit?" with two buttons inside the page (a browser pop-up
  can be blocked or dismissed without the player noticing, and then nothing would happen). Against a **person** the match runs on until
  0:00, because the opponent may keep trading; the forfeiter sees "You forfeited" instead of the button, cannot trade, and may use the
  Launch tab (§9.10). Against a **bot** there is nobody to wait for: the match is settled at once (§9.9).
* **Server restart during a countdown or live match:** the match is **cancelled** (`server_restart`), nobody is paid and no
  result is stored, because the system cannot guarantee both players had the same 180 seconds. The shared market itself is
  not affected; it recovers exactly as in §3.4. (If matches should survive restarts, `recover()` would have to resume them;
  that was not built.)
* Lobbies that stay empty are cancelled; a `cancelled` match never produces a result or a reward.

### 9.7 Fairness and abuse
* Both players use the same prices, the same news and the same liquidity rules, and can trade any listed company.
* The opponent's score is **hidden** while the match is live (the server does not send it), so nobody can copy a leader.
* Idempotent orders (an order id can only trade once), the order rate limit, the 16 KB body limit and the sign-in checks
  apply to match orders as well. A user cannot join twice, trade on someone else's match account (accounts are resolved
  from the signed-in user on the server), or read another player's match account.
* Not prevented (and not solvable by code alone): two friends agreeing to throw a match to farm rewards. Rewards are small
  virtual currency with no cash value.

### 9.8 Routes
`GET /api/lobby` (current match, number of people searching, wallet), `POST /api/lobby/join|ready|leave|dismiss`,
`POST /api/lobby/bot` ("Play a bot now", §9.9), `GET /api/matches` (history), `GET /api/wallet`. Pushes: `match` events on the live stream, sent only to the two players
of that match (the stream must be opened after signing in, so that the server knows whose it is; the page does this).
All of them need a signed-in user. They are limited to 30 requests per 10 s per user.

### 9.9 Bots (`server/lobby/bots.ts`, migration 15, tests `server-bots`)
A bot is a **computer opponent** for a player who would otherwise wait alone. To the lobby, the match accounts and the scoring it is an
ordinary player: it has a user row (username `bot-<style>`, shown as "Sam (bot)"; the hyphen is not allowed in a real username and its
password hash can never match, so nobody can sign in as a bot) and a row in `bots` (migration 15: one bot per style). Bots are made on first use.
* **When a bot joins.** (1) A player who has waited **alone for 10 seconds** (`BOT_WAIT_MS`) gets one: `MatchService.autoBots()` runs every tick.
  (2) **"Play a bot now"** (`POST /api/lobby/bot`) joins as usual and, if nobody else is waiting, puts a bot in at once. The bot is already
  Ready; the player still presses Ready, so nothing starts behind his back.
* **Real players come first.** A player who joins a lobby that holds only a bot takes the bot's place: the bot is removed, the Ready flags
  are reset and the two real players carry on. A bot never counts as a person "searching" and never takes the seat of a waiting human.
  When the real player leaves (or is removed for silence), his bot leaves too and the lobby closes. A lobby with a bot is never swept away by the
  15-second presence check (the bot cannot poll).
* **At most 8 bot matches at once** (one bot per style, rotating by match number). If all eight are busy, "Play a bot now" answers 409
  `no_bot_free` and the player simply keeps waiting for a person or for a free bot.
* **Same rules.** A bot trades through `Trading.placeOrder` on its own $1,000 match account like any player: the same gate (live window only), spread,
  depth, partial fills, leverage 1–50×, shorts, stop-loss and take-profit, the same refusals. It never moves the shared price, and the lobby
  never shows a player the opponent's score while the match is live.
* **Only the past.** A bot decides once a tick from the **last finished 10-tick candle** and the earlier ones (`savedTick / 10 − 1`), never
  from the current tick or from any future price. Its choices come from a seeded generator (mulberry32, seed = match and bot), so the same
  match is played the same way after the same market; there is no `Math.random`.
* **Eight styles:** Sam (one big steady stock, little leverage, holds), Mia (chases the strongest riser, 3–5×), Carl (buys the biggest faller,
  2–4×), Dee (wild memecoin trader, 10–25×, either side, 3 trades), Shane (shorts the biggest riser), Rex (a scalper: a few quick stock
  trades with tight exits), Luna (rides the strongest memecoin) and Hank (steady stocks that are down, little leverage). Each opens its
  trades at planned times, closes them after a holding time, makes no new trade in the last 12 ticks and leaves nothing to chance at the
  end: the match is scored on the stored candle like any other. If an order is refused (too big, margin) it tries again smaller and
  at lower leverage, and gives up after a few failures; a failure is logged (at most one line per 10 s), never thrown.
* **Rewards.** The human is paid exactly as against a person (winner: profit or $50, loser $50, §9.4). **A bot gets no wallet money**
  (settlement skips it), and a bot's profit counts for nothing outside the match. The history shows "(bot)" next to the opponent.
* **Forfeit and restart.** Leaving a live match against a bot is a forfeit (the bot wins, the player gets $0) and **the match ends at once**:
  `leave()` settles it right away (`settle(matchId, true)`, scored on the last stored candle, `floor(savedTick / 10) - 1`), and the player gets the
  finished match back with the result screen, instead of waiting for the clock. If that early settlement fails, a warning is logged and the
  normal settlement at the end of the 180 ticks takes over. A server restart cancels the match (§9.6) and frees the bot.
* **Switch.** `TQ_BOTS=0` turns bots off (no automatic bot, no button; `POST /api/lobby/bot` answers 409 `no_bots`). In the tests bots are
  off unless `createApp` is given `bots: true`.

### 9.10 Companies players launched are not tradable in a match (`MatchService.companyRule`, `Trading.setCompanyRule`, tests `server-launch-1v1`)
A launcher holds a big part of his own company and can push its price up with Career orders (§8.6) while a match is running; a match is scored on the
shared price, so he could win with it. Three rules close that:
* **A match account cannot trade a launched company.** `Trading.placeOrder` and `Trading.estimate` ask the rule after the time gate: for an account of
  kind `match` and a company with a row in `launches` the answer is `403 not_allowed` with the sentence `LAUNCHED_IN_MATCH`. Career accounts are not
  asked, so launched companies trade in Career as before. Companies the owner makes on *Create stock* have no `launches` row and are not affected.
* **The page agrees.** Every company row and company page has `launched`; the 1v1 company list leaves launched companies out (with a line saying
  so) and a company page opened in a match shows the reason instead of the trade form. `BotTrader.movers()` skips them, so a bot never picks one.
* **No launching during a match.** `Launches` refuses a launch (`409 in_match`, `NO_LAUNCH_IN_MATCH`) while the player has a match in the
  countdown or live (`MatchService.inMatch`); nothing is made or paid. In the lobby (waiting, or a bot waiting for his Ready) launching is allowed, and
  it works again after the match, or after leaving the countdown. A repeated request id is answered before this check, as for any launch.
  A player who **forfeited** a live match against a person is no longer in it (`p.forfeited = 1`) and may launch while the match runs on.
* **The Launch tab is hidden.** While `match.phase` is countdown or live and the player has not forfeited, `SharedApp` leaves the Launch tab out of
  Career (and shows the market if Launch was the open tab), so there is nothing to click; it comes back by itself when the match ends or after a forfeit.
Not covered: a player can still move the price of an ordinary thin company with Career orders while his match holds it (Career orders always move prices).

### 9.11 Bots in the main market (`server/marketBots.ts`, tests `server-marketbots`)
The eight 1v1 bots also trade in Career, all day, so the market is not empty when nobody is online. There is no schema change: a bot already has a row in
`users` and `bots` (§9.9); the market part gives it one more row, a **Career account** (`accounts`, kind `career`), made on first use.
* **Money of their own.** Each Career account starts with **$1,000,000** (`MARKET_BOT_CASH_CENTS`). A player's cash, wallet and trades are never touched. Order books are
  millions deep (the median stock book is about $2.9 M), so a bot with less would not be felt at all. **When a bot holds nothing, its cash is set back to $1,000,000**
  (`refill`), so winning or losing never makes it bigger or smaller, and a bot can never go broke.
* **Same orders as a player.** Every order is `Trading.placeOrder` on the bot's Career account: it pays the spread and (on a memecoin) the 0.5 % fee, meets the order
  book, and pushes the price by the stored price push of §8.6 (`flow_events`, replayed after a restart). So the live order book tilts, thin companies and memecoins move
  a little and big companies hardly at all. Measured in a 30-minute world with and without bots: stocks median 0.00 % (largest 1.4 %), memecoins median 0.4 % (largest 7 %).
  About 7 orders a minute across the whole market.
* **How they trade.** Each style keeps the picking rule, pool and side it has in a match (Sam the biggest steady stocks, Mia what rises, Carl what fell, Dee wild memecoins
  both ways, Shane shorts risers, Rex a fast scalper of stocks, Luna the strongest coin, Hank bargain stocks), with `MARKET_STYLES`: seconds between decisions, a holding time of
  30 s to 30 min, an order size of 2–20 % of the company's calm order book (never more than 30 % of the bot's cash) and 2–3 positions at a time. **No leverage and no stops**, so
  a bot cannot be liquidated and there is no chain of forced closes. It chooses from the **finished candles** of the last five minutes only (never a price that has not happened yet).
* **They read the news, the reports and the crowd** (`server/marketSignals.ts`, `MARKET_REACTIONS`, tests `server-botreact`). A bot may know only what a player can read: **published**
  stories with their shown tone and strength (never a story that is not out yet, never the hidden move, the permanent share or the source's credibility: the reader does not select
  those columns, and BREACT-1/4 fail if it ever does), the **figures of published earnings reports** (EPS and revenue against what analysts expected, §7.5), a stock's
  **price/earnings ratio against the middle ratio of its sector** (what the Earnings page shows), and the **tilt of the order book** that other traders' orders cause (§6.4, §8.6).
  Each is turned into one signed score per company (+ buy, − sell/short): a story counts 1 / 2 / 4 / 6 (minor … extreme) times its tone, 0.35 if it is about a partner, 0.4 if it is
  about the sector, 0.2 if it is about the whole market (not for coins), less as it ages (down to half at the end of the style's window); a report counts by the size of its EPS
  surprise (a mixed report half); a stock 20 % cheaper than its sector counts 2; a book tilt counts 6 × the tilt when it is at least 0.15. A style **follows** or **fades** each kind:
  | style | news | reports | crowd | needs | waits (s) | window |
  |---|---|---|---|---|---|---|
  | Sam | ignores | follows (the 12 biggest stocks only) | ignores | 3 | 120–600 | 1 h |
  | Mia | follows (buys good news) | follows | follows | 1.5 | 8–40 | 10 min |
  | Carl | fades (buys after bad news) | fades | fades (buys what the crowd sells) | 1.5 | 90–240 | 20 min |
  | Dee | follows both ways (coins) | – | follows | 1.5 | 3–20 | 5 min |
  | Shane | follows (shorts bad news) | follows (shorts misses) | fades (shorts what the crowd piled into) | 1.5 | 15–60 | 15 min |
  | Rex | follows (big stories only) | follows | ignores | 3 | 2–12 | 3 min |
  | Luna | follows (coins) | – | follows | 1.5 | 5–30 | 5 min |
  | Hank | fades (buys overreactions) | buys **value**: stocks cheap next to their sector | ignores | 1.5 | 120–400 | 1 h |
  Every bot waits a **delay of its own for every story** (a fixed function of the bot and the story, so a run can be replayed; a person needs a moment to read and click), acts on a
  story **once**, and looks at the signals in only some decisions (`attention`, 70–100 %); with no signal worth acting on it trades as before (the chart). A style keeps its side (a
  long-only style only buys, Shane only shorts, Dee goes either way), its pool (stocks, coins) and its order size. If a bot is full, a good idea takes the place of a position that
  was opened for no particular reason. **Followers (Mia, Dee, Shane, Rex, Luna) leave a position early** when a story arrives that points the other way (`early-exit`). At most **two
  bots hold the same company on the same side** because of a signal, so they cannot all pile onto one story. The latest 400 reasons are kept in memory (`App.marketBots.decisions()`).
* **Left alone: launched companies** (§9.10, §8.6): a launcher's own money decides the price of his company, so a bot never buys, shorts or sells it (they are not in `movers()`).
  Companies the owner made on *Create stock* are ordinary companies and are traded.
* **Careful with the clock.** A bot does nothing while the market is more than 3 ticks behind the clock (after downtime), a refused order (halted company, thin book) is simply tried
  again a little later, and a halted or paused market gets no bot orders at all. A failure is logged (at most one line per 10 s), never thrown.
* **Seeded and replayable.** Every choice comes from a seeded generator (user id), so the same world plays out the same way twice (MKB-5). A restart finds the same accounts; a position
  that is open at a restart is closed after a normal holding time (the plans live in memory only).
* **Switches.** On whenever the bots are on (`TQ_BOTS`); `TQ_MARKET_BOTS=0` turns off only this part (the 1v1 bots stay). In the tests it is off unless `createApp` is given
  `marketBots: true`. In the owner's Players tab the bots show as `bot-sam` … `bot-hank` with their Career cash and net worth.
* **1v1.** A bot can be in a match (match account, §9.9) and trade in the market (Career account) at the same time; they are different accounts (MKB-9). Like any Career order, a market bot's
  order moves the shared price during a match; both players see the same price, and no player can predict a bot (the choices are seeded, the decisions use finished candles only).

## 10. Tests

All tests are in `tests/`. The world and server tests are: `world-catalog`, `world-effects`, `world-sim`,
`world-liquidity`, `world-news` (generator), `server-runtime`, `server-trading`, `server-api`, `server-news` (service,
scheduler, restart, downtime, replay, failure injection), `server-news-api` (HTTP, push, owner view, locks),
`match-rules` (who wins, rewards, ties, forfeits, start tick), `server-lobby` (join/ready/countdown/live/settle, fairness,
exactly-once rewards, simultaneous matches, disconnects, restart, API), `server-admin` (ADM-1…14: owner-only, rug/crash/pump
with solved targets, restart determinism, halts, cash and coins, idempotent requests, log) and `admin-ui` (ADMUI-1…13: owner screens, no dial, the price formatting, the new owner screens and notices, the Create stock tab, the Launches tab, the Launch tab for players),
`server-owner-tools` (OWN-1…15: ban / unban / timed ban / restart / live-match forfeit / streams, pause all, announcement,
shares, reset, the schema 7 upgrade), `server-breaker` (BRK-1…11: the exact lines, the size bands, the sliding window, the 5-minute pause and fresh start, the owner's moves/halts/pause-all not counting, no pauses while replaying the past, saved pauses, a whale stopped in the real server, Resume, a restart in the middle, the owner's pumps never pausing, a company's own news pausing it, the switch), `server-own-stock` (OSTK-1…14: owner-only, listing and trading, validation, idempotence,
shock / halt / shares on a new stock, several stocks and the saved-but-not-loaded case, the live notice, live add equals save + restart,
engine-level equality with market / sector / partner stories, the schema 8 upgrade, extreme prices, a giant pumped to the top price, the new price ceiling and the order-size guard, no choice of trade strength), `server-flow` (FLOW-1…15: the
model, buy/sell effect against a twin world, sqrt law, order independence, idempotence, no profit from one's own push, exact
`maxQty`, restart in the middle of a push, migration, 1v1 excluded, no dial), `server-leverage` (LEV-1…27: the margin / debt / liquidation maths, buying and selling with debt to the cent, partial sales, refusals and the estimate, the liquidator on a controlled market, 1v1 accounts and the end of a match, the owner taking shares, a real crash wiping a position out, a crash while the server was off, the schema 11 upgrade; LEV-28 in `server-lobby`: the final score of a match with a leveraged position) and `server-shorts` (SHORT-1…18 and EXIT-1…11: the collateral / equity / liquidation-price maths, opening, adding, covering and refused wrong-side orders, the estimate and routes, stop-loss and take-profit on longs and shorts, the liquidator on shorts and exits, a halted company, downtime, 1v1, the owner tools; SHORT-19 in `server-lobby`: the final score of a match with a short), `server-livebook` (BOOK-1…5: the book tilts with other players' orders, the same ladder for fill and display, 1v1 excluded), `server-memecoins` (MEME-1…15: the list, sizes, news, seeding in new and old worlds, restart equality, volatility, the owner's form refuses the coin sector), `server-memefees` (FEE-1…19: the rounding, buy / sell / short / cover / automatic closes to the cent, no fee on liquidations, stocks and 1v1, estimates and "how many can I afford", the refusal text, the schema 13 column, the web API), `server-launch` (LAUNCH-1…35: the size follows the money for coins and stocks, the starting price of a coin follows the money too (80,000 coins each; a price sent along is ignored: LAUNCH-26, 27; a $5,500 coin trades and can be dumped: LAUNCH-28; a launch can start from $2 with fewer coins at the $2.00 minimum price: LAUNCH-29, and a new $1,000 player launches, trades and dumps small companies: LAUNCH-30; a free launch with only the $2.00 fee: LAUNCH-31…34; a stock needs $100 and a $10.00 fee and its starting price follows the money: LAUNCH-6, LAUNCH-35), whole coins at the starting price, the stake is a real part of the order book, limits and refusals, any signed-in player and nobody else, the live preview, cash turned into a holding with no profit or loss, not enough cash, nothing half-made, idempotence, 3 active / 20 ever per kind, the rug pull of a stock or of a coin from before pools (`noPool`) as one ordinary sell order (fee, spread, price push, news once), only the launcher, halts and shorts refuse it, a stock rug pull, an order bigger than the book, a bigger coin is deeper and calmer, the owner's tools on a launched coin, a restart keeps everything, live add equals save + restart, a rug pull never changes replay) and `server-launch-1v1` (LM-1…7: launched companies refused in a match for orders and estimates, Career untouched, the `launched` flag from the moment of launch, owner-made stocks unaffected, no launching in a countdown or live match, bots never look at them, a player who forfeited may launch again), `price-fx` (FX-1…12: the milestone maths, the flash and pulse classes, the seeded confetti, the wiring and the reduced-motion styles), `server-pool` (POOL-1…16: a coin's pool and its first deposit, pool numbers on the market list, the company page and the owner's tab, buys paying in and sales paid out to the cent, a sale cut down to what the pool holds and refused when it holds less than one coin, cash conserved through every step and the rug pull, leverage / shorts / stops / limit orders refused on pool coins and kept on coins without one, the rug pull taking the whole pool without holding any coin, the same request paying once, dead coins worthless and untradable, who may do it and when, the crash and its news surviving a restart with identical prices, a dead coin freeing a place, the old sale rug pull for coins without a pool), `server-owncoin` (COIN-1: schema 14 and the move of the owner's earlier coins into launches; COIN-2: schemas 17 and 18 on an old database), `server-bots` (BOT-1…16: schema 15 and the roster, no sign-in as a bot, bots off in the tests and with `TQ_BOTS=0`, a bot after 10 s alone and the "Play a bot now" button, a real player takes the bot's place, bots never block or fill a lobby, the presence check and leaving, the limit of eight, equal $1,000 accounts and trades only inside the 180 ticks, one settlement with no wallet money for the bot, forfeit, forfeiting against a bot ends the match at once (BOT-15; BOT-16: also with no trades yet, and leaving a countdown is still just leaving), restart, the same match played the same way, all eight styles in a world with memecoins), `server-botreact` (BREACT-1…15: the reader never touches the hidden columns, a story counts from its tick plus the bot's own delay and not before or after, nothing unpublished is ever read, turning the hidden numbers around changes nothing, follow and fade, strength and scope weights, fading with age, reports read from their figures, value against the sector, the crowd, signals adding up, the table of eight styles, a big good story bought by the fast followers and a bad one shorted or bought as a dip, early exits, the same world twice), `server-marketbots` (MKB-1…9: the switches and the config, eight Career accounts of $1,000,000, every style in its own pool and side with no leverage and no stops and price pushes stored, a player's cash and wallet untouched, launched companies left alone (with price history present so it is the rule at work), the same world twice gives the same trades, a bot that holds nothing gets its cash back, a restart keeps the accounts and the bots carry on, a halted market gets no orders and reopening restarts them, a bot with a market account and a match account at once) and `server-margin` (MARGIN-1…23: the exact interest and borrow fee in whole cents, charging every minute and when a position changes, no free lunch from rounding, long and short, coins at 40 %, 1v1 free, restart and downtime, the estimate and its cost line, the margin-call warning once per fall and again after recovery, no warnings while catching up, and the order form's preview carrying the rate and the cost per day), `server-limit` (LIMIT-1…22: the table and an account with nothing set aside, placing and cancelling to the cent, cash set aside and net worth unchanged, shares promised and never promised twice, all four kinds with leverage and exits, fills only at the limit or better, partial fills, orders ending when the position is gone, expiry, the 20-order cap, only the live market, bans, halts, an owner reset, a restart in the middle, the same order id twice, the player told at once and nobody else, nothing hidden in an answer, the form's estimate equal to what the order then uses), `limit-ui` (LUI-1…6: the words of orders and pop-ups, the time left, the store's pop-up, Career only, the form sends requests and shows the server's numbers, the Account screen's list and Cancel), `world-earnings` (EARN-1…13: the consensus is bounded and public, a beat/miss/in-line report matches its headline, trailing profit and P/E stay in range for years, revenue = profit ÷ margin, year on year, the news generator unchanged apart from the earnings stories, every slot of every template is filled and no "third-quarter quarter"), `server-earnings` (EARNSRV-1…9: the history is the published reports with the model's numbers, a report appears at its tick and not before, the next date equals the stored story's, no coins, a legacy story has no numbers, how the price reacted, the calendar both ways, the routes and their refusals, nothing hidden in an answer) and `toasts` (TOAST-1…6: the pop-up texts and the store) and `pens` (PEN-1…15: where a drawing lives in tick and price, saving and reading back, hostile saved data, the eraser, undo limits, the screens use them), `server-social` (SOCIAL-1…23: every route needs a sign-in, the ranking by Career net worth and who is left out (owner, bots, banned), ties, only 100 listed with your own place, the same net worth as My account, the half-minute cache and what ends it, the player list with search and pages, what other players can see, the request / accept / decline / cancel / remove flow and every refusal, the limits and the rate limit, the live notice, a banned friend, the friends-only board, the owner as a friend, a restart, the table's own checks, no money moving between players, 3,000 players) and `players-ui` (PLUI-1…7: the words, the Players tab and its badge, the page only asks and never ranks, a name and a net worth and nothing else, removing asks first), `server-challenge` (CHAL-1…24: every route needs a sign-in, only friends who are online can be challenged, the time left and running out, declining and taking back, one at a time and the limits, ending a friendship, the live notices, a yes opening a 2/2 friend lobby, a challenge back being a yes, nobody else joining it, ready / countdown / live on the same tick, leaving or disappearing cancelling it for both, who is busy and who is taken out of the random lobby, a yes needing the challenger's page to still be open, a played and paid friend match), `server-chat` (CHAT-1…23: every route needs a sign-in and the owner routes the owner, the five-minute wait of a new account, plain one-line text and its limits, the pause / half-minute / repeat limits, pages and the 2,000 kept, banned players hidden, the live push to signed-in pages only, reports and their limit, deleting, muting, banning and lifting with the log and the live notices, the admin view, the upgrade to schema 20 and what its tables refuse) and `challenge-chat-ui` (CCUI-1…14: the words, the store's unread count, order and limits, the note when a challenge ends without a match and when that note goes away, the pages only ask and never turn text into markup), `server-messages` (PM-1…31: every route needs a sign-in and the owner routes the owner, the five-minute wait, friends writing at once and strangers asking first, answering and ignoring a request, becoming friends and unfriending, the request limits, blocking and unblocking and what it ends, groups with invitations, sizes, limits, the creator's tools, leaving and the next creator, plain one-line text and the public chat's pace rules, the newest 1,000 kept, pages, nobody but the members reading, who cannot be written to, reports with their few lines and their limit, dismissing once with the log line, the live push to the members, the upgrade to schema 21 and what its tables refuse, no money and no dice) and `messages-ui` (MSGUI-1…14: the Messages tab and its badge, previews and names, who can be invited, times, live messages for the open conversation and for others, what the store keeps, sending, reloading, a conversation that is gone, earlier messages, text never markup), plus the static rules in `static.test.ts`.
Run everything with `npm test` (the server tests need Node ≥ 22.13).

The screens are not covered by Vitest. They were exercised end to end in a headless browser with two players (sign up,
live prices, company page, trades, news filters, lobby 1/2 → 2/2, ready, countdown, a real 3-minute match, results);
that script is not part of the project.

## 11. Known limits

* News text is built from templates; it is varied but not written by a person or a language model.
* The server must keep running to be "24/7": a home computer that sleeps pauses the live ticks (the market then catches
  up on the next start, exactly as if it had run). Always-on hosting is a deployment decision, not code.
* `node:sqlite` is still marked experimental by Node; the code uses only basic statements.
* Single process, single database file: no horizontal scaling.
* A match is cancelled (nobody paid) if the server restarts while it is running (§9.6).
* The screens have only been tried in one headless browser, not on phones or other browsers.
* Accounts are username + password only; there is no e-mail, password reset or two-factor sign-in.
* Admin price moves hit the requested percent only approximately (§8.5), cannot be undone, and there is one owner, chosen on the
  server computer (no owner-management screen on purpose).
* The first start that includes the owner tools upgrades the database to schema 5, with player price impact to schema 6,
  with bans and resets to schema 7, and with companies made by the owner to schema 8, with a (since retired) trade strength column to schema 9, with automatic trading pauses to schema 10, with leverage to schema 11, with memecoins, shorts and stops to schema 12, with the memecoin fee to schema 13, with launches and rug pulls to schema 14, with 1v1 bots to schema 15, with margin costs and limit orders to schema 16, with free coin launches to schema 17, and with the money pools behind launched coins to schema 18; an older program refuses to open any of them.
* A company made by the owner cannot be deleted (only halted), needs the 66 base companies (`TQ_COMPANIES` ≥ 66), and starts
  trading 30–40 seconds after it is made.
* A ban is tied to the account name: a banned person can create another account (there is no IP or device ban on purpose; a
  home server cannot tell people apart reliably). A reset keeps the old trades in the database (they only stop showing).
* Shorts, stops and the live book (§6.2–6.4): no partial liquidation; a stop is a market order, so in a thin book it fills worse than its price; stops do not fire on prices from the past (after downtime they fire when the market has caught up); other players' Career orders change everybody's book sizes; the pop-ups were only tried in one headless browser.
* Market bots (§9.11): they read the same news, reports and book tilt as a player, but only by simple rules (no memory of how a story turned out, no reading of the story's text, only its shown tone and strength; viral rumours are followed too, and those from poor sources often reverse); only the market bots react, the 1v1 bots trade on the chart as before; the reasons are kept in memory only; they are not part of the world's rules, so they are not in the price model's tests (the price they cause is an ordinary stored push); a player could try to guess a bot's next move from the order book's tilt, which is allowed and costs him the spread; they push only thin companies and memecoins visibly, and not at all companies a player launched; a bot's plans live in memory, so a restart closes what it finds open after a fresh holding time.
* Memecoin fee (§6.6): one flat rate for every coin and every order size (no discount for big traders, no higher rate for thin coins); the fee is not paid to anyone, it just leaves the game; a 1v1 match has none, so a coin order in a match (the API allows it, the screens do not offer it) is free.
* Memecoins (§12): invented coins with invented numbers; they list about 10 minutes after the first start of an existing world; they have no automatic pauses; the $1.00 floor means a coin cannot go lower.
* Earnings (§7.5): every company reports every 3 days and shares one sector P/E and margin (no company-specific growth, no buybacks, dividends or guidance); the numbers follow the news story rather than cause the price move; a story from before this feature shows no figures.
* Limit orders (§6.8): Career only; a limit order is not an entry in the order book that other players can trade against (the book everybody sees does not change); it is sent to the market when the price touches it, checked once a second, so a price that only touches the limit between two ticks is not seen; no "one cancels the other", trailing, all-or-nothing or stop-limit orders; cash set aside is not available for anything else until the order ends; the number of shares it fills is limited by the book at that moment (the rest keeps waiting); only tried in one headless browser.
* Leverage (§6.1, §6.7): the interest and the borrow fee are flat rates (they do not follow a market rate, and a short's fee does not rise when many people short a company); no maintenance margin and no partial liquidation (a position is either open or wiped out); the margin-call pop-up only warns; a leveraged player can
  push a thin stock hard with little cash; 1v1 rewards grow with profit, so a lucky 50× match pays a lot of virtual currency; the screens'
  slider and the liquidation price were only tried in one headless browser. Pens are a browser-side aid only: they are not saved on the
  server, so they do not follow a player to another browser.
* Player price impact (§8.6): one stored row per trade that moves a price (fine for a home server, not for thousands of players); several
  accounts of one person can push together, as several people can (the 25 % and 3-book caps bound one order's push; FLOW-10
  tests cashing out for one account only, and has not been tried with several accounts); an account that already holds shares sees a paper
  gain on them when anybody pushes the price up (net worth is valued at the bid), but cashing it in means selling, which pays
  the markup and pushes the price back down; the pressure is per company, so a bought-up thin company stays pushed for
  a few half-lives until it fades; only Career trades count, 1v1 matches never move prices.

## 12. Memecoins (`src/world/memecoins.ts`, `memeNews.ts`, `server/world/runtime.ts`, schema 12, tests `server-memecoins`)

Thirty invented coins in a new sector `'meme'`, shown in their own **Memecoins** tab. They are ordinary companies for the engine (a
ticker, a price, a market cap = price × supply, a book, candles, news), with the same Career cash and the same trading code, so leverage, shorts,
stop-loss, take-profit, the live book and the pop-ups work on them without special cases. The one difference in the rules: coin orders pay a trading fee (§6.6).

* **Sector and ids.** `'meme'` is appended **last** in `SECTORS`, so every older sector keeps its number. `STOCK_SECTOR_IDS` (all but `meme`) is
  what the company generator and the owner's "make a company" form use, so neither can ever produce or accept a coin.
* **The list.** `MEME_SEEDS`: four sizes, `blue` (3 big, liquid coins), `mid`, `small`, `micro` (tiny, thin, wild). Each coin states its own
  `MemeProfile`: supply, float, turnover, liquidity, `vol3m` (typical 3-minute move: 7 % to 45 %, a stock's is under 1 %), daily volatility,
  `newsImpact` (a stock's is 0.5 to 1.9, a coin's 2.5 to 7), drift. Prices run from $3.60 to $118.50.
* **Saved whole.** The coins are added to a world **once** (`meta` key `memecoins_seeded`), take the ids after the last company that exists, and
  their numbers are saved with them in `meme_companies` (migration 12). Editing the file never changes a coin that exists; the engine version stays 4.
  A brand-new world has them from the first tick; an existing world lists them about 10 minutes after the first start (like a company made by the owner).
  If an existing company already uses a coin's name or ticker the start is refused with a sentence naming it (MEME-13). `TQ_MEMECOINS=0` keeps them out of a world that does not have them yet.
* **Why they move more.** The price model (§5) is the same; the coin's own `vol3m`, `dailyVol`, `newsImpact` and `driftDay` replace the size-class
  numbers, and thin coins also take more from players' orders (§8.6), so a position can win or lose a lot in seconds. The $1.00 floor still holds: a coin that "rugs" sits at it.
* **News.** Own templates (`memeNews.ts`: company, sector, viral and listing stories: rug rumours, whale buys and dumps, influencer threads, exchange listings,
  dev-wallet moves). Every coin gets at least three stories a day, never earnings; sector stories reach the coin sector; a coin's story moves it more than a
  stock's story moves a stock (MEME-8). A world without coins gets exactly the sector and economy news it always had.
* **No automatic pauses.** The circuit breaker (§8.5) skips the coin sector: coins can move any distance, so a stop on a coin is never locked out.
  The owner's own tools (halt, pause all) still work on them.

### 12.1 Launches and rug pulls (`server/launch.ts`, `server/customCoin.ts`, `server/customStock.ts`, `recordOwnCoin`, `recordOwnCompany`, schemas 14, 17 and 18, tests `server-launch`, `server-owncoin`, `server-pool`)

Any signed-in player can launch a **memecoin** or a **stock** of his own from the **Launch** tab and later **rug pull** it. There is **no size menu**: the SIZE comes from the money he puts in, and nobody types a starting price: the money sets it. For a **coin** the least he can put in is **$2.00** (`MIN_SEED_CENTS`, the optional first buy, see below) and for a **stock** it is **$100.00** (`MIN_STOCK_SEED_CENTS`); the most is $10,000,000 for both. Buying has to give at least one whole coin or share, and the cheapest a coin or stock starts is $2.00. The starting price of a coin is described under *Money → numbers (coins)*, that of a stock under *Stocks*.
**Making a coin is almost free, like pump.fun (schema 17).** A coin costs only the **launch fee**, `LAUNCH_FEE_CENTS` = **$2.00**, paid from the Career cash and gone (it buys nothing, is never refunded and is kept on the launch row as `fee_cents`). The money put in becomes an **optional first buy**: **$0**, or from $2.00 to $10,000,000. With **$0 the player holds none of the coin** (no position, `stake_shares = 0`): the coin is made with the smallest size (the same numbers as a $2.00 first buy: 32 coins at $2.00) and the player buys it on the market once it lists, like anybody, paying the gap and the 0.5 % fee (LAUNCH-31, LAUNCH-32). Between $0 and $2.00 is refused (it could not buy a coin). The cash must cover the fee and the first buy together (`not_enough_cash`, LAUNCH-33). **A stock has no free launch**: it needs at least **$100.00** put in (`MIN_STOCK_SEED_CENTS`) and costs its own launch fee, `STOCK_LAUNCH_FEE_CENTS` = **$10.00**, paid from the Career cash and gone, kept on the launch row as `fee_cents` like the coin's (LAUNCH-6, LAUNCH-33, LAUNCH-35). No migration was needed: `launches.fee_cents` and the relaxed checks of schema 17 already cover it.
(This replaces the earlier owner-only "Create coin" tab, which was the same coin maker without limits and without a rug pull; coins the owner made with it become his launches in migration 14.)

* **Money → numbers (coins).** `ANCHORS` in `customCoin.ts` is a table of six rows ($5,000, $25,000, $100,000, $500,000, $2M, $10M; below $5,000 the numbers are those of the first row), each with market cap, liquidity, `vol3m`, float, turnover, daily volatility, `newsImpact` and drift
  (for example $5,000: cap $160k, liquidity 0.10, `vol3m` 0.45; $10M: cap $440M, liquidity 0.68, `vol3m` 0.11). Between rows every number slides on a log scale of the money. The size class follows the market cap (blue ≥ $100M, mid ≥ $10M, small ≥ $1M, else micro).
  More money: bigger cap, deeper book, narrower spread, calmer (LAUNCH-1, LAUNCH-21). **The starting price comes from the money too.** Like a fixed-supply token launch, every launched coin has the same number of coins, `COIN_SUPPLY` = **80,000**, so the price is the cap divided by that, to the nearest cent (`priceFor`): **$5,000 → $2.00**, $25,000 → about $10, $100,000 → about $40, $500,000 → about $212, $2M → about $950, **$10M → $5,500.00**. More money never starts lower (LAUNCH-26). The old price box, `priceCents` in the request, the highest-price rule and the 10,000-coin minimum are gone; a `priceCents` sent by an older page is ignored (LAUNCH-27).
  **Small launches.** The cheapest a coin starts is `MIN_COIN_PRICE_CENTS` = **$2.00** (so it has room to fall to the $1.00 floor). Below $5,000 the cap divided by 80,000 would be under $2.00, so the price stays at $2.00 and the coin has **fewer coins** instead (`supplyFor`: cap ÷ $2.00, at least 1): $2 → 32 coins, $100 → 1,600 coins (a stake of 50), $1,000 → 16,000, and 80,000 exactly from $5,000 up. Below $5,000 the cap is a straight line down from the $5,000 row (32 × the money), with the same thin, wild character as the $5,000 coin. The price is still never lower for more money, and the number of coins never shrinks as the money grows (LAUNCH-29).
  The dollar size of everything is as before (cap, daily volume, the stake as a share of the book), because the daily volume in coins is `supply × turnover` and the price is `cap ÷ supply`; only the split into coins and price changed. So a big coin has few, dear coins: a player with $1,000 cannot buy a whole $5,500 coin (coins are whole). The launched coin is saved with its own `supply` like before, so coins launched earlier keep the price and supply they have.
* **Why a small launch is different.** The launch stake is about 3 % of the supply and about **a third of the calm order book** (`bookDepth` ≈ 86.5 × touch shares, touch = ⌊adv × (0.0004 + 0.0026 × liquidity)⌋ with `memeAdv` as the coin's daily volume, §8.6), so one order can sell all of it (LAUNCH-3). The form (`CoinPreview.dump*`, computed by `dumpOf` with the real order rules, the 0.5 % fee and `pushPreview` from `flow.ts`)
  says what the sale would bring back (about 80 % at $5,000 and up), how far the price would be pushed down (about 10 %) and how far the price must rise first for the sale to return the money (about 23 %). With less money the stake is a smaller part of the book (`memeAdv` has a floor of 10,000 coins a day), so a small launch's sale costs mostly the buy–sell gap and the fee: $100 → about 13 %, $2 → about 3 %. A tiny company is thin and wild, and anything a player does to it moves it a lot, but there is little money in it.
* **Stocks.** The money picks the size class (`tierOfSeed`: micro < $50k, small < $250k, mid < $1M, large < $5M, mega ≥ $5M; a stock needs at least $100.00) **and the starting price** (`stockPriceFor`, a table of eight rows: money in dollars → price in dollars: 100 → 5, 1,000 → 12, 10,000 → 30, 50,000 → 60, 250,000 → 120, 1,000,000 → 250, 5,000,000 → 500, 10,000,000 → 700; between two rows the price follows a straight line on a log–log scale and is rounded to a whole cent, so for example $5,000 → $22.77). More money never starts lower and every price is inside the owner's $2.00–$1,000.00 range (LAUNCH-35). The player buys `⌊money ÷ price⌋` whole shares (at least 20, since the least money buys 20 shares at $5.00); what is left over stays in his cash. A `priceCents` sent by an older page is ignored (LAUNCH-6, LAUNCH-11). The personality is fixed to *volatile*; the owner's own *Create stock* form (sector, size, personality, **typed price**) is unchanged. A stock's launch stake is a small part of its book, so a stock rug pull costs only a few percent and hardly moves the price (LAUNCH-19).
* **The money.** It comes out of the player's own **Career cash** (refused with a sentence if it is not enough: `not_enough_cash`, nothing is made; new players have $1,000). The first buy buys whole shares at the starting price, `⌊money ÷ price⌋`, as an ordinary long position with cost = what was paid. So the first buy is **cash turned into shares**: no trade row, no fee, neither profit nor loss. Only the **launch fee** is a cost ($2.00 for a coin, $10.00 for a stock): the account's profit is −$2.00 right after a coin launch and −$10.00 after a stock launch, and the launch's "Result so far" (`LaunchView.profitCents`) includes it
  (LAUNCH-9, LAUNCH-11). For a **stock** it is **not a real pool behind the price**; a coin launched since schema 18 does have one (§12.2). Until the company lists (30 to 40 s) the holding is valued at the starting price. The `launches` row records what was put in and bought.
* **Limits.** A player holds at most **3 launched coins and 3 launched stocks** at a time (`too_many_active`; selling out of one frees a place, and so does the rug pull of a coin, which kills it; a free coin he holds none of does not use a place, the fee is what stops spam, LAUNCH-34, POOL-15) and launches at most 20 of each kind ever (`too_many`); at most 300 launched coins and 400 hand-made companies in all (`MAX_OWN_COMPANIES`). Names and tickers must be new, also not one of the 30 built-in coins (LAUNCH-12, LAUNCH-14).
* **Saved like any company.** The whole entry (with its own numbers) is written to `meme_companies` / `custom_companies` and `companies` in the same transaction as the cash, the position and the `launches` row; then `loadOwnCompany` adds it to the running market exactly as a restart would
  (LAUNCH-24: identical prices, candles and news for hours). The same request id twice = one launch (LAUNCH-13). Migration **14** adds `launches` (company, user, kind, request id, money, shares, price) and `launch_rugs` (trade, company, shares, cash received) and backfills the owner's earlier coins from the admin log. Migration **17** rebuilds `launches` so that money, spent and shares may be 0 (a free launch) and adds `fee_cents` (0 for every earlier launch); SQLite cannot change a CHECK, so the table is copied aside, dropped and made again with the foreign key check of `launch_rugs` deferred to the end of the transaction (COIN-2 runs it on a v16 database with launches and rug pulls: nothing changes, `foreign_key_check` is clean).
* **Rug pull.** `POST /api/launch/rug {requestId, ticker}`. For a **coin with a money pool** it takes the pool (§12.2, answer `kind: 'drain'`). For a **stock** and for a **coin launched before schema 18** (it has no pool row) it is **not a special mechanism** (answer `kind: 'sale'`): it is the normal `Trading.placeOrder` sell of the player's *whole* long position in his own launch (`clientOrderId = rug-<requestId>`), so the spread, the order book depth, the player-flow push of §8.6 and the 0.5 % coin fee all apply as for any sale.
  Only the player who launched it may do it (the owner has no special right to anybody's; `not_yours`), only a long position (`nothing_to_dump`), not while the company is halted or all trading is paused. If the order book cannot take it all, the part that fits is sold and the rest stays his (`partial`, LAUNCH-20); pressing again later sells more.
  The same request id sells once (the trade row is unique per account and client id, `launch_rugs.trade_id` is its primary key; LAUNCH-17). After the sale an informational **news story** (key `rug:<company>:<trade>`, negative, "The developer of X dumps N coins" / "The founder of X dumps N shares") is published through the news service with no price effect of its own, so a rug pull and its story change nothing about how a restart replays the world (LAUNCH-25).
  The only price effect is the market's own reaction to a large sell.
* **What a player sees and the owner sees.** Players see the developer name (coins) or the founder (stocks); the owner's *Launches* tab lists username, money in, shares held now, rug pulls and status (read only; halting is done on the Market tab and blocks rug pulls, LAUNCH-18).
* **Routes** (all need a signed-in player; 40 requests per 10 seconds each). `GET /api/launch` (forms, limits, counts and the player's launches with holdings, worth and result), `GET /api/launch/coin-preview?seedCents=` (`seedCents=0` is a free launch; the preview carries the starting price, the fee and the total; a `priceCents` is ignored) and `/stock-preview?seedCents=` (the same: starting price, shares, fee and total; a `priceCents` is ignored; an impossible amount answers 200 with `{ok:false, problem}`),
  `POST /api/launch/coin`, `/api/launch/stock`, `/api/launch/rug`. The owner's `/api/admin/coin` and `/api/admin/coin-preview` are gone (404).
* **Honest limits.** A stock or old-coin rug pull costs about 15 to 20 % of the stake (a coin) or a few percent (a stock), so it pays only after the price rose by more than that; a pool coin's rug pull pays whatever other players put into the pool (§12.2); a new account starts with $1,000, so it can launch a coin straight away (the $2.00 fee and a first buy of up to about $998, or a small stock of up to about $990 with its $10.00 fee; a bigger one needs more cash first); a launch cannot be undone and a company never leaves the market; names are not moderated; friends cooperating can pump a coin but the dump cost still falls on the seller; creators of stocks are not distinguished from other holders except by the rug pull button.

### 12.2 The money pool behind a launched coin (`server/pools.ts`, `server/trading.ts`, `server/launch.ts`, schema 18, tests `server-pool`)

A memecoin launched since schema 18 has a **pool of real cash**, like a coin on pump.fun. Everything below is about coins only: stocks, the owner's coins and every coin launched before schema 18 have **no pool row** and work exactly as before.

* **The table.** `coin_pools(company_id, pool_cents, in_cents, out_cents, drained_cents, drained_ms, drain_request_id)`. The database itself checks `pool_cents = in_cents − out_cents − drained_cents` and that the pool never goes below 0. A coin's pool is made in the same transaction as the launch; its first deposit is the launching player's first buy (0 for a free launch; the launch fee is not in it, POOL-1).
* **Money in.** A Career buy of the coin puts everything the shares cost (`totalCents`, with the price push the buyer pays) into the pool; the 0.5 % fee is not in it and is gone (POOL-3).
* **Money out.** A sale is **paid from the pool**: the pool loses what the shares sold for, the seller gets that minus the fee (POOL-4). A sale whose proceeds are more than the pool holds is **cut down** to the most shares the pool can pay for, like a thin order book (`Trading.capToPool`, a binary search over the same priced fill; `OrderResult.trade.poolLimited`, `Estimate.poolLimited` and `Estimate.poolCents`; `maxQty` is that most). What the pool could not pay for stays the player's (POOL-5). With less in the pool than one coin is worth nothing can be sold: `no_liquidity` with the amount that is left (POOL-6). So **a pool coin's paper profit is only as good as the cash in its pool**: if the price has risen, the early sellers are paid with the later buyers' money.
* **Cash is conserved.** Every account, every pool and every fee ever paid add up to the same number after every trade and after the rug pull (POOL-7). Nothing is created: a buyer's loss stays in the pool and the developer can take it.
* **The price still comes from the market engine.** The pool is the cash behind the price, **not** the price. It is not an automated market maker: buying and selling push the price as in §8.6, and the engine's own news and random moves still move it. (That is why a pool can be too small for a sale after the price has risen.)
* **Plain buying and selling only.** A pool coin refuses leverage, short selling, stop-loss, take-profit, exits on a held position and limit orders with `not_allowed` and one sentence (POOL-8), because each of them would let a player borrow, or be paid later, against cash that its developer can take. A coin without a pool keeps all of them (POOL-9).
* **The rug pull takes the pool** (`Launches.drainPool`). In one transaction the **whole pool becomes the developer's Career cash** (`coin_pools.drained_cents`, `drained_ms`; the request id is stored, so the same request pays once and answers the same: POOL-11). He **does not have to hold any of the coin** (POOL-12). Refused: not his coin (`not_yours`), not trading yet or halted or all trading paused (the order errors), nothing in the pool (`pool_empty`), already taken (`already_pulled`) (POOL-13). The answer is `{kind: 'drain', takenCents, paidInCents, otherHolders, otherCoins, ownCoins}`.
* **After it the coin is dead.** Every order and estimate for it is refused for everybody with `not_allowed` ("took all the money out of its pool (a rug pull)"); shares of it stay in the accounts but are **valued at 0** (`PositionView.dead`, net worth counts them as 0, the Account screen tags them "rug pulled", POOL-10). One breaking news story (key `rug:<company>:drain`, "X is a rug pull: its developer drained the pool", names the amount, never the player) is published with a **−99 % instant price move** (the owner's *instant* pace: `realized` from `solveTotal(0.01, 'burst', 6)`, `permShare` 1), so the chart really crashes and stops at the $1.00 floor; the move is a stored news row like the owner's, so a restart replays the same prices (POOL-14). The developer's result for the coin is `drained − what he put in − the fee` (`LaunchView.profitCents`, POOL-12). A dead coin no longer uses one of his three places (POOL-15).
* **Where it shows.** `OverviewRow.pool = {cents, dead}` (null for companies without one) on the market list and the company page; the company page shows a warning with the amount, the trade panel hides leverage, short, stops and limit orders and says the same; `LaunchView.pool` and the Launch tab card show the pool and the confirm text of the rug pull ("Take $X, everything in the pool… the coin dies"); the owner's *Launches* tab has a *Pool* column. Old coins (no pool row) keep the old sale rug pull and the old sentences (LAUNCH-16…20 and others run on them with `noPool`).
* **Honest limits.** The price is not made by the pool, so a pool can be empty while the price is high, and a coin can crash without a rug pull; a developer who buys his own coin gets that cash back in the rug pull (minus the fees), so only **other players' money** is a gain; positions in a living pool coin are still valued at the bid, even though only the pool can be paid out; the pool of a coin from before schema 18 does not exist and cannot be added. Going back to an older program after schema 18 is refused ("database is from a newer TradeQuest").


### 12.3 Price animations (`src/ui/hype.ts`, `src/ui/usePulse.ts`, `src/ui/LiveChart.tsx`, `src/shared/PriceFx.tsx`, `src/styles.css`, tests `price-fx`)

The screens give a price some life, like pump.fun, **and that is all they do**: every number comes from the live price the page already has. No animation places an order, changes a price or writes to the database (FX-11 checks that these files never call the order or launch API).

* **Every tick.** `usePulse(value)` watches a price and gives `{dir, n}`: which way the last move went and a counter. A CSS animation plays again on every tick because the class flips between `-a` and `-b` (same animation, different name; `pulseClass`). The first value, a price of 0 (not listed yet) and another company do not pulse.
* **Lists.** In the market and Memecoins lists the price (`FlashPrice`) flashes green when it ticks up and red when it ticks down.
* **The company page.** The big price (`CompanyPrice`) **rolls** to its new value over 0.45 s, pops and glows green or red. The chart (`LiveChart`): the forming candle glows, a **live dot** at its tip sends out a ring (an idle ring all the time, a bright ring on every move, a bigger and brighter one for a move of 1 % or more), the price tag flashes, and a **"+0.8%" floats up** for a move of 0.25 % or more (`moveLabel`).
* **Milestones.** `GET /api/market/:ticker` now also carries `basePriceCents`, the price the company started at (for a launched company its listing price). The page divides the live price by it (`multipleOf`). From **2x** the page shows a badge "🚀 5.3x since the start" (`HypeBadge`). When a **rise crosses 2x, 5x, 10x, 25x, 50x or 100x while you are watching**, a celebration plays (`MilestoneBurst`, drawn into `<body>` so shaking the page does not move it, and it never blocks a click): a big banner with the multiple, a rocket or moon, and confetti that flies out and falls (2x: a small burst, 5x: a big one, 10x and up: 96 to 140 pieces, a green flash at the edges and a short shake of the page; 2.6 to 5.4 s). Rules (FX-4): a jump that passes several milestones plays the biggest; a smaller one never interrupts a bigger one that is still playing; a milestone is celebrated **once per browser tab** (`CELEBRATED`), so a price wobbling around 10x does not fire again and again; opening a page where the coin already stands at 10x plays nothing, only the badge shows; a fall never plays anything. The confetti of one celebration is always the same (`piecesFor`, a seeded generator), so a test can check it.
* **Reduced motion.** With "reduce motion" switched on in the system there are no flashes, rolls, rings, floating labels, confetti or shaking (FX-12); the badge stays and a celebration shows only its banner, without moving.
* **Not animated (yet).** The candles of the 1v1 practice screens only get the chart pulses (they share `LiveChart`); the Account and Launch screens have no flashes.

## 13. Friends and the leaderboard (`server/social.ts`, `server/routes/social.ts`, `src/shared/PlayersScreen.tsx`, schema 19, tests `server-social`, `players-ui`)

Players can find each other, become friends, and compete for a place among the richest. **Nothing moves between players**: no cash, no shares. Trading "together" means the one shared market, which every player's orders already push (§8.6).

* **What is visible.** To another player: a name, a Career net worth and a place. Never cash, holdings, trades or orders (SOCIAL-9 lists the exact keys of every answer; PLUI-6 checks the page). Every route needs a signed-in player (SOCIAL-1).
* **Net worth** is `Trading.view(careerAccount).netWorthCents`, the number *My account* shows: cash plus longs at the bid, shorts at the ask, minus debt, plus cash set aside in open limit orders. It is the same code, so the board and the account page cannot disagree (SOCIAL-5). A 1v1 match account is not counted.
* **Who is ranked.** Real players only. Left out: the owner (`role = 'owner'`), the computer players (the `bots` table, and the hash `bot` they carry) and anybody banned right now. The owner is on the player list (so he can have friends) but with no net worth and no place; he sees his own screen say so (SOCIAL-2, 7, 19). A banned friend is hidden while the ban lasts and comes back with it (SOCIAL-17).
* **Order.** Richest first; equal money: the older account, then the lower id, so the order never flickers (SOCIAL-3). Places are 1, 2, 3… with no shared places.
* **The board** shows the best `BOARD_SIZE` = 100 and always says where *you* stand, also outside the top: `me: {rank, netWorthCents, inTop}` (SOCIAL-4). `?scope=friends` ranks only you and your accepted friends, with places counted inside that group.
* **Cost.** The ranking for all players is worked out once and reused for `BOARD_CACHE_MS` = 30 s, so a busy page costs one pass over the players every half minute. The cache also notices at once when a player is added or a ban starts or ends (a signature of the user and ban tables), so a new player is findable immediately and a banned one disappears immediately (SOCIAL-6). 3,000 players are ranked in a fraction of a second (SOCIAL-23); the owner's cash gifts and resets show on the board within 30 s.
* **Friends** (table `friendships`, one row per pair, smaller user id first so a pair is never stored twice; `status` pending or accepted; `requester_id`; the table's own CHECKs refuse a pair the wrong way round, with a stranger as requester or accepted without a time: SOCIAL-21). A request is a pending row; the other player's *accept* makes it accepted; *decline*, *cancel* and *remove* delete the row. Asking somebody who already asked you is an accept; asking twice or asking a friend changes nothing (SOCIAL-10, 11, 13). Names are matched ignoring case and a leading `@`; you cannot ask yourself, a stranger, a computer player or a banned player (SOCIAL-12).
* **Abuse limits.** 100 friends (`MAX_FRIENDS`), 30 requests waiting that you sent (`MAX_OUTGOING`), 100 waiting for one player (`MAX_INCOMING`): a full player can neither ask nor say yes and nobody can ask him (SOCIAL-14); 20 changes per 10 s per player, then 429 (SOCIAL-15). A *decline* is not announced; the request simply disappears from the other list the next time it refreshes.
* **Live.** The other player's page is told over the live stream (event `friends`) when a request arrives, is accepted, is taken back or a friend is removed (SOCIAL-16); the page also refreshes the lists every 30 s as a safety net.
* **Routes.** `GET /api/players?q=&limit=&offset=` (page of at most 100, default 50), `GET /api/leaderboard?scope=all|friends`, `GET /api/friends`, `POST /api/friends/request|accept|decline|cancel|remove` with `{username}`; every POST answers with `{relation, friends, incoming, outgoing, limits}` so the page is current without another request.
* **The page.** A Career tab "Players" (the header menu stays Career, 1v1, News) with Leaderboard, Friends and Find players; the number of requests waiting is a red badge on the tab. The page never ranks, sorts or filters players itself (PLUI-5).
* **Honest limits.** The board ranks *net worth*, not skill or profit: a gift from the owner counts, and so does a launched coin's price. Nobody can be stopped from making several accounts to build a stronger-looking board of friends (sign-ups are limited to 10 an hour per address). There is no *block* button: a declined player can ask again (the limits above cap how much). Going back to a program older than schema 19 is refused ("database is from a newer TradeQuest").

## 14. Friend 1v1 challenges (`server/challenges.ts`, `MatchService.openFriendMatch`, `src/shared/Challenges.tsx`, schema 20, tests `server-challenge`, `challenge-chat-ui`)

Friends who want to play each other should not have to hope that the random matchmaking (§9) puts them together. A **challenge** is one row `challenges(from_id, to_id, created_ms, expires_ms)`; a yes turns it into a **friend match**: a normal match (§9) with `matches.friends = 1`, whose lobby holds exactly the two friends from the start.

* **Who.** Only accepted friends (CHAL-2); not yourself, a computer player or a banned player (CHAL-2, 3). The challenged friend must have a live stream open (`SseHub.has`), else 409 `offline` with his name in the message (CHAL-4). Nothing is shown about who is online until somebody tries.
* **How long.** `CHALLENGE_MS` = 120 s from the server's clock. Expired rows, and rows between two players who stopped being friends, are deleted by the next read (`purge`); a late yes is a 404 (CHAL-6, 10). The page counts down from the server's `msLeft` using the market tick stream (CCUI-1, 9).
* **Limits.** One challenge out at a time per player (`already_challenging`), at most `MAX_WAITING_FOR_ONE` = 10 waiting for one player, at most `SENDS_PER_MINUTE` = 10 sent per minute, and the usual 20 requests per 10 s on the route (CHAL-8, 9). Asking twice changes nothing and does not extend the deadline (CHAL-5).
* **Answers.** `accept`, `decline` (the challenger just sees it disappear, with the neutral line "… did not accept your challenge."), `cancel`. A challenge in the other direction is a yes: challenging a friend who challenged you accepts it (CHAL-7, 13).
* **Opening the match.** `Challenges.accept` runs in one transaction: re-checks the challenge, that the challenger still has a page open (CHAL-24), and that both are free (`MatchService.isFree`: in no match, or only waiting alone in a random lobby, which is then left; busy = a lobby with another real player, a countdown, a live match, or another friend lobby), drops the challenges either player still had out (those friends are told), then `openFriendMatch` creates the lobby and notifies both through the normal match events (CHAL-12, 19, 20, 21). Both pages open the 1v1 screen by themselves once.
* **A closed lobby.** The random matchmaking only joins lobbies with `friends = 0` and one real player, so a stranger never lands in a friend match (CHAL-14). If either friend leaves or stops answering for `PRESENCE_MS` (15 s) before the start, the match is **cancelled for both** (`cancel_reason = 'friend_left'`), the one who stayed sees why, nobody is penalised and nobody waits for a stranger (CHAL-16, 17, 18). A forfeit after the start is the usual forfeit.
* **The rest is §9.** Ready check, countdown, 180 ticks, scoring, rewards (paid once; the wallet is a score, nothing can be bought with it), history and the launched-company rule are unchanged (CHAL-15, 23).
* **Routes.** `GET /api/challenges`; `POST /api/challenges/send|accept|decline|cancel` with `{username}`; every answer is `{incoming, outgoing, limits, match}` where `match` is the new lobby after a yes. The friend's page is told over the live stream (event `challenges`) when one arrives, is taken back, declined or accepted (CHAL-11).
* **Honest limits.** Friends can still farm the $50 consolation reward by challenging each other over and over (as anybody can against a bot); the wallet buys nothing. There is no "online" dot: whether a friend is on TradeQuest is only learned by trying.

## 15. The chat room (`server/chat.ts`, `server/routes/chat.ts`, `src/shared/ChatScreen.tsx`, `AdminChat.tsx`, schema 20, tests `server-chat`, `challenge-chat-ui`)

One public room for every signed-in player. Messages live in `chat_messages` (`deleted_ms`/`deleted_by` hide a removed one), restrictions in `chat_restrictions` (one row per player: a `mute` until a time, or a `ban` with no end), reports in `chat_reports` (one per player and message).

* **Signed in only.** Reading, writing and reporting need a session; the live events go only to signed-in streams (`SseHub.publishSignedIn`: CHAT-1, 13).
* **A message** is cleaned by the server: control characters, direction overrides and zero-width characters (not the joiners emoji need) become spaces, whitespace collapses to single spaces, then 1 to `CHAT_MAX_LENGTH` = 300 characters (counted as code points); anything else is a 400 (CHAT-4, 5, 6). It is stored and shown as plain text: the page renders `{message.text}` and never builds markup or links (CCUI-11).
* **Slowing spam.** At least `MIN_GAP_MS` = 1.5 s between a player's messages, at most `CHAT_BURST` = 8 in `CHAT_BURST_MS` = 30 s, the same text (any letter case) refused for `REPEAT_MS` = 60 s, and 12 chat requests per 10 s on the route. These are counted from the stored messages and the injected clock, so they survive a restart (CHAT-7, 8, 9).
* **New accounts.** `NEW_ACCOUNT_WAIT_MS` = 5 min after the account was made, writing is refused (403 `too_new`); reading is open. The owner is exempt (CHAT-2). The page counts the wait down on the server's market clock and asks again when it is over.
* **What is shown.** The newest `CHAT_PAGE` = 50 (at most 100 per request) oldest first, `before=` for older ones, `more` says whether older exist. A message by a player the owner banned from the game is left out while the ban lasts (CHAT-10, 12). Only the newest `CHAT_KEEP` = 2,000 messages are kept (CHAT-11). Each message shows a name, the Owner mark, the text and the time; nothing else about the writer (CHAT-3).
* **Reports.** Another player's message (not your own, not the owner's, not a removed one) can be reported once per player; 20 reports an hour per player (CHAT-14, 15). The owner's Admin → Chat tab lists the open reports, newest first, with how many players reported each.
* **The owner's tools** (owner-only routes; the role is checked on the server every time: CHAT-1): `delete` a message (hidden for everybody, open pages told with `chat_removed`, its reports closed), `dismiss` its reports, `mute` a player for 1 minute to 30 days, `ban` him from the chat, `lift` either. A mute cannot replace a ban; a ban can replace a mute; the owner cannot be muted or banned (CHAT-16 to 21). Each takes a `requestId`, is written once to the admin log (`chat_delete`, `chat_mute`, `chat_ban`, `chat_lift`, `chat_dismiss`), and a repeated request does nothing again; a refused `lift` leaves no log line (CHAT-16, 19). The affected player is told at once (`chat_status`) and sees the reason on the screen; muting or banning never touches playing, trading or reading (CHAT-17, 19).
* **Storage.** Schema 20 adds `chat_messages`, `chat_restrictions`, `chat_reports` and `challenges` and a `friends` flag on `matches` (0 for every older match); the tables refuse an empty or over-long message, a mute without an end or a ban with one, a second report of one message by one player, a challenge to yourself or one that does not last, and a player who is deleted takes his rows with him (CHAT-23). A program older than schema 20 refuses a database saved with it.
* **Routes.** `GET /api/chat?before=&limit=`, `POST /api/chat/send` `{text}` (answers `{message, you}`), `POST /api/chat/report` `{messageId}`; owner: `GET /api/admin/chat`, `POST /api/admin/chat/delete|dismiss|mute|ban|lift`.
* **The page.** A Career tab "Chat" with a red badge for messages that arrived while it was closed (CCUI-3, 13). The page keeps at most 150 messages in memory (CCUI-4).
* **Honest limits.** There is no word filter and no block button; one room only (private groups are not built); a message can be seen by anybody signed in before the owner reacts; the room is a single broadcast, which is fine for a few hundred players at once, not for tens of thousands.

## 16. Private chats (`server/messages.ts`, `server/routes/messages.ts`, `src/shared/MessagesScreen.tsx`, `PmThreadView.tsx`, `messagesUtil.ts`, schema 21, tests `server-messages`, `messages-ui`)

Private one-to-one conversations and small private groups. Tables (schema 21): `conversations` (`kind` direct/group, `title`, `created_by`, for a direct one `direct_a` < `direct_b`, unique per pair, `request` NULL/pending/accepted/declined with `requester_id` and `request_ms`), `conversation_members` (`state` member/invited, `invited_by`, `joined_ms`, `since_id` = the newest message when the player joined, `read_id`), `private_messages` (`body`), `blocks` (blocker, blocked) and `private_reports` (the reported message and up to `REPORT_CONTEXT` lines before it are copied into `context_json`, so a report survives the conversation).

* **Members only.** `view`, `thread`, `send`, `read` and the rest check that the caller is a member (invited players see only the invitation). Nothing about a private chat is reachable by the owner except a report; there is no owner read, mute or ban route (PM-4, 26). Live events (`publishTo`) go to the members only, and not to a member who blocked the author (PM-29).
* **Direct conversations.** One per pair. Friends write at once. A non-friend's first message makes the conversation a `pending` request (one message only; limits `REQUESTS_PER_DAY` = 10, `MAX_REQUESTS_OUT` = 10, `MAX_REQUESTS_IN` = 50). The other player accepts, or declines; a `declined` request is hidden from the receiver and the sender is never told (the sender's next message is refused as waiting). Writing back accepts. Being friends is looked up every time, so becoming friends clears the wait at once and after unfriending the next message is a request again (PM-8). Requests and limits: PM-5 to 10.
* **Blocks.** `block(me, other)` inserts the row, ends the friendship, cancels challenges, drops group invitations between the two and sets a waiting request that the blocker's side had made to `declined`; a request the blocked player sent to the blocker is closed too (PM-11, 11b). `Social.request` refuses both ways (`blocked` 409 if I blocked him, `cannot_request` 403 if he blocked me). The SQL fragment `VISIBLE` hides, for a reader, messages before his `since_id`, messages by authors he blocked and messages by players the owner banned from the game (PM-14). Up to `MAX_BLOCKS` = 200 (PM-13). Unblocking restores nothing: the next message is a request (PM-12).
* **Groups.** `createGroup` needs a name (1 to `MAX_GROUP_TITLE` = 40) and friends; at most `MAX_GROUP_MEMBERS` = 8 counting invited players, `MAX_GROUPS` = 20 per player, `GROUPS_PER_HOUR` = 5, `MAX_INVITES_WAITING` = 10 invitations waiting for one player. Only the creator invites, removes, takes back and renames. `leave` by the creator hands the group to the member with the oldest `joined_ms` (ties by user id); the last member out deletes it (PM-15 to 20).
* **Messages.** Cleaned with `chat.ts`'s `cleanMessage` (plain one-line text, 1 to 300 characters). The gap, burst, repeat and new-account rules are the public chat's, counted from `private_messages`, with the owner exempt from the new-account wait. `PM_KEEP` = 1000 per conversation. A page is `PM_PAGE` = 50 (at most `PM_PAGE_MAX` = 100), newest first, older ones by `before=` the lowest id seen (PM-21 to 24). Banned (game) players and computer players cannot be written to (PM-25).
* **Reports.** Any member reports another player's message, once per message and player, 20 an hour (`PM_REPORTS_PER_HOUR`). Owner: `GET /api/admin/private-reports` lists open reports with the copied lines; `POST /api/admin/private-reports/dismiss` closes one, once per `requestId`, logged as `pm_dismiss` (PM-26 to 28).
* **Routes.** `GET /api/messages` (lists, requests, blocked, unread), `GET /api/messages/thread/:id?before=&limit=`; `POST /api/messages/send|read|respond|report|block|unblock|group/create|group/invite|group/remove|group/leave|group/rename`; owner: `GET /api/admin/private-reports`, `POST /api/admin/private-reports/dismiss`. Every route needs a signed-in player and writes have the origin check and a per-user limiter (PM-1).
* **The page.** A Career tab "Messages" (badge = unread + requests and invitations waiting: MSGUI-1), a conversation list, the thread (`PmThreadView`), a *New group* form, a Block / Report menu, and a Message button on the Players and Chat screens. The store keeps at most `MAX_PM_MESSAGES` messages of the open conversation and re-asks the server when it hears something it cannot place (MSGUI-5 to 11). Messages are shown as text only (MSGUI-13).
* **Storage.** Schema 21 adds the five tables; they refuse a direct conversation with the same player twice or with oneself, a group without a title, a duplicate member, an empty or over-long message, a self-block and a second report of one message by one player; deleting a player deletes his memberships, messages and blocks (a group stays, with `created_by` empty) and a report keeps its copy (PM-30). A program older than schema 21 refuses a database saved with it.
* **No money, no dice.** Private chats never touch cash, the market or a replay, and use no random numbers (PM-31).
* **Honest limits.** The owner cannot moderate private chats except by closing reports (deliberate: private means private); blocking is one-sided and shows the blocked player only a refusal; no editing or deleting of one's own messages; no read receipts, typing signs or online dot; no attachments. The text of a reported message is visible to the owner, so players are told that in the Report confirmation.
