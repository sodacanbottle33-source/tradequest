# TradeQuest

A trading-education simulator with fictional companies and virtual money. The game has three places, all on **one permanent market run by the TradeQuest server**: the same companies and prices for every player, never reset, running 24/7 while the server runs, and after downtime catching up to exactly the prices it would have had.

- **Career**: trade every company with your own Career account ($1,000 to start, saved on the server). Market list with market cap, company pages (candles, bid/ask book, news, trade panel) and **My account**. **Players move prices**: buying a company pushes its price up for everybody and selling pushes it down, thin and small companies the most (see below).
- **1v1**: two players trade the same market and the same companies as Career for exactly 3 minutes, with $1,000 of match cash each. If nobody else is waiting, a **bot** plays you (see below).
- **Leverage, shorts, stops and pens**: a buy or a short can use leverage from 1× to 50× (Career and 1v1), you can **short** a company to win when it falls, every position can carry a **stop-loss** and a **take-profit**, and every price chart has pens to draw on (see below).
- **Memecoins**: its own tab in Career with 30 invented coins that move far more than stocks, each with its own market cap, liquidity and news. Same Career cash, same rules, so money made on a coin lands in your Career account (see below).
- **News**: its own place next to 1v1. Every story, newest first; stories really move prices. The stories are written from about **965 hand-written templates** (about 565 for stocks and about 400 for memecoins, each market with its own set; only the economy stories are shared), filled with each company's own names, products and numbers; there is no AI writing them, so after a long time a wording comes round again.

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

