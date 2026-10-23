# TradeQuest

A trading-education simulator with fictional companies and virtual money. The game has three places, all on **one permanent market run by the TradeQuest server**: the same companies and prices for every player, never reset, running 24/7 while the server runs, and after downtime catching up to exactly the prices it would have had.

- **Career**: trade every company with your own Career account ($1,000 to start, saved on the server). Market list with market cap, company pages (candles, bid/ask book, news, trade panel) and **My account**. **Players move prices**: buying a company pushes its price up for everybody and selling pushes it down, thin and small companies the most (see below).
- **1v1**: two players trade the same market and the same companies as Career for exactly 3 minutes, with $1,000 of match cash each. If nobody else is waiting, a **bot** plays you (see below).
- **Leverage, shorts, stops and pens**: a buy or a short can use leverage from 1× to 50× (Career and 1v1), you can **short** a company to win when it falls, every position can carry a **stop-loss** and a **take-profit**, and every price chart has pens to draw on (see below).
- **Memecoins**: its own tab in Career with 30 invented coins that move far more than stocks, each with its own market cap, liquidity and news. Same Career cash, same rules, so money made on a coin lands in your Career account (see below).
- **News**: its own place next to 1v1. Every story, newest first; stories really move prices.

There are 66 fictional companies by default (more with `TQ_COMPANIES`), plus the 30 memecoins. The earlier offline Practice and Classic-round modes are no longer in the menu; their code is still in the project, unused.

Everything is simulated — no real companies, prices or money.

The rules live in [`docs/rules.md`](docs/rules.md) and the test plan in [`docs/test-cases.md`](docs/test-cases.md). If the code and the rules disagree, the rules win.

## Requirements

- **Node.js 22.13 or newer** (check with `node -v`). The server uses Node's built-in SQLite, which older versions do not have. Download the LTS version from nodejs.org if needed.
- Windows, macOS or Linux. Commands below work in PowerShell, Command Prompt or a terminal.
- Optional: Python 3, only if you want to re-run the independent reference engines for the older engines (Practice and Classic rounds).

## Run it

```bash
npm install        # first time only — downloads Vite, React, Vitest, TypeScript, tsx
npm run server     # terminal 1: starts the shared market (http://127.0.0.1:8787). Leave it running.
npm run dev        # terminal 2: starts the site; open the address it prints (usually http://localhost:5173)
```

The first time the server starts it creates `data/tradequest.sqlite` and simulates a few days of market history (about 10 seconds), then runs live. Stop it with Ctrl+C; when you start it again the market continues from where it was and catches up on the missed time. Delete the `data` folder only if you want a completely new world.

Without the server the site still opens, but it says the market is not reachable and shows nothing invented.