Server settings (environment variables, all optional): `TQ_PORT` (default 8787), `TQ_COMPANIES` (default 66, up to 5000; companies are only ever added), `TQ_WARMUP_DAYS` (history on the very first start, default 7), `TQ_OWNER` (username that becomes the owner), `TQ_DATA_DIR`, `TQ_BOTS` (set to `0` to turn the 1v1 bots off; on by default), `TQ_MARKET_BOTS` (set to `0` to turn off only the bots' trading in the main market). `TQ_ICE_SERVERS` (optional JSON list of the servers voice calls use to find each other, e.g. `[{"urls":["stun:stun.l.google.com:19302"]},{"urls":"turn:turn.example.org:3478","username":"u","credential":"p"}]`; at most 8, each `stun:`, `turn:` or `turns:`; the default is two free public STUN servers. Note that these values are sent to the players' browsers.) After `npm run build`, `npm run server` also serves the built site from `dist/` at http://127.0.0.1:8787, so one program is enough.

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
3. **1v1**: *Find a match* → when a second player joins you both press *Ready* → a short countdown → exactly 3 minutes with $1,000 match cash each. During the match you see **every company** in the same lists and company pages as Career (chart, order book, news, trade panel), with four tabs: **Market**, **Memecoins**, **Earnings** and **News** (see *Inside a 1v1 match* below). **Career is closed** from the countdown until the match is over. The bigger profit wins and is paid as virtual currency (their profit or $50, whichever is more); the loser gets $50. Leaving a live match is a forfeit: press **Forfeit**, then **Yes, forfeit** (the question is inside the page, not a pop-up). Against a bot the match ends at once; against a person it runs on until 0:00 and you see "You forfeited". Career money is never touched by a match. If nobody else is waiting, a **bot** (a computer player, shown as "Sam (bot)" and so on, with a *Computer player* tag) joins you after 10 seconds alone, or at once if you press **Play a bot now**; you still press *Ready* yourself. A real player always takes the bot's place if he joins. Bots trade by the same rules as you, with their own $1,000 and only what has already happened on the chart, and they never get paid: you get the usual reward ($50, or your profit if that is more and you win), the bot nothing. There are eight bots with different styles (Sam, Mia, Carl, Dee, Shane, Rex, Luna, Hank), so at most eight bot matches run at the same time. A server restart cancels a match against a bot like any other.
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
- **Memecoin orders pay a trading fee of 0.5 % of the order's value, and stock orders 0.1 %** (a 1v1 match pays none). It is paid on every buy, sell, short and cover, and when a stop-loss or take-profit closes the position by itself. Opening a position pays the fee **on top of** your margin, out of your cash; closing one pays it **out of the money that comes back**, never more than comes back. The market closing a wiped-out position (liquidation) charges nothing. The fee is on the value of the order, not on your margin, so a 50× order of $10 of cash is a $500 order and pays $2.50. The trade panel shows the fee before you trade, the trade list has a **Fee** column, and your profit figures already have it taken out. It is rounded up to a whole cent. To change the rates, edit `MEME_FEE_BPS` (50 = 0.5 %) and `STOCK_FEE_BPS` (10 = 0.1 %) in `server/fees.ts` (0 = no fee).
- The lowest price of the 30 built-in coins (and of every stock) is $1.00; a built-in coin that "rugs" ends up sitting there. Coins that players **launch** are different: they are priced far below a dollar, like real memecoins (see *Launch your own coin or stock* below), and a rug pulled coin falls to $0.00000000000001 and is frozen.
- Coins never pause by themselves (the automatic pause rule is for stocks; the owner's own pause and Stop trading tools still work on them) and they are not in the owner's "make a company" form.

## Quote of the day

A small card at the top of the **Market** tab shows a short motivation line and a **tip of the day** about trading. It is the same for everybody on the same calendar day (the day on your own clock) and changes at your midnight. There are **366 original quotes** (one for every day of a leap year) and **120 tips**, so no quote repeats within a year. **Copy** puts the quote, the tip and "- TradeQuest" on your clipboard to send to a friend. **X** hides the card until tomorrow (the game remembers only the day you closed it, in your own browser). It is not shown on the Memecoins tab, on a company page, or inside a 1v1 match. It needs no server and no setting. The words are in `src/shared/dailyQuoteData.ts`; to add or change a line, edit that file (every line must be short, original and unique: the test `daily-quote-ui` checks it). Details: `docs/world.md` §27.

## More badges and animations

**15 new badges** (29 → 44): trading habits (**Ten Winners**, **Diamond Hands** for holding a stock or coin 7 days without selling any of it, **Spread Out** for buying from 5 sectors, **Home Run** for one trade with $500 profit), higher tiers (**Market Legend** 1,000 trades, **Tycoon** $1,000,000 profit, **Social Butterfly** 25 friends, **Learning Master** 100 lessons, **Unbeatable** 25 match wins), launching (**Serial Founder** 3 launches, **Fan Club** 25 different players buy one of your companies) and **four secret ones** (Collector, Regular, Lesson Learned, Chatterbox) that stay a "?" on the Badges page until you earn them.

**New animations** (looks only, nothing changes a price, an order or a badge; all of them switch off for a person who asked their device for reduced motion):
* **Badge show.** When you earn a badge a medal pops in with sparkles: a small card at the bottom for Bronze and Silver, a big one in the middle for Gold and Diamond (Diamond also tints the screen edges), and a secret badge flips from a "?" to its picture. At most two shows play per batch; the pop-up still names every badge.
* **Trade moments.** A check mark draws itself next to the answer to an order that went through, the Buy / Sell button gives a little when pressed (and shows a spinner while the order is on its way), and Cash on the Account page counts up or down like Net worth already did.
* **Smooth screens.** A screen fades and rises in when you switch tabs, and bars shimmer under "Loading…" on the Market, Account, Badges, Leaderboard, Chat and company screens.
* **Market list marks.** 🔥 for a company that is up 10 % or more since yesterday (a memecoin: 50 %), 🧊 for down 10 % or more (50 %), 👑 for a company at a fresh 24-hour high and at least 1 % up; those rows glow softly. Hover a mark for its words.

Details: `docs/world.md` §28.

## The Shop

Spend your Career cash on **looks**. Open the **Shop** tab (or the profile menu → Shop) and buy:
* **Name colours** (Sky Blue to the moving Aurora and Rainbow), **name glows** (Soft, Neon, Ember, Ice, Diamond Shine), **picture frames** (Bronze to Emerald, Ruby and Sapphire, and the top ones: Diamond Ring, Royal Crown, Champion Laurel, Wizard Aura) and **titles** under your name (Chart Watcher, Bull Runner, Market Wizard, The Oracle and more).
* Prices by rarity: **Common $2,000, Rare $10,000, Epic $50,000, Legendary $250,000**. The best Legendary things also need a badge you have already earned (for example the Diamond Ring needs the $100,000-profit badge).
* The money is **gone for good**, so your net worth, your place on the leaderboard and your growth this week go **down** by the price. 1v1 coins are never used. Buying asks twice, a thing is bought once and kept forever (a money reset does not take it away), and you can wear, change or take off a thing any time for free.
* Everybody sees your look: your name in its colour and glow with your title under it in the Players list, Chat and Messages, and a frame around your picture. **Click any name** to open that player's **profile card**: picture, net worth, rank, the day he joined, all his badges and what he wears, with a **Message** button. Your own is in the profile menu → **My profile**.
* Looks give no money and no advantage in trading, and computer players never shop. Saved with the game as **schema 27**: **an older program will not open schema 27**, so copy the `data` folder before the first start of the new version. Details: `docs/world.md` §29.

## The Shop, update 2: candles, chart looks, win styles and the billboard

More to spend your Career cash on. The prices and rules are the same as the rest of the Shop (**Common $2,000, Rare $10,000, Epic $50,000, Legendary $250,000**; the money is gone for good; each thing is bought once; the Legendary ones also need a badge you have earned).
* **For your screen only** (nobody else sees these, and they change no number): **candle colours** (Ocean, Neon, Aurora, the moving Rainbow, Diamond, Royal and more), **candle shapes** (Hollow, Slim, Rounded, Bold Wicks, Ghost, Crystal), **chart backgrounds** (Midnight Blue, Graph Paper, Green Code, Dusk, Galaxy, Northern Lights, Gold Vault), **chart effects** (Candle Glow, Heartbeat, Neon Price Line, Fire Candle, Diamond Sparkle) and **win styles** for the party after a win (Gold Rain, Candy Pop, Coin Shower, Star Burst, Fireworks, Neon Night, Diamond Rain, Royal Crown). Each card shows a small chart, or a **Try it** button for a win style, before you buy. Pick one in each place and every price chart you open wears it at once; with nothing picked your charts look exactly as before. Reduced motion gets still looks.
* **The billboard**: three places at the top of the **Market** and **Memecoins** tabs, seen by everybody (visitors too), where you can show **a company you launched yourself** for **$5,000 an hour** (1, 3, 6, 12 or 24 hours, at most 24 hours from now). Book it in the **Launch** tab ("Book", then "Confirm"). First come, first served, one place per player; you can add hours to your own place. It only shows the company (picture, name, price, who shows it, time left) and a click opens it: it never changes a price. A company that fails stops being shown. The money comes out of Career cash and is gone, so your net worth and place on both leaderboards go down by the price.
* Saved with the game as **schema 28**: **an older program will not open schema 28**, so copy the `data` folder before the first start of the new version. Banners, pets and other things are planned for a later update. Details: `docs/world.md` §30.

## Calmer stocks

Stock prices used to jitter a lot with no news behind it: small companies swung 20 % or more in a day about one day in five, from random noise alone. Now the fast random jitter of every **stock** is **halved** (memecoins keep their wild moves). The slow trend, the news and the size of what news does are unchanged, so a big day now almost always has a big story behind it.

* A new world is calm from its first tick. A world that was already running becomes calm from the moment this version first starts it; everything before that (prices, candles, charts) stays exactly as it was. The moment is stored in the database (`meta.calm_from_tick`) and never changes.
* Nothing to set and nothing to run: no new setting, no schema step, and the price-engine version is still 4. Details and the measurements in `docs/world.md` §26.

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
- **You do not pick a size: the money you put in sets it.** You choose the name, the ticker (3 to 5 letters) and the money (a coin's first buy, or a stock's money put in), plus optionally a developer name (coins) or an industry (stocks) and a description. **Nobody types a starting price: the money sets it, for a stock as well as for a coin.** **A launched coin is priced like a real memecoin: far below one cent.** Every launched coin has **one trillion coins** (like a pump.fun token), so its price is its market cap divided by a trillion, and the money you put in sets the market cap, so more money means a higher price: a free launch (no first buy) starts at about **$0.000000000064**; $5 at $0.00000000016; $100 at $0.0000000032; $5,000 at $0.00000016 (a market cap of about $160,000); $100,000 at $0.0000032; $1 million at about $0.000036; $10 million at $0.00044 (a market cap of $440 million). Every launched coin stays well under ten cents, whatever you put in. A coin launched with a few dollars is a micro, thin, wild coin; $100,000 makes a small one; $10 million makes a big, deep, calmer one (still wilder than any stock). The price can fall as low as **$0.00000000000001** and rise to at most $1.00. Prices that small are shown with all their digits (four significant digits, no trailing zeros), and the Buy / Sell box takes whole coins (you can type `5b` for five billion or `1t` for a trillion). The 30 built-in coins and the coins players launched before this update keep the prices they had. A stock's size class (micro, small, mid, large or mega) follows the money too, and so does its starting price: more money starts at a higher price per share ($100 starts at $5.00, $1,000 at $12.00, $5,000 at $22.77, $10,000 at $30.00, $50,000 at $60.00, $250,000 at $120.00, $1 million at $250.00, $5 million at $500.00, $10 million at $700.00, and in between it slides smoothly). You get as many whole shares as the money buys at that price; what is left over stays in your cash. The form shows the size, market cap, liquidity, the typical 3-minute move, how many coins or shares you will hold and what a quick sale of all of them would bring, as you type. Stocks are always the *volatile* kind.
- **The money you put in is not lost.** It comes out of your Career cash and buys the coins or shares you start out holding, at the starting price. That purchase is not a trade (no fee, no trade row) and is neither profit nor loss. Only the **launch fee** ($2.00 for a coin, $10.00 for a stock) is a real cost (it counts against that company's "Result so far"). For a stock the money does not stay anywhere: the price is the market's, as for every company. For a coin your first buy is the first money in the coin's pool (see below), but the pool still does not hold the price up: the price is the market's.
- Two clicks (*Launch coin…* / *Launch stock…*, then *Yes, launch it*). The company shows up in the Memecoins or Market list at once and starts trading about 30 to 40 seconds later, no restart needed. It has charts and its own news, and everybody can trade it. **A company cannot be deleted.**
- **A memecoin has a money pool.** Everything other players pay when they buy your coin goes into its pool, and everyone who sells is paid out of it (a sale can only be paid with what the pool holds; if it holds less than the sale is worth, only part of the sale goes through). Your own first buy is the pool's first deposit. The price itself is still made by the market (and by everybody's buying and selling), not by the pool. Because the pool is real cash that you can take, a coin only takes plain buying and selling at the market price: no leverage, no shorting, no stop-loss or take-profit and no limit orders. Coins you launched before this update have no pool and work as before. A **stock** has no pool.
- **Rug pull** (on a card under *Your launches*). **A coin:** takes **everything that is in the pool**, in cash, right now. You do not need to hold any of your own coin. The coin is dead after that: its price falls straight to dust, **$0.00000000000001**, and then it stops moving for good (news story "its developer drained the pool"). Everybody who still holds it (you too) is left with coins that are worth nothing and cannot be sold, and nothing can be bought. An old coin (launched before the tiny-price update) that was rug pulled falls to its old floor of $1.00 and also freezes now: it no longer keeps moving. The card shows what is in the pool before you confirm; you get what is in it when you press the button. **A stock:** sells **everything you hold of it in one order**, an ordinary sell (the buy–sell gap, a small price push, a news story that the founder dumped); if the order book cannot take it all at once, the part that fits is sold and you press again a few minutes later.
- **Do not expect a guaranteed profit.** With a coin you only come out ahead with **other players' money**: what you put in yourself comes back in the pool, minus the fees (the $2.00 launch fee and 0.5 % on every trade). Nobody has to buy your coin, and a coin whose pool is empty pays you nothing. A stock's rug pull costs only a few percent and hardly moves the price, so it mostly just cashes you out (and the $10.00 launch fee is gone either way). Only you can rug pull your own launches (nobody else, and not the owner), and a company the owner has halted cannot be rug pulled.
- **Limits.** You can hold at most **3 coins and 3 stocks you launched** at a time (sell out of one, or rug pull a coin, to launch another; a coin you hold none of does not use one of the three, and its $2.00 fee is the brake) and launch at most 20 of each kind ever. New accounts start with $1,000, which is enough for a small launch (a bigger one needs more Career cash; the owner can also give cash on the Players tab). Names and tickers must be new (also not one of the 30 built-in coins). The whole game has room for 300 launched coins and 400 hand-made companies.
- Players see the developer name you choose (or "AnonDev"); your username is shown to the owner only.
- **Not in 1v1.** A company a player launched can be traded in **Career only**. A 1v1 match refuses orders for it (with the reason), leaves it out of the 1v1 company list, and bots never pick it, so nobody can win a match by pushing up their own coin with Career money. You also cannot launch while your own match is in its countdown or running (Career, with its Launch tab, is hidden then; waiting in the lobby is fine, and so is launching after you forfeit). Companies the owner makes on the Admin *Create stock* tab are not launches and can be traded in a match.

## Inside a 1v1 match

- **Four tabs, the same lists as Career.** Under your match holdings you have **Market** (the stocks), **Memecoins**, **Earnings** (who reports soon, and how past reports went) and **News** (every story, with the same filters). Click a company in any of them and you get its page with the chart, the order book, its news and the trade panel, trading with your **match money** only. *← All companies* (or *All memecoins*) takes you back to the list you came from. Memecoins work exactly as in Career: they swing a lot, trading is never paused, and the 0.5 % fee does not apply in a match (a match has no fees).
- **Companies other players launched are not in these lists** and cannot be traded in a match (see *Launch your own coin or stock*). If a news story names one, its page opens and says why you cannot trade it.
- **A ticker clicked in the News screen at the top** (or in a breaking-news banner) opens that company **inside your match** while it runs.
- **Career is closed from the countdown until the match is over.** The **Career button and its tabs disappear** (1v1 and News stay), and the **server refuses new Career orders** too: buy, sell, short, cover, limit orders and new stop-loss / take-profit settings for your Career account, with the sentence "Career trading is closed while your 1v1 match is starting or running…". The reason: Career money moves prices, and a match is scored on the prices, so with Career money you could push the price your own match is scored on. Your **match account trades as always**.
  - Waiting in the lobby (even with a bot or a friend that has not pressed Ready) does **not** close Career; the countdown does.
  - Career opens again the moment the match is **over**, **cancelled** (you left during the countdown) or you **forfeit** a match against a person (it then runs on for the other player, who stays closed until 0:00).
  - What you set up **before** the match still works: a limit order already waiting can fill, and a stop-loss or take-profit you set earlier can still close its position. You can also **cancel** a waiting limit order and **read** everything. Chat, Messages, Players and My account are Career tabs, so they are out of reach during a match as well; a friend's call can still be answered from the call bar.
  - It is the same for everybody, the owner included. Other players are never affected by your match.

## Friends and the leaderboard

The **Players** tab in Career has three parts: the **Leaderboard**, your **Friends**, and **Find players**.

- **Leaderboard.** The 100 richest players by **Career net worth** (cash plus what your shares are worth right now, the same number *My account* shows), richest first. Below the list it tells you where **you** stand, also when you are not in the top 100 ("You are #137 of 412 players"). A **Friends** view ranks only you and your friends. **The owner, the computer players (the bots) and banned players are never ranked.** The server works the ranking out for everybody once and keeps it for 30 seconds; a new player or a ban shows up at once.
- **Friends need a yes from both sides.** Press **Add friend** on the leaderboard or in Find players; the other player sees the request (a red number on the Players tab, at once) and **Accepts** or **Declines**. If he has already asked you, asking him back is the same as saying yes. You can cancel a request you sent and remove a friend (for both of you). Limits: 100 friends, 30 requests waiting for an answer, 100 waiting for one player, and a request is refused when it is sent too quickly.
- **Weekly board.** A second board ranks who **grew their net worth the most this week**, as a percentage, so a small account and a big one compete fairly. A week starts **Monday 00:00 Tokyo time** and everybody starts it from their net worth at that moment (a player who joins later in the week starts from $1,000). It also has the *Friends* view, shows where **you** stand, and names **last week's best three** at the top. The owner, the bots, banned players and accounts with under $100 at the start of the week are not ranked. It is only for fun: nothing is paid out.
- **Find players.** Everybody who can be seen, richest first (the owner at the end, without a net worth), with a search box and "Show more".
- **What other players see of you:** your name and your net worth, and nothing else. Never your cash, holdings, trades or orders. **Nothing is ever sent between players** (no cash, no shares): everybody trades in the same shared market, which your trades already move for everyone.
- You must be signed in to see any of it. The data is saved with the rest of the game (schema 19, a `friendships` table); a program older than the schema it was saved with refuses to open the database (the current schema is 20, see the sections below).

## Challenge a friend to a 1v1

Waiting for the random matchmaking to put you together with a friend is luck. Instead, **challenge** them:

- Press **Challenge to 1v1** next to a friend, in *Career → Players → Friends* or in the **Play a friend** card on the 1v1 screen. Only **friends** can be challenged, and only a friend who **has TradeQuest open** right now (otherwise you are told he is not online). You can have **one challenge open at a time**, and at most 10 can wait for one player.
- Your friend sees it **at once, on whatever screen he is on**, as a banner with a countdown: **Accept** or **Decline**. A challenge runs out after **2 minutes**. You can **Cancel** yours. If your friend has already challenged you, challenging him back is the same as accepting.
- On a yes, **both of you land in a lobby of your own** (2/2, "Friend match against …"). Nobody else can join it, and no bot is added. Each presses **Ready**, then the usual countdown and exactly 3 minutes follow. It is played, scored and paid like any other 1v1 (the wallet is only a score).
- If one of you **leaves before it starts** (or closes the page for 15 seconds), the match is **cancelled for both** with a message, no penalty. Leaving after it started is a forfeit as always.
- A player who is **waiting alone** in the random lobby is taken out of it when his friend says yes. A player who is in a lobby with someone else, in a countdown or in a live match is **busy**: he cannot challenge, and a yes is refused until he is free (the challenge stays until it runs out).
- Nothing about this shows how rich anybody is; the page only learns that a friend is online by trying to challenge him (a friend who is away simply cannot be challenged).
- Saved with the game (schema 20: a `challenges` table and a `friends` flag on matches).

## The chat room

*Career → **Chat*** is one public room for **everybody who is signed in** (signed-out visitors cannot read it). The newest 50 messages open with the screen; **Show earlier messages** loads more. New messages appear **live** on everybody's page, and the Chat tab shows a red number for messages that arrived while you were elsewhere.

- **What a message is.** One line of plain text, up to **300 characters**. It is always shown as text: no formatting, no clickable links, and hidden or direction-changing characters are removed. Only the newest 2,000 messages are kept.
- **Spam is slowed down for everybody:** at least 1.5 seconds between your messages, at most 8 in half a minute, and you cannot send the same text again within a minute.
- **A new account can read at once but writes only after 5 minutes**, so nobody can make a fresh account just to spam. (The owner is exempt.)
- **Report.** Press *Report* on another player's message and confirm. The owner sees the open reports in **Admin panel → Chat**.
- **The owner's tools** (Moderate under any message, or the Admin panel's Chat tab): **Delete** a message (it disappears from every open page at once), **Mute** a player for 5 minutes, 1 hour or 1 day, **Ban from chat** until lifted, and let someone write again. A muted or banned player sees why and can still read the chat and play normally. Each action is written once to the admin log. The owner cannot be muted or banned from the chat, and the messages of a player the owner banned from the *game* are hidden.
- There is **no word filter** (messages show as typed); moderation is the owner's job, with these tools.
- Saved with the game (schema 20: chat messages, restrictions and reports).

## Private chats

*Career → **Messages*** holds your private conversations: **one-to-one** and **small private groups**. Nobody else can read them, **not even the owner**.

- **Who can write to whom.** **Friends** write to each other at once. Anybody else can send you **one message as a request**; you see it under *Requests* and press *Accept* or *Ignore*. Writing back accepts it. If you ignore it the sender is **not told** and cannot send more; becoming friends later lifts the wait, and after unfriending the next message is a request again. You can send 10 requests a day, have 10 waiting, and one player can have at most 50 waiting for him.
- **Groups.** *New group* picks a name and some friends. Invited friends must accept before they are in; a new member does not see what was said before. A group holds up to **8 players** (invited ones count), you can be in 20 groups and make 5 an hour. Every member has a **+ Invite friends** button: tick the friends you want (or *Pick everybody*) and send all the invitations at once (the friends still have to accept); only the creator takes players out, takes back an invitation and renames. Anybody can leave; if the creator leaves, the member who has been in longest takes over; the last one out closes the group.
- **Private or public group.** When you make a group (and later, from the chat, only if you made it) you choose **who can join**. **Private** is as before: only friends you invite. **Public** groups are listed under *Messages → **Public groups*** (search by name), and any player who can write presses **Join** and is in at once; a public group holds up to **30 players**. Joiners read only what is said after they join, so the screen warns that a public group is not private. If you remove a player from your group he cannot join it again. Making a public group private hides it from the list (the players inside stay); a private group cannot hold more than 8, so remove some first.
- **A message** follows the public chat's rules: one line of plain text up to 300 characters, shown as text only, at least 1.5 seconds between messages, at most 8 in half a minute, no repeating the last one, and a new account writes only after 5 minutes. Only the newest 1,000 messages of a conversation are kept. Messages arrive **live**, and the Messages tab shows a red number for unread messages, requests and group invitations.
- **Block.** Blocking a player ends your friendship and any challenge or group invitation between you, and closes a request he sent. He can no longer write to you or send friend requests (he only sees "You can't write to …"), and **what he wrote earlier in a shared group is hidden from you**. *Unblock* in the Messages screen lets you write again, but not as friends: it starts as a request. You can block 200 players.
- **Report.** Press *Report* on another player's message and confirm. The owner then sees **that message and up to 5 before it**, and nothing else of the conversation, in **Admin panel → Chat → Private reports**. A report keeps its copy of those lines even if the conversation is later left or closed, and *Dismiss* closes it (written once to the admin log). The owner **cannot** read, mute or ban anybody in private chats; the owner's chat bans cover the public room only.
- Saved with the game (schema 21: conversations, members, messages, blocks and private reports).