Server settings (environment variables, all optional): `TQ_PORT` (default 8787), `TQ_COMPANIES` (default 66, up to 5000; companies are only ever added), `TQ_WARMUP_DAYS` (history on the very first start, default 7), `TQ_OWNER` (username that becomes the owner), `TQ_DATA_DIR`, `TQ_BOTS` (set to `0` to turn the 1v1 bots off; on by default), `TQ_MARKET_BOTS` (set to `0` to turn off only the bots' trading in the main market). After `npm run build`, `npm run server` also serves the built site from `dist/` at http://127.0.0.1:8787, so one program is enough.

Other commands:

| Command | What it does |
|---------|--------------|
| `npm test` | Runs all automated tests once (Vitest) |
| `npm run test:watch` | Re-runs tests when you save a file |
| `npm run typecheck` | Checks TypeScript types |
| `npm run build` | Type-checks, then builds the site into `dist/` |
| `npm run preview` | Serves the built `dist/` folder |
| `npm run server` | Starts the shared-market server |
| `npm run owner -- <username>` | Chooses who the owner (admin) is; `npm run owner` shows it, `-- --clear` removes it |
| `npm run reset-password -- <username>` | Sets a new password for a forgotten one (stop the server first; see *Forgot a password?*) |
| `npm run cloud -- check` / `list` / `push` / `pull` | Works with the online copies of the data (see *Keeping the data on a free host*) |
| `npm run bench:world` | Measures how fast the server's world is on your computer |

## How to play

1. **Career → Market**: all companies with live price, 24-hour change, **market cap** (share price × shares outstanding) and liquidity. Search, filter by sector, sort. Click one for its page: candles (10-tick, hourly, daily), shares outstanding and float, bid / ask / spread, the order book, its news, and the trade panel.
2. **Career → My account**: create an account (username and password). You start with $1,000 of Career cash. Orders are **market orders** against the book: the panel shows what the order would cost — spread, price impact, and a warning if the book is too thin to fill all of it (the unfilled part is cancelled). Buying more than you can afford is refused. You can also place a **limit order** (the *Limit* switch above the Buy / Sell / Short / Cover buttons): type the price you want, choose how long it may wait (1 hour, 1 day or 3 days) and the order waits in the market until the price reaches yours, then trades at that price or better. A buy or short sale **sets aside** the cash it could cost (it still counts in your net worth and comes back if the order ends); a sell or cover **promises** the shares it will close. Open orders are listed on *My account* with a *Cancel* button, you get a pop-up when one fills, and you can have up to 20 open at once. Limit orders are for Career only, not for 1v1 matches. Your cash, holdings and recent trades are listed there.
3. **1v1**: *Find a match* → when a second player joins you both press *Ready* → a short countdown → exactly 3 minutes with $1,000 match cash each. During the match you see **every company** in the same list and company pages as Career (chart, order book, news, trade panel). The bigger profit wins and is paid as virtual currency (their profit or $50, whichever is more); the loser gets $50. Leaving a live match is a forfeit: press **Forfeit**, then **Yes, forfeit** (the question is inside the page, not a pop-up). Against a bot the match ends at once; against a person it runs on until 0:00 and you see "You forfeited". Career money is never touched by a match. If nobody else is waiting, a **bot** (a computer player, shown as "Sam (bot)" and so on, with a *Computer player* tag) joins you after 10 seconds alone, or at once if you press **Play a bot now**; you still press *Ready* yourself. A real player always takes the bot's place if he joins. Bots trade by the same rules as you, with their own $1,000 and only what has already happened on the chart, and they never get paid: you get the usual reward ($50, or your profit if that is more and you win), the bot nothing. There are eight bots with different styles (Sam, Mia, Carl, Dee, Shane, Rex, Luna, Hank), so at most eight bot matches run at the same time. A server restart cancels a match against a bot like any other.
4. **News**: every story is kept, newest first. Each company gets at least three stories a day, plus sector, economy and rare viral stories. Stories can move the price (positive, negative or unclear); once a story's effect is over the list shows what the price actually did. A click on a company name opens it in Career.
5. **Earnings**: every company reports its results every **3 days** of the market (a quarter; four quarters make a 12-day year). A company's page has an **Earnings** panel: profit per share for the last year, the **P/E ratio** (price ÷ a year of profit per share), when it reports next and what analysts expect, and its last reports with *beat*, *miss* or *in line*, the revenue, the change on a year ago and how the price reacted. The **Earnings** tab lists what reports in the next 24 hours and what just came out. The figures in a report always agree with its headline (a positive story is a beat, a negative one a miss), and what a report will say is never visible before it is published. Memecoins have no earnings. The computer players (Sam, Mia, Carl, Dee, Shane, Rex, Luna, Hank) read the same news, reports, price/earnings ratios and order-book tilt as you: Mia chases good news, Shane shorts bad news, Carl and Hank buy the drop, Rex scalps big stories within seconds, Sam trades the big companies' reports, and followers get out when a story turns against them.

## Leverage (1× to 50×, on Buy and Short)

In the trade panel, **Buy** (and **Short**, see below) has a **Leverage** slider (1× to 50×, with quick buttons 1×, 2×, 5×, 10×, 25×, 50×). It works in Career and in 1v1.

- You pay only part of the order out of your own cash: the **margin**, the order's value divided by the leverage (rounded up to a whole cent). The rest is borrowed. In Career the borrowed part costs **interest** (10 % a year on a stock, 40 % on a memecoin, charged to the debt every minute; a short pays a **borrow fee** instead, 0.5–10.5 % a year on a stock, 40 % on a memecoin), and you get a **margin call** pop-up when a position has lost three quarters of your money in it. A 1v1 match has none of this. Memecoin orders also pay the trading fee below. At 10×, $500 of shares needs $50 of your cash; at 50×, $1,000 of cash buys up to $50,000 of shares.
- The panel shows your margin, the borrowed part, and the **price at which the market closes the position** and how far below the current price that is (at 10× about 10 % below, at 50× about 2 % below).
- When you **sell**, the debt that belongs to the shares you sell is repaid out of the proceeds and you keep the rest. Your gain or loss counts against your margin, so a 5 % rise at 10× is about +50 % on the cash you put in, and a 5 % fall is about −50 %.
- **Liquidation**: when the shares are worth no more than the debt, the market closes the position **at once**, automatically, at the market price. You lose the margin of that position and nothing else: never more than the margin, your other cash and shares are untouched (each position is its own margin). It is shown in the trade list as *Liquidated*. This is checked at every market tick, **also for the time the server was off**: a price that fell that far while nobody was watching still closes the position, at the moment it happened.
- Each stock's liquidation price follows everything you hold in it: buying more adds its margin and its debt to the same position.
- A very big or thin order can be refused at a high leverage because the cost of opening it (spread, thin order book, the push you cause) would use more than half of its margin: the message names the highest leverage that works. Leverage never makes a purchase cheaper than the book: you still pay the real fill prices.
- Net worth counts a leveraged position as its value minus its debt, never below zero.
- In **1v1** the final score counts a leveraged position at its value at the end minus its debt (never below zero), so a win with leverage can be large, and a wiped-out position counts as nothing. The winner's reward is their profit (or $50 if more), so with big leverage the reward can be big too; it is virtual currency only.
- The owner's tools work with it: taking shares from a player takes the matching part of the debt with them, and resetting an account removes positions and debts together.

## Short selling (win when a price falls)

The trade panel has four tabs: **Buy**, **Sell**, **Short** and **Cover**. It works in Career and in 1v1, for stocks and for memecoins. (The one exception is a memecoin a player launched with a money pool, see *Launch your own coin or stock*: it takes only plain Buy and Sell at the market price, so the Short, Cover, leverage, stop-loss, take-profit and limit-order tools are not offered for it.)

- **Short** sells shares you do not own, at the market. You win if the price later falls (you buy the shares back cheaper) and lose if it rises. **Cover** buys them back and ends the short (all of it or part).
- The money from the sale is not paid to you: it is **held on the position** as security. You put in a **margin** from your cash, the sale's value divided by the leverage (1× to 50×, rounded up to a whole cent; at 1× the margin equals the sale value). Held money plus margin is the position's **collateral**.
- Covering costs the real fill prices (spread and thin book included). What is left of the collateral after buying back comes back to your cash; if it is gone, nothing comes back. So the most you can lose is the margin, never more: if the price shoots up, the market closes the short first (see Liquidation).
- **Liquidation**: when buying the shares back would cost the whole collateral or more, the market closes the position at once, at the market price. The price where this happens is shown in the panel before you order (at 1× a short is closed when the price has doubled; at 10× about 10 % above; at 50× about 2 % above). It is also checked for the time the server was off.
- One company is either long or short for you, not both: cover first before you buy it, sell first before you short it.
- Net worth counts a short at what buying it back would cost right now (the ask), never below zero. In **1v1** the final score does the same at the last price.
- The owner's "take shares" tool refuses to work on a short position.

## Stop-loss and take-profit

Open the **Stop-loss / Take-profit** box under the order form (the same box on a position you already hold changes it later; it also lets you remove it). You type a price, or pick a quick button (stop-loss 5 %, 10 % or 25 % away from the price; take-profit 10 %, 25 % or 50 % away). **My account** shows the prices on each position.

- **Stop-loss** (a long: below the price, a short: above it) limits a loss; **take-profit** (a long: above, a short: below) locks in a gain.
- When the market price reaches it, the market **sells (or buys back) the whole position by itself** as an ordinary market order: it pays the spread and walks the order book like any order, so you get the price the book gives at that moment, not exactly your number. On a thin coin the spread can be wider than a small take-profit gain, so such a take-profit can close at a small loss. The trade list marks it *Stop-loss* or *Take-profit*.
- If trading cannot take the order at that moment (the company is paused, or the server is still catching up after being off) the position stays and the next second tries again: a stop never fires from a price in the past, only from the market's price now. A liquidation always goes first.
- Memecoins never pause, so a stop on a coin is never locked out; stocks can pause (see the automatic pauses below).

## Pop-ups when the market closes a position

When the market closes a position by itself, a pop-up appears **at once** wherever you are on the site: **You were liquidated** (red), **Stop-loss hit** or **Take-profit hit** (green if it made money), with the company, the price and what you won or lost. It goes away after 12 seconds or with *Close*. The trade list in My account keeps the record.

## The order book is live

The bid/ask book on a company page refreshes every 2 seconds. When other players buy a company, the asks (sell offers) get thinner and the bids thicker, and the other way round when they sell, so the book you see is the book your order will be filled against. A note under the book says when buying or selling pressure is on. The **Total** line now says how many levels it counts ("All 20 levels") and the table shows the best 8; the total is the whole book, not only the rows shown.

## Memecoins

The **Memecoins** tab in Career lists 30 invented coins (WOOF, HOPP, MEOW, …) in four sizes: big and liquid ones, mid, small and tiny thin ones. All are fictional.

- They are traded exactly like stocks and with the same **Career cash**: money made (or lost) on a coin is your Career money, and leverage, shorts, stop-loss, take-profit and the pop-ups all work on them.
- They move **far more**: a stock's typical 3-minute move is under 1 %, a coin's is 7 % to 45 %, so you can win or lose a lot in seconds. A leveraged position on a tiny coin can be liquidated in seconds. Each coin has a **market cap** and a **liquidity** number; thin coins are pushed around more by orders (also by other players').
- They have their own **news** (rug rumours, whale buys and dumps, influencer threads, exchange listings, dev-wallet moves), at least three stories a day per coin, and the stories hit coins harder than they hit stocks.
- **Memecoin orders pay a trading fee of 0.5 % of the order's value** (stocks pay none, and neither does a 1v1 match). It is paid on every buy, sell, short and cover, and when a stop-loss or take-profit closes the position by itself. Opening a position pays the fee **on top of** your margin, out of your cash; closing one pays it **out of the money that comes back**, never more than comes back. The market closing a wiped-out position (liquidation) charges nothing. The fee is on the value of the order, not on your margin, so a 50× order of $10 of cash is a $500 order and pays $2.50. The trade panel shows the fee before you trade, the trade list has a **Fee** column, and your profit figures already have it taken out. It is rounded up to a whole cent. To change the rate, edit `MEME_FEE_BPS` in `server/fees.ts` (50 = 0.5 %, 0 = no fee).
- The lowest price in the market is $1.00; a coin that "rugs" ends up sitting there.
- Coins never pause by themselves (the automatic pause rule is for stocks; the owner's own pause and Stop trading tools still work on them) and they are not in the owner's "make a company" form.

## Price animations

The charts and prices have some life, like pump.fun. It is only how things look: nothing here changes a price or places an order.

- **Every tick.** Prices in the Market and Memecoins lists flash green when they tick up and red when they tick down. On a company page the big price rolls to its new value and glows. On the chart the live candle glows green or red, a dot at its tip sends out a ring (a bigger one for a move of 1 % or more), the price tag flashes and a small "+0.8%" floats up.
- **Milestones.** From **2x** its starting price a company shows a badge like "🚀 5.3x since the start". When the price **crosses 2x, 5x, 10x, 25x, 50x or 100x while you are watching**, a celebration plays: a big banner with the multiple, a rocket or moon, and confetti. 10x and up also flashes the screen green and shakes the page for a moment. It plays once per milestone per browser tab, never blocks a click, and ends by itself. Opening a coin that already stands at 10x plays nothing, only the badge shows.
- **Reduced motion.** If your system asks for reduced motion, there is no flashing, rolling, confetti or shaking; the badge still shows.

## Pens on the charts

Every price chart (Career and 1v1 company pages, and the practice chart) has a **✏ Draw** button above it.

- **Pen** and **Eraser**, six colours, three line sizes, **Undo** (also Ctrl+Z while the chart has focus), **Clear** (Undo brings it back), and **Hide drawings / Show drawings**. **Esc** stops drawing. It works with a mouse, a finger or a stylus; while drawing, dragging on the chart draws instead of scrolling the page.
- A drawing is pinned to **time and price**, not to the screen: it stays on the same candles and prices when you scroll the chart, resize the window, switch the candle size or the price scale changes.
- Drawings are saved **in this browser, per company** (up to 200 strokes each), so they are still there after a reload. They are never sent to the server, so nobody else sees them. If the browser blocks saving, drawing still works until the page is closed. The practice chart keeps its drawings only until the page is closed.

## Profile menu: log in and log out

The round profile button in the top right works like the one in Claude. Signed out it offers **Log in** (a small window with username and password) and **Create account**. Signed in it shows your name and has **My account** and **Log out**. Logging out ends the session on the server and closes your Career data on this screen; logging in again brings it back.

## Players move prices

Every filled **Career** order pushes the company's price: a buy up, a sell down, for every player at once. The size follows the square-root law of real markets: it depends on the order compared with the company's order book, so a $1,000 order moves a small, thin company a lot (about 0.7 % for a $26 M company) and a big liquid one hardly at all (about 0.003 % for a $79 B company). What everybody buys and sells together adds up; the pressure fades with a half-life of 5 minutes.

- The trade panel shows it before you press the button: "Effect on the price — pushes it up about X for everyone (you pay about Y extra for that)".
- You pay for the push you cause: 60 % of it is added to your fill prices and only 40 % reaches the price, so buying, waiting and selling can never make money from your own push alone.
- **1v1 matches never move prices** (a match is scored on the shared price, so nobody can lift it with his own order).
- **The bots push too**: they trade in Career with their own money (see *Bots in the market*), so the book tilts and thin companies get nudged even when no other player is online.
- The push is saved with the trade and replayed after a restart, so prices come out the same as if the server had never stopped.
- The owner sets the strength in the admin panel (Market tab) and can turn it off.
- To see a big move yourself: the owner gives a player extra cash in the Players tab, and that player buys a small company's whole book.

## Bots in the market

The eight bots from 1v1 (Sam, Mia, Carl, Dee, Shane, Rex, Luna, Hank) also trade in the **main market** all day, with **their own money** ($1,000,000 each, never yours), so the market is not empty when nobody is online. Each has a style: Sam holds big steady stocks, Mia chases what is rising, Carl buys what fell, Dee gambles on memecoins both ways, Shane shorts risers, Rex scalps stocks, Luna rides the strongest coin and Hank hunts bargains.

- They are small compared with the order book, so they **tilt the live order book** and nudge thin companies and memecoins (a few percent at most in half an hour), and a big company hardly moves. About seven orders a minute across the whole market.
- They trade by the same rules as you: spread, the 0.5 % memecoin fee, price push. They use **no leverage and no stops**, so they are never liquidated.
- They **never trade companies players launched**.
- The owner sees them in the Players tab as `bot-sam` … `bot-hank`. `TQ_MARKET_BOTS=0` turns this off and leaves the 1v1 bots on; `TQ_BOTS=0` turns off all bots.

## Launch your own coin or stock

Any signed-in player can open the **Launch** tab in Career and launch a **memecoin** or a **stock** of his own, then trade it, watch other players trade it, and **rug pull** it.

- **Making a memecoin is almost free, like on pump.fun.** It costs only a **$2.00 launch fee** (paid and gone; no refund). On top of that you may buy some of your own coin right away, a **first buy** of anything from **$2 up to $10,000,000**, or **nothing at all ($0)**: then you hold none of it, and once it lists (30 to 40 seconds) you buy it on the market like every other player (paying the buy–sell gap and the 0.5 % fee). **A stock has no free launch and is not for pocket change**: it needs a real stake, **at least $100 put in** (at most $10,000,000), plus a **$10.00 launch fee** (paid and gone, like the coin's). The money buys the shares you start out holding; only the fee is lost.
- **You do not pick a size: the money you put in sets it.** You choose the name, the ticker (3 to 5 letters) and the money (a coin's first buy, or a stock's money put in), plus optionally a developer name (coins) or an industry (stocks) and a description. **Nobody types a starting price: the money sets it, for a stock as well as for a coin.** From $5,000 up every launched coin has the same number of coins (80,000), so more money means a higher price: $5,000 starts at $2.00, $100,000 at about $40, $10 million at $5,500. The cheapest a coin can start is $2.00, so with less than $5,000 the price stays at $2.00 and the coin has fewer coins ($100 buys 50 coins of a 1,600-coin coin; with no first buy the coin is the smallest one, 32 coins at $2.00). A coin launched with $5,000 is a small, thin, wild coin (a market cap of about $160,000); a $100 one is a tiny, thinner one; $100,000 makes a small one; $10 million makes a big, deep, calmer one (still wilder than any stock). A stock's size class (micro, small, mid, large or mega) follows the money too, and so does its starting price: more money starts at a higher price per share ($100 starts at $5.00, $1,000 at $12.00, $5,000 at $22.77, $10,000 at $30.00, $50,000 at $60.00, $250,000 at $120.00, $1 million at $250.00, $5 million at $500.00, $10 million at $700.00, and in between it slides smoothly). You get as many whole shares as the money buys at that price; what is left over stays in your cash. The form shows the size, market cap, liquidity, the typical 3-minute move, how many coins or shares you will hold and what a quick sale of all of them would bring, as you type. Stocks are always the *volatile* kind.
- **The money you put in is not lost.** It comes out of your Career cash and buys the coins or shares you start out holding, at the starting price. That purchase is not a trade (no fee, no trade row) and is neither profit nor loss. Only the **launch fee** ($2.00 for a coin, $10.00 for a stock) is a real cost (it counts against that company's "Result so far"). For a stock the money does not stay anywhere: the price is the market's, as for every company. For a coin your first buy is the first money in the coin's pool (see below), but the pool still does not hold the price up: the price is the market's.
- Two clicks (*Launch coin…* / *Launch stock…*, then *Yes, launch it*). The company shows up in the Memecoins or Market list at once and starts trading about 30 to 40 seconds later, no restart needed. It has charts and its own news, and everybody can trade it. **A company cannot be deleted.**
- **A memecoin has a money pool.** Everything other players pay when they buy your coin goes into its pool, and everyone who sells is paid out of it (a sale can only be paid with what the pool holds; if it holds less than the sale is worth, only part of the sale goes through). Your own first buy is the pool's first deposit. The price itself is still made by the market (and by everybody's buying and selling), not by the pool. Because the pool is real cash that you can take, a coin only takes plain buying and selling at the market price: no leverage, no shorting, no stop-loss or take-profit and no limit orders. Coins you launched before this update have no pool and work as before. A **stock** has no pool.
- **Rug pull** (on a card under *Your launches*). **A coin:** takes **everything that is in the pool**, in cash, right now. You do not need to hold any of your own coin. The coin is dead after that: its price crashes (news story "its developer drained the pool"), everybody who still holds it (you too) is left with coins that are worth nothing and cannot be sold, and nothing can be bought. The card shows what is in the pool before you confirm; you get what is in it when you press the button. **A stock:** sells **everything you hold of it in one order**, an ordinary sell (the buy–sell gap, a small price push, a news story that the founder dumped); if the order book cannot take it all at once, the part that fits is sold and you press again a few minutes later.
- **Do not expect a guaranteed profit.** With a coin you only come out ahead with **other players' money**: what you put in yourself comes back in the pool, minus the fees (the $2.00 launch fee and 0.5 % on every trade). Nobody has to buy your coin, and a coin whose pool is empty pays you nothing. A stock's rug pull costs only a few percent and hardly moves the price, so it mostly just cashes you out (and the $10.00 launch fee is gone either way). Only you can rug pull your own launches (nobody else, and not the owner), and a company the owner has halted cannot be rug pulled.
- **Limits.** You can hold at most **3 coins and 3 stocks you launched** at a time (sell out of one, or rug pull a coin, to launch another; a coin you hold none of does not use one of the three, and its $2.00 fee is the brake) and launch at most 20 of each kind ever. New accounts start with $1,000, which is enough for a small launch (a bigger one needs more Career cash; the owner can also give cash on the Players tab). Names and tickers must be new (also not one of the 30 built-in coins). The whole game has room for 300 launched coins and 400 hand-made companies.
- Players see the developer name you choose (or "AnonDev"); your username is shown to the owner only.
- **Not in 1v1.** A company a player launched can be traded in **Career only**. A 1v1 match refuses orders for it (with the reason), leaves it out of the 1v1 company list, and bots never pick it, so nobody can win a match by pushing up their own coin with Career money. You also cannot launch while your own match is in its countdown or running (the Launch tab is hidden then; waiting in the lobby is fine, and so is launching after you forfeit). Companies the owner makes on the Admin *Create stock* tab are not launches and can be traded in a match.

## Owner admin panel (only for you)

The owner is exactly one username, chosen by whoever runs the server. Nobody can become the owner from the website.

1. `npm run owner -- <your username>` (or set `TQ_OWNER`). This writes `data/owner.txt`.
2. Stop the server with Ctrl+C and start it again with `npm run server`.
3. Log in (or create the account) with that username. The profile menu now has an **Admin panel** item and an Owner badge. Other players never see it, and the server answers every admin address with 403 for them.

### Forgot a password?

There is no "forgot password" button on the website (it has no e-mail to send a link to). The person who runs the server can set a new password for any account, the owner's included:

1. Stop the server (Ctrl+C in its window). The command refuses to work while the server is running.
2. `npm run reset-password -- <username>`. It asks for the new password (8–72 characters) twice and does not show what you type.
3. Start the server again and sign in with the new password.

The role (owner or player), the cash, the positions and everything else of the account stay as they are. Only the password changes, and the account is signed out everywhere. It works on the database file in `data/`, so there is no address on the website that can do it. On a host where you cannot open a terminal (for example Render's free plan) set the password with the other account's tools on your own computer, then send the world online with `npm run cloud -- push` (see *Keeping the data on a free host*).

### Keeping the data on a free host

Render's free plan erases the server's disk every time the server sleeps (after 15 minutes without a visitor), restarts or is redeployed, and without help every one of those starts a brand new world. TradeQuest can keep its data in a **private GitHub repository** instead. While it runs, the server saves a checked, compressed copy of its database there every 10 minutes and once more when the host tells it to stop. When it starts with no database, it loads the newest good copy and the market catches up to the present. On your own computer none of this runs unless you set the two settings below.

**One-time setup**

1. On GitHub make a **private** repository (for example `tradequest-data`) and tick *Add a README* (a repository needs one commit before it can hold copies).
2. Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → generate a token for **only that repository** with *Repository permissions → Contents: Read and write*. Copy it; it starts with `github_pat_`. Keep it secret: anybody with it can read the saved accounts.
3. On your computer (PowerShell, in the TradeQuest folder), stop the server, then set the two settings **for this window only** and look at the store:
   ```
   $env:TQ_BACKUP_REPO = "your-github-name/tradequest-data"
   $env:TQ_BACKUP_TOKEN = "github_pat_..."
   npm run cloud -- check
   ```
4. To bring the game from your computer online, send a copy of it: `npm run cloud -- push`. It only reads your game (`data/tradequest.sqlite`), shows which accounts are in it, and refuses to upload to a public repository.
5. On Render open the service → Environment and add the same two settings (`TQ_BACKUP_REPO`, and `TQ_BACKUP_TOKEN` as a secret). Render restarts the server, which loads the copy you pushed. Do step 4 **before** step 5: once the online server runs with the settings it saves its own copies, and those are newer than the one you push.

The commands: `npm run cloud -- check` (is the store reachable and private, which copies it holds), `list` (the copies, newest first), `push` (send this computer's game as the newest copy; it asks first when copies already exist, or use `--yes`), `pull` (download the newest good copy to `data/online-copy.sqlite`, never over your own game).

**What to expect.** A copy is about 15 MB packed. The server checks every `TQ_BACKUP_MINUTES` (default 10; 0.1 to 1440) and saves only if somebody did something that can change saved data since the last copy (a sign-in, a trade, a launch, an admin action; plain page views do not count), plus one safety-net copy an hour while it runs. The market itself needs no copy of its own progress: it is deterministic, so a copy plus the catch-up at the next start gives the same prices. The newest 6 copies are kept. If the host kills the server without warning, the changes since the last save are lost (up to 10 minutes of activity). A save that fails (GitHub down, token expired) is a message in the log and the server keeps running; the change stays due and is tried again, and after three failures in a row it is logged as an error. If the store cannot be reached when the server starts with an empty disk, or every copy is damaged, the server **refuses to start** and says why, rather than starting a new world that would later be saved over the good copies. The first wake-up after a long sleep takes longer: the copy is downloaded and the market catches up (roughly 5,000 seconds of market time per second on Render's free processor, so a day of sleep is about 20 seconds).

**On Render, set the Start Command to `node --import tsx server/main.ts`** (Settings → Build & Deploy → Start Command) instead of `npm run server`. When Render stops a service it sends the stop signal to the one program it started; `npm` does not pass it on, so with `npm run server` the server never hears it and the last save (the one that catches the final minutes of play) does not happen. Started directly, the log shows `SIGTERM received: stopping` and a `Saved ...` line on every redeploy and every sleep.

Settings: `TQ_BACKUP_REPO` (`owner/name`), `TQ_BACKUP_TOKEN`, `TQ_BACKUP_MINUTES`. Both of the first two or neither.

The panel has four tabs:

- **Market**: pick a company and move its price. **Rug pull** (−90 %), **Crash** (−30 %), **Pump** (+100 %) or **Custom**, any percent from −99 to +900, instant, fast (5 min) or slow (1 h). You review first and confirm second. The move is sent as an ordinary breaking news story labelled as a special event, so every player sees it and the chart shows it. The percent is a target, and the real result is close but not exact ("about": a −90 % request gave about −78 % to −75 % in the browser test, because the price keeps its normal random movement while the move plays out). The price never goes below $1.00. **Stop trading** halts a company for everyone in Career and 1v1 (the price keeps moving, orders are refused with your reason) until you resume it.
- **Players**: every player with Career cash, net worth and coins, and a **Banned** badge. Click a player to:
  - **Give or take Career cash** (a gift counts as a deposit, so it does not look like trading profit), **coins** (the 1v1 virtual currency), up to $1,000,000,000 at a time, or **shares** of any company (up to 1,000,000 at a time, valued at the current price and also never counted as profit). Taking more than a player has is refused.
  - **Ban** the player for 1 hour, 1 day, 7 days or until you lift it, with a reason (two clicks: *Ban…* then *Yes, ban*). A banned player is signed out at once (even a browser that is still open), cannot sign in (he is told the reason, if he knows the password), leaves any 1v1 lobby, and forfeits a live match. His money and shares stay as they are. **Unban** brings the account back, and an old session works again. The owner cannot be banned. A ban belongs to the account name: it cannot stop the same person from making a new account.
  - **Reset the Career account** (two clicks): $1,000, no shares, no trade history, no old profit. Coins and 1v1 history stay.
- **Create stock**: make a company of your own. You choose the name, the ticker (3 to 5 letters), the sector, the size (micro, small, mid, large or mega), the personality (steady, income, growth, cyclical, volatile, turnaround or declining), the starting price ($2.00 to $1,000.00), and optionally the industry and a description. Two clicks (*Create stock…* then *Yes, create it*). The company appears in everybody's market list at once and starts trading about 30 to 40 seconds later; no server restart is needed. It is a real company: charts, its own news (written like any other company's), trading, price impact, and it is moved by market and sector news too. You can then push its price, halt it or give shares of it in the other tabs. **A stock cannot be deleted**, only halted, so check the name and ticker before you confirm. Names and tickers must be new (not used by any company, case-insensitive), and there is room for up to 400 companies made by hand in all (yours and the players' stocks together). It needs the default 66 base companies (`TQ_COMPANIES` 66 or more). If the page ever says a stock is saved but not running yet, stop the server and start it again; it then begins trading.
- **Launches**: the stocks and memecoins that players launched in the Launch tab (see *Launch your own coin or stock*): who launched each one (you see the username, players only see the developer name), what he put in, what he holds of it now, the money in a coin's pool, his rug pulls so far and the company's status. It is read only. To stop a launched company, halt it on the Market tab (a halted company cannot be rug pulled either). A launched company can never be deleted. The earlier owner-only *Create coin* tab is gone: coins you made with it are now your own launches and you can rug pull them like anybody else.
- **Log**: every admin action, newest first, with who did it and when.

The **Market** tab also has:

- **Price impact of player trades** has no setting any more: Career trades always push a price with one fixed strength, the size of the real market (the Market tab only explains it). Thin, small companies move visibly, big companies hardly move at all. A price can go up to $1,000,000 a share (just above the dearest real share; the game stores prices in whole cents, so some top price has to exist).
- **Announcement**: a message (up to 200 characters) at the top of every page, pushed to open pages at once. A player can dismiss it on his own page; you take it down for everybody.
- **Automatic pauses** (nothing to do, it is automatic): like a real stock exchange, the market stops trading in a company for 5 minutes when its price has moved too far in 5 minutes: 10% for large and mega companies, 15% for mid-size, 30% for small and 45% for micro-caps (small stocks swing a lot on their own, so they get wider limits). Players trying to buy or sell see why and when it reopens; the company shows *Paused* in the list. The price keeps moving while it is paused, and it reopens by itself. Your own price moves (rug pull, crash, pump) never trigger it. Paused companies also show in *Halted now* in the Market tab, marked *Auto*, and *Resume* reopens one early. So a big seller can push a stock down only so far before the market stops him for a while.
- **Pause all trading**: an emergency switch (two clicks, with a reason players see). Nobody can buy or sell anything, in Career or 1v1, until you open trading again; every company shows as halted; prices and news keep going. Banner, announcement, ban and pause all survive a server restart.

Price moves cannot be undone. A price move is saved in the database as a news story, so it is replayed exactly after a server restart: prices come out the same as if the server had never stopped. The first start with this version upgrades the database to schema 13 (5 added the owner tools, 6 the player price impact, 7 bans and account resets, 8 companies made by the owner, 9 a trade-strength column that the game no longer uses, 10 automatic trading pauses, 11 leverage: debt on positions, leverage and liquidation flags on trades, 12 memecoins, short selling, stop-loss and take-profit, 13 the memecoin trading fee: a fee column on trades). In a world that already exists the 30 coins are added once, and they list about 10 minutes after the first start; nothing that exists changes. An older version of the program cannot open it afterwards, so copy the `data` folder before you upgrade if you want to keep the option.

## Project structure

```
docs/            rules.md (the spec), test-cases.md, dependencies.md
src/engine/      the trading engine — pure TypeScript, no React, fully tested
  constants.ts   all parameters (start cash, candle counts, volatility…)
  money.ts       integer-cent rounding helpers
  format.ts      $ and % display formatting
  rng.ts         Mulberry32 seeded random numbers
  candles.ts     deterministic candle generator
  account.ts     cash, shares, cost basis, P&L, equity
  orders.ts      order types and quantity parsing
  round.ts       single-stock round flow (engine v1, kept with its tests)
  view.ts        the safe view of a single-stock round (only candles 1..k)
  stocks.ts      the ten fictional stocks and their candle settings
  market.ts      market candles for a seed (one random stream per stock), start cash
  portfolio.ts   one shared cash balance + a position per stock
  marketRound.ts market round flow (engine v2): submit, cancel, next, finish, replay
  marketView.ts  the safe view React receives: candles 1..k of every stock, never later
  ticks.ts       live mode (engine v3): the price of every stock at every tick, from (seed, stock, tick)
  liveCandles.ts candles built from ticks: exactly 10 ticks each, open/high/low/close, colour
  liveSession.ts a live session: advance ticks, skip, buy/sell at the current price, timed sessions
  liveView.ts    the safe view React receives: prices and candles up to the current tick only
src/world/       the persistent world (engine v4): companies, price model, liquidity, news generator, 1v1 rules — pure TypeScript
server/          the TradeQuest server (Node + SQLite): world runtime, news scheduler, accounts, trading, lobby (with the 1v1 bots in lobby/bots.ts), bots that trade in the main market (marketBots.ts), live stream, owner tools (admin.ts, halts.ts, customStock.ts), copies of the data in a private GitHub repository (cloudBackup.ts), player launches and rug pulls (launch.ts, customCoin.ts), the money pool behind a launched coin (pools.ts), automatic trading pauses (breaker.ts), player price impact (flow.ts), leverage and shorts (leverage.ts rules, liquidation.ts automatic closing, stop-loss and take-profit)
src/shared/      the game's screens (Career, 1v1, News), the profile menu and the owner's admin panel, and their link to the server (api.ts, store.ts, components)
src/app/         React glue for the older offline modes (no longer in the menu): useMarket / useLiveMarket hooks, playback timer, LiveController, seed picking (crypto)
src/ui/          React components (stock chips, animated live chart, chart pens (chartPens.ts, usePens.ts, PenLayer.tsx), controls, trade panel, account, holdings, history, results)
tests/           Vitest tests, helpers and the golden fixtures
tools/           bench-world.ts (speed check), set-owner.ts (npm run owner), reset-password.ts (npm run reset-password), cloud.ts (npm run cloud), reference_engine.py, reference_market.py, reference_live.py — independent Python engines for golden values
```

The engine never imports React, and React never sees the full candle lists — only `getMarketView(state)`, which contains candles 1..k of each stock.

## Tests and golden values

- `tests/fixtures/reference-v1.json` was produced by `python tools/reference_engine.py`, an independent Python implementation of the price engine written from the spec. The TypeScript tests compare against it; it is **never** generated from the TypeScript code.
- `tests/fixtures/reference-market-v2.json` comes from `python tools/reference_market.py`: the ten stocks' candles plus eight random trading sessions played by a second, separate implementation of the order rules. The TypeScript engine must reproduce every final state exactly (`tests/market-reference.test.ts`).
- `tests/fixtures/reference-live-v3.json` comes from `python tools/reference_live.py`: tick prices of all ten stocks (drawn one number after another, while the TypeScript engine jumps straight to any number), candles at twelve ticks, and eight random live sessions. The engine must match exactly (`tests/live-reference.test.ts`).
- Only regenerate a fixture together with a version bump (`ENGINE_VERSION` / `MARKET_ENGINE_VERSION` / `LIVE_ENGINE_VERSION`, rules.md §5.6, §12.10 and §13.10). If the TypeScript engine and the reference disagree, one of them has a bug.
- Randomized property tests print the market seed and the exact action list when they fail, so you can reproduce the failure with `replayActions(seed, actions)` (`tests/helpers/property.ts`) `replayMarketActions(seed, actions)` (`tests/helpers/market.ts`) or `replayLiveActions(seed, actions)` (`tests/helpers/live.ts`).
- Playback timing is tested with a fake timer (`tests/helpers/scheduler.ts`), so "10 seconds at 4×" runs instantly. **Not automated:** the real-browser animation checks (real timers, real CSS) were run by hand against the built page and are listed in docs/test-cases.md §16.

## Not built yet

Career recovery mechanic, match history on profiles, stats and leaderboards, achievements and titles, and the Saturday giveaway. Not planned: a fee on stocks, real market data, and buying virtual currency with real money. See `docs/world.md` §11 for the known limits of what exists (for example: news text is template-based, the server must stay running for "24/7", the persistent world has no independent Python reference).