## Pictures in chats

Every chat can carry **one small picture** per message: the **public chat room**, **chats with friends**, **private groups** and **public groups**. Press **Picture** next to the message box, choose a photo from your device (or take one on a phone), check the small preview and send. The page shrinks it for you (at most 800 pixels wide and high, about 30–80 KB), and the server checks it again: only real JPEG, PNG or WebP files get through.

- **Who can send:** friends to each other (a message *request* is text only); in the public chat room and in public groups an account must be **1 hour old**; at most one picture every 15 seconds and 20 an hour.
- **Small and temporary:** pictures are kept **7 days**, then the message says "This picture has expired" (the words stay). All pictures together are limited to 20 MB so the free disk and the cloud copy stay small.
- **Reports:** a reported picture in the public room is kept until you close the report. For a private chat you see a picture **only** if a player reported that message (the report keeps its own copy). You cannot look at any other private picture.
- **Switch (owner):** *Admin panel → Chat → Pictures in chats* turns pictures off or on for everybody.
- Saved with the game (schema 26: picture tables, with the public groups and username changes below; **an older program will not open schema 26**, so copy the `data` folder before the first start of the new version). Details: `docs/world.md` §24.

## Changing your username

*Profile menu → Account → **Change your username***. A new name costs **$4,000** of Career cash and can be changed **once every 7 days**. You keep everything (money, shares, friends, groups, badges, pictures, messages): only the name changes, and other players' screens update by themselves. Rules: 3–20 letters, numbers or underscores, not already taken, no official-sounding names (admin, moderator, support…). The name you leave is **kept for you for 30 days**, so nobody can copy it to pretend to be you; and for those 30 days the owner's Players list and the moderators' list show **"was <old name>"** and still find the player by the old name. The owner's name cannot be changed here. Details: `docs/world.md` §25.

## Profile pictures and who is online

Open the profile menu and press **Add a picture** (or **Change my picture**) to use a photo from your own device (JPEG, PNG or WebP). Your browser shrinks it to a small square first (a few KB), so a huge photo is fine; the server accepts only real, small pictures and refuses anything else. **Every signed-in player can see every picture** (on the leaderboard, in Find players, in the chats and in calls). You can **remove** yours at any time (**Remove my picture**) (and change it up to 20 times an hour); the owner can remove anybody's from the **Players** tab of the admin panel if a picture breaks the rules. A green **dot** next to a name means that player has TradeQuest open right now. Pictures are saved with the game (schema 22, table `user_avatars`) and go with the cloud backup.

## Pictures for stocks and memecoins

Every stock and memecoin can have a **picture** (like a logo). The player who **launched** a company chooses it: on the Launch tab both forms have **Picture (optional)**, and later the company's page and your launch card have **Add / Change picture** and **Remove picture**. The **owner** can set or remove the picture of **any** company, the built-in stocks and coins too (what he changes on a company that is not his own launch goes into the admin log). **Everybody can see the pictures, also visitors who are not signed in**: in the Market and Memecoins lists, on the company page and in your holdings. A company without a picture shows its first letter on a colour. Your browser shrinks the picture first (a few KB), the server accepts only real, small JPEG, PNG or WebP files, and a player can change pictures up to 20 times an hour (the owner is not limited). A picture changes nothing about prices or money. Saved with the game (schema 24, table `company_pictures`) and in the cloud backup. Details: `docs/world.md` §20.

## Deleting your own message

In the **chat room** and in **private chats and groups** every message you wrote has a **Delete** button (it asks once: "Delete this message?"). It disappears for everybody at once. You cannot delete other people's messages (you can report them; the owner has his own tools). If someone reported your message before you deleted it, **the owner still sees that report** with the text, so deleting does not hide a broken rule.

## Companies that can fail

A **weak small company** that gets a long run of bad news can go **bankrupt**. It is rare on purpose: only companies in the small and tiny size classes with a declining, turnaround or volatile character can fail (not the ten original companies, not big or steady ones, not memecoins, not companies players launched), only after it has had **at least 9 bad stories and a net fall of about 17 % or more over 5 days**, only on a fixed 3-in-10 roll for that day, at most **one a day** and **three days apart**. When it happens a news story says so and the price **falls by more than 90 % and stops for good** (the company is dead, like a rug-pulled coin). The crash is so big that the usual **automatic trading pause** (5 minutes) starts at once; when it ends, the rules below apply. The same world fails the same way after a restart.

- **You cannot buy or short it any more**, and a waiting order that would open a position is cancelled with your cash returned.
- **If you hold shares you can still sell them** (or cover a short) at the price where it stopped; nothing is closed for you. You keep what is left (less than a tenth of the value). **A short opened before the crash wins more than 90 %.**
- A red **bankrupt** badge shows on the Market list, the company page and My account.

## Celebrations

Close a position with a real profit (at least **$25 after the fee**, and at least 5 % of what you closed or at least $100) by hand on your Career account and the screen plays **confetti and a banner** ("+$123.45 · Nice trade!"); a big or huge win is louder. Launching a company has its own "Launched!" celebration. Losses, stop-losses, liquidations and 1v1 matches never celebrate. The **My account** and **Launch** screens also animate (the net worth counts up, changed cash pulses, cards slide in). If your device asks for reduced motion you get the banner without the flying pieces. A **win style** bought in the Shop changes the colours, pictures and places of the confetti on your own screen (see "The Shop, update 2").

## Voice calls

Press **Call** next to a friend (*Players → Friends*, or at the top of your private chat with them) to talk with your **voice**. It is **voice only** and **one friend at a time**.

- **Who can call whom.** Only **friends**, and only a friend who has TradeQuest open (the page must be connected, otherwise nobody could answer). Not someone who blocked you or whom you blocked, no computer players, and nobody the owner banned. Everyone is on **one call at a time**, a ring counts, so nobody can be flooded.
- **The ring.** Your friend sees a bar at the bottom of the screen: *"<you> is calling you"* with **Answer** and **Decline** and the seconds left (a ring lasts **30 seconds**; then you are told *"did not answer"* / *"Missed call from …"*). You see *"Calling …"* with **Cancel**. The incoming call **rings** (four short beeps every 3 seconds, made by your browser, no sound file); you can switch the ringtone off in the profile menu (**Call ringtone: on / off**, kept in this browser only). The caller hears nothing until the call is answered. Your browser asks for the microphone when you press Call or Answer; if it is blocked you are told how to allow it.
- **During the call.** **Mute** silences your microphone (your friend hears silence), **Hang up** ends it for both. If one of you has TradeQuest open on a second page, that page shows the call with **Hang up** only. A call also ends when you stop being friends, block each other, the owner bans one of you, or a page stays gone for more than 15 seconds. **Reloading the page ends the call** (the sound lives in the page).
- **Privacy, honestly.** The sound goes **directly between the two browsers** (WebRTC). The server and the owner **never hear it** and **no call is recorded or kept**: no history and no database row, and a server restart ends every call. The server only rings the friend and passes the small connection messages. (Its technical log notes one short line when a call starts and one when it ends, with just the two player numbers and how it ended: no names, no sound.) Because the browsers connect to each other, **your friend's browser can see your network address**, so call only friends you trust. This is said on the ring.
- **Needs.** A microphone, an up-to-date Chrome, Edge, Firefox or Safari, and a **secure page**: the hosted site (https) or `localhost`. A plain `http://` address on another computer is not allowed to use the microphone.
- **Strict networks.** Most connections work with the free public STUN servers the game uses. Some networks (school, work, some mobile data) block direct calls; then the call says *"The connection failed or was lost…"*. Fixing that needs a **TURN relay service** (usually paid), which the game does not include. If you ever get one, give it to the server with `TQ_ICE_SERVERS` (a JSON list, see below); nothing else changes.
- Not saved anywhere: **no schema change** (the database stays at schema 21).

## Learn: a tutorial and practice lessons

The **Learn** tab (after Launch) teaches trading with made-up charts. It never uses your game money and never changes any ranking; the only reward is **XP and levels** (Rookie, Apprentice, Trader, Strategist, Veteran, Master).

- **Tutorial (no AI).** Nine short steps: shares and price, reading candles, buy low sell high, short selling, fees, leverage, stop-loss and take-profit, the dangers (news, coins, rug pulls, bankruptcies, trading pauses), and how much to risk. Each has something to play with and one check question. It works without an account; sign in to keep your progress (5 XP the first time each step is finished).
- **Lessons.** You see a made-up chart of an invented company or coin and choose **Buy, Short or Wait** (or, now and then, *how much to risk*). Then you see what happened next, what each choice would have done, and why. A wrong answer costs nothing: it explains what to look for in that situation. The game picks the chart (11 patterns, such as a dip in an uptrend, double top, breakout, head and shoulders, a coin spike that fades), more often the ones you get wrong. **The game's rules decide the grade**, never luck and never an AI. Best answer 10 XP, acceptable 6, wrong 0; every level is 100 XP.
- **AI teacher (optional, off by default).** The built-in teacher already explains every lesson. If the owner turns the AI teacher on, you can also type *why* you chose and get a short AI comment on it. The AI cannot change your grade, and its words are shown as plain text. It costs the owner money per comment, so it has daily limits per player and for everybody, and the lessons work the same when the limit is reached or the AI is down.

Turning the AI teacher on (owner only, optional): in Render open the service → **Environment** and add `TQ_AI_KEY` with **your own key** from the AI service (type it in yourself; never paste it into the project or a chat). Optional: `TQ_AI_PROVIDER` (`anthropic`, the default, or `openai` for services that use the OpenAI format), `TQ_AI_MODEL` (needed for `openai`; default for Claude is `claude-haiku-5-5`), `TQ_AI_BASE_URL`, `TQ_AI_PER_USER_DAILY` (default 15) and `TQ_AI_GLOBAL_DAILY` (default 300). Remove `TQ_AI_KEY` to turn it off again. Details and what is sent to the AI: `docs/world.md` §19. The database moves to **schema 23** (new tables only; an older program will not open it).

## Moderators and badges

**Moderators.** In the admin panel, **Players** tab, pick a player and press **Make … a moderator** (you are asked "Yes" first); **Take the moderator job** undoes it. A moderator gets a blue **Mod** tag and a **Moderation** page in the profile menu. He can **kick** (10 minutes, 1 hour or 1 day), **ban for 1 hour to 7 days**, lift bans and kicks (not the ones you gave), delete messages, mute (up to 7 days) and handle reports in the **public chat**, and **remove a profile picture**. He **cannot** act on you, on another moderator or on himself, cannot ban for longer than 7 days or for good, cannot lift a ban you gave, never sees money or private chats, and cannot use the rest of the admin panel. About 20 bans and kicks an hour is the most one moderator can give. You can take the job away at any time; everything a moderator does is in your admin log. You can have up to 20 moderators. Details: `docs/world.md` §21.

**Badges.** Like Roblox badges: 44 small medals in four groups (**Trading and money**, **Launching**, **Friends and chat**, **Learn and matches**), from Bronze to Diamond. Players → **Badges** shows them all (earned ones lit, the others locked with how to get them, and how rare each is); a player's best three show next to his name in the Players list, and a pop-up appears when he earns one. Four of the 44 are **secret**: they show as a "?" medal with only a hint until you earn them. Badges give no money, change no price and are never taken back. Details: `docs/world.md` §22 and §28.

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
server/          the TradeQuest server (Node + SQLite): world runtime, news scheduler, accounts, trading, lobby (with the 1v1 bots in lobby/bots.ts), bots that trade in the main market (marketBots.ts), live stream, owner tools (admin.ts, halts.ts, customStock.ts), friends and the leaderboard (social.ts), friend 1v1 challenges (challenges.ts), the public chat room (chat.ts), moderators (in admin.ts and chat.ts) and achievement badges (badges.ts), the Shop of name colours, glows, picture frames and titles, and the things for your own screen (cosmetics.ts), the billboard (billboard.ts), private chats and groups, private or public (messages.ts), pictures in chats (chatPictures.ts), changing the username (rename.ts), profile pictures (profile.ts) and pictures for stocks and memecoins (companyPictures.ts), voice calls (calls.ts: ringing and passing connection messages; the sound never goes through the server), copies of the data in a private GitHub repository (cloudBackup.ts), the Learn lessons and the optional AI teacher (learn.ts, aiClient.ts), player launches and rug pulls (launch.ts, customCoin.ts), the money pool behind a launched coin (pools.ts), automatic trading pauses (breaker.ts), player price impact (flow.ts), leverage and shorts (leverage.ts rules, liquidation.ts automatic closing, stop-loss and take-profit)
src/learn/       the Learn tab's pure code: tutorial steps and maths, the practice-chart generator, grading, the built-in teacher and the AI prompt (no React, no randomness)
src/shared/      the game's screens (Career, with Players: leaderboard and friends; Learn; 1v1; News), the profile menu and the owner's admin panel, and their link to the server (api.ts, store.ts, components)
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

Career recovery mechanic, match history on profiles, player stats beyond the net-worth leaderboard, badges for streaks of days, the Saturday giveaway, and (for calls) group calls, video, screen sharing, calls with non-friends and a missed-call note inside the chat; for companies, a button for the owner to make a company fail and new companies that replace failed ones; for pictures, no crop tool beyond a square; for the Shop, banners, pets and other things (a later update). Not planned: real market data, and buying virtual currency with real money. See `docs/world.md` §11 for the known limits of what exists (for example: news text is template-based, the server must stay running for "24/7", the persistent world has no independent Python reference).
