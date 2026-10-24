// What the TradeQuest server sends (see server/routes and docs/world.md §8). The browser only displays these; it never decides
// a price, a fill, a balance, who is in a lobby or who won.

export interface User {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly role: 'player' | 'owner';
}

export interface OverviewRow {
  readonly id: number;
  readonly ticker: string;
  readonly name: string;
  readonly sector: string;
  readonly tier: string;
  readonly trading: boolean;
  /** True while trading in this company is stopped: by the owner, or by the market itself after a big move (then `autoPause` is set). Its price still moves. */
  readonly halted: boolean;
  /** Set while the market has paused trading by itself after a 10 % move in 5 minutes. */
  readonly autoPause: { readonly moveBps: number; readonly reopensInTicks: number } | null;
  readonly listsInTicks: number;
  /** A company a player launched: it can be traded in Career, never in a 1v1 match. */
  readonly launched: boolean;
  /**
   * The money pool behind a coin that was launched with one (null for every other company): the cash in it, and `dead` once its developer took it
   * all (a rug pull): the coin is worthless then and cannot be traded.
   */
  readonly pool: { readonly cents: number; readonly dead: boolean } | null;
  readonly price: number;
  readonly bid: number;
  readonly ask: number;
  readonly spreadBps: number;
  readonly open24h: number;
  readonly changeBps: number;
  readonly high24h: number;
  readonly low24h: number;
  readonly volume24h: number;
  readonly marketCapCents: number;
  readonly liquidity: string;
  readonly mood: string;
}

export interface Overview {
  readonly tick: number;
  readonly ms: number;
  readonly companies: OverviewRow[];
}

export interface CompanyDetail extends OverviewRow {
  readonly description: string;
  readonly industry: string;
  readonly products: readonly string[];
  readonly ceo: string;
  readonly cfo: string;
  readonly hq: string;
  readonly sharesOutstanding: number;
  readonly floatShares: number;
  readonly avgDailyVolume: number;
  readonly liquidityScore: number;
  readonly beta: number;
  readonly listingTick: number;
  /** The price the company started at (cents). The company page counts "2x, 10x since the start" from it. */
  readonly basePriceCents: number;
  readonly listedMs: number;
  readonly turnover24h: number;
  readonly daysOfHistory: number;
}

export interface ServerCandle {
  readonly index: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly ticks?: number;
  readonly complete?: boolean;
}

export type Resolution = 'c10' | 'h1' | 'd1';

export interface BookSide {
  readonly levels: { price: number; size: number; cumulative: number }[];
  readonly total: number;
}
export interface Book {
  readonly bids: BookSide;
  readonly asks: BookSide;
  readonly tick: number;
  /** -1 … 1: players have lately been net buying (> 0: the asks are thinner, the bids thicker) or net selling (< 0: the opposite). */
  readonly pressure: number;
}

export interface Estimate {
  readonly ticker: string;
  readonly side: 'buy' | 'sell';
  /** True when the order is about a short position (a sell opens it, a buy covers it). */
  readonly short: boolean;
  readonly tick: number;
  readonly mid: number;
  readonly bid: number;
  readonly ask: number;
  readonly requestedQty: number;
  readonly filledQty: number;
  readonly unfilledQty: number;
  readonly totalCents: number;
  readonly avgPrice: number;
  readonly firstPrice: number;
  readonly lastPrice: number;
  readonly spreadCostCents: number;
  readonly impactCostCents: number;
  readonly slippageBps: number;
  readonly note: '' | 'depth' | 'limit';
  readonly maxQty: number;
  /** How far this order would push the price (basis points, signed; 0 when trades do not move prices or for a 1v1 match). */
  readonly moveBps: number;
  /** How much more than the book prices the trader pays because of that push (basis points). */
  readonly paidBps: number;
  /** The leverage this estimate was made for (1 for a sell). */
  readonly leverage: number;
  /**
   * What really moves in your cash: a buy or a short sale pays only the margin (the value divided by the leverage); selling a long
   * gives the value minus the debt repaid; covering a short gives back what is left of its collateral.
   */
  readonly netCents: number;
  /**
   * The trading fee of this order (cents) and its rate (basis points of the order's value). Only memecoin orders pay one, so both are 0 for a
   * stock. `netCents` already has it counted in: opening, the margin plus the fee leaves your cash; closing, the fee is taken out of what comes back.
   */
  readonly feeCents: number;
  readonly feeBps: number;
  /** The debt this order takes on (a buy) or repays (a sell). */
  readonly debtCents: number;
  /** A short sale: the money from the sale that stays held on the position until the shares are bought back. */
  readonly creditCents: number;
  /** The market price (cents) at which the market would close the position and the margin would be lost (a long: at or below it; a short: at or above it); 0 without debt. */
  readonly liqPrice: number;
  /** The highest leverage this order may use right now (1 to 50). */
  readonly maxLeverage: number;
  /**
   * What borrowing costs a year (basis points) and about how much that is per day (cents), for the debt (a leveraged buy: interest) or the
   * borrowed sale (a short: the borrow fee) the position would have after this order. 0 when there is nothing borrowed or in a 1v1 match.
   */
  readonly rateBps: number;
  readonly costDayCents: number;
  /** The cash in the money pool behind the coin (null when the company has none), and whether this sale was cut down to what the pool can pay. */
  readonly poolCents: number | null;
  readonly poolLimited: boolean;
}

export interface Position {
  readonly companyId: number;
  readonly ticker: string;
  /** Shares held (long) or owed (short). */
  readonly shares: number;
  /** True for a short position: shares sold without owning them, to be bought back later. */
  readonly short: boolean;
  /** The cash of the player's own in the position (the margin). */
  readonly costCents: number;
  /** The average price per share: what it cost (long) or what it was sold for (short). */
  readonly avgCostCents: number;
  readonly bid: number;
  readonly ask: number;
  /** The price the position is valued at (bid for a long in Career, ask for a short in Career, the market price in a match). */
  readonly markCents: number;
  /** What the shares are worth at the mark price (a short: what buying them back would cost), before any debt. */
  readonly valueCents: number;
  /** What the position owes (0 unless bought with leverage). */
  readonly debtCents: number;
  /** A short: the money from the sale, held on the position (0 for a long). */
  readonly creditCents: number;
  /** What counts towards net worth (never below 0): a long's value minus its debt; a short's collateral minus the cost of buying back. */
  readonly equityCents: number;
  /** How much the position was levered when it was opened (1 = not at all). */
  readonly leverage: number;
  /** The market price (cents) at which the market closes the position: a long at or below it, a short at or above it; 0 for a plain long. */
  readonly liqPrice: number;
  /** The stop-loss and take-profit prices (cents; 0 = not set). */
  readonly stopCents: number;
  readonly takeCents: number;
  readonly unrealizedCents: number;
  /** What borrowing costs a year (basis points): interest on the debt of a leveraged long, the borrow fee on the sale of a short; 0 if nothing is borrowed. */
  readonly rateBps: number;
  /** About what that is per day (cents). */
  readonly costDayCents: number;
  /** All the interest or borrow fee this position has been charged so far (cents). */
  readonly chargedCents: number;
  /** True for shares of a coin whose developer took the money out of its pool: worth nothing, cannot be sold. */
  readonly dead: boolean;
}

export interface Account {
  readonly id: number;
  readonly kind: 'career' | 'match';
  readonly cashCents: number;
  /** Cash that open limit orders have set aside (it is still yours and counts in net worth; 0 in a match). */
  readonly reservedCents: number;
  readonly startCashCents: number;
  readonly positions: Position[];
  readonly netWorthCents: number;
  readonly valuation: 'bid' | 'mid';
  readonly profitCents: number;
  readonly realizedCents: number;
  readonly tick: number;
}

export interface Trade {
  readonly id: number;
  readonly clientOrderId: string;
  readonly ticker: string;
  readonly side: 'buy' | 'sell';
  readonly requested: number;
  readonly filled: number;
  readonly totalCents: number;
  readonly avgPrice: number;
  readonly midCents: number;
  readonly spreadCostCents: number;
  readonly impactCostCents: number;
  readonly realizedCents: number;
  readonly tick: number;
  readonly createdMs: number;
  readonly note: '' | 'depth' | 'limit';
  readonly parts: { price: number; qty: number }[];
  /** The leverage of a buy (1 to 50); 1 for sells and older trades. */
  readonly leverage: number;
  /** The debt this trade took on (a buy) or repaid (a sell or a liquidation). */
  readonly debtCents: number;
  /** True when the market closed the position because the margin was gone. */
  readonly liquidated: boolean;
  /** True for a trade in a short position (selling to open it, buying to cover it). */
  readonly short: boolean;
  /** 'stop' or 'take' when the market made this trade by itself because the position's stop-loss or take-profit price was reached. */
  readonly auto: '' | 'stop' | 'take';
  /** The trading fee this order paid (cents; memecoin orders only). `realizedCents` already has it taken out. */
  readonly feeCents: number;
  /** True when this sale was filled only in part because the money pool behind the coin could not pay for all of it. */
  readonly poolLimited: boolean;
}

/** A position the market closed by itself, pushed to the player's open pages at once. */
export interface PositionNotice {
  /** 'margin_call' is a warning only: the position is still open and has lost three quarters of the cash put into it. */
  readonly reason: 'liquidated' | 'stop' | 'take' | 'margin_call';
  readonly account: 'career' | 'match';
  readonly ticker: string;
  readonly short: boolean;
  readonly shares: number;
  readonly priceCents: number;
  /** What the player made (+) or lost (-) on the cash he put into the position (cents). */
  readonly realizedCents: number;
  readonly tick: number;
  /** A margin call only: how levered the position is and the price at which the market would close it (cents). */
  readonly leverage?: number;
  readonly liqPriceCents?: number;
}

export interface OrderResult {
  readonly duplicate: boolean;
  readonly trade: Trade;
  readonly account: Account;
}

/** A limit order: it waits until the market price reaches its limit (docs/world.md §6.8). */
export interface LimitOrder {
  readonly id: number;
  readonly clientOrderId: string;
  readonly companyId: number;
  readonly ticker: string;
  readonly side: 'buy' | 'sell';
  readonly short: boolean;
  /** buy = open or add to a long, sell = sell a long, short = open or add to a short, cover = buy a short back. */
  readonly kind: 'buy' | 'sell' | 'short' | 'cover';
  readonly qty: number;
  readonly filled: number;
  readonly remaining: number;
  readonly limitCents: number;
  readonly leverage: number;
  readonly stopCents: number;
  readonly takeCents: number;
  /** The cash set aside for it (orders that open a position), cents. */
  readonly reservedCents: number;
  readonly state: 'open' | 'filled' | 'cancelled' | 'expired';
  /** Why it ended without filling (a sentence). */
  readonly reason: string;
  readonly avgFillCents: number | null;
  readonly createdTick: number;
  readonly expiresTick: number;
  readonly createdMs: number;
  readonly closedMs: number | null;
}

export type GoodFor = '1h' | '1d' | '3d';

export interface LimitResult {
  readonly duplicate: boolean;
  readonly order: LimitOrder;
  readonly account: Account;
}

/** What the order form shows before a limit order is placed. */
export interface LimitEstimate {
  readonly tick: number;
  readonly kind: 'buy' | 'sell' | 'short' | 'cover';
  readonly opening: boolean;
  readonly leverage: number;
  readonly bid: number;
  readonly ask: number;
  readonly mid: number;
  readonly valueCents: number;
  /** The cash that would be set aside (0 for an order that closes a position). */
  readonly reserveCents: number;
  /** The trading fee rate of this company, basis points (memecoins). */
  readonly feeBps: number;
  readonly cashCents: number;
  readonly maxQty: number;
  readonly held: number;
  readonly promised: number;
  /** True when the market is already at the limit price: the order would trade at once. */
  readonly fillsNow: boolean;
}

/** Pushed when a limit order filled (all or part of it) or ended. */
export interface LimitNotice {
  readonly what: 'fill' | 'ended';
  readonly order: LimitOrder;
}

export interface NewsItem {
  readonly id: number;
  readonly headline: string;
  readonly body: string;
  readonly category: string;
  readonly categoryLabel: string;
  readonly kind: string;
  readonly direction: 'positive' | 'negative' | 'uncertain';
  readonly strength: 'minor' | 'moderate' | 'major' | 'extreme';
  readonly breaking: boolean;
  readonly scope: string;
  readonly ticker: string | null;
  readonly partnerTicker: string | null;
  readonly sector: string | null;
  readonly sectorName: string | null;
  readonly immediacy: string;
  readonly publishTick: number;
  readonly publishedMs: number;
  readonly outcome: { priceAtPublish: number; priceAtEnd: number; changeBps: number } | null;
}

export interface NewsPage {
  readonly items: NewsItem[];
  readonly next: string | null;
  readonly tick: number;
}

export type Phase = 'waiting' | 'ready_check' | 'countdown' | 'live' | 'settling' | 'finished' | 'cancelled';

export interface MatchPlayer {
  readonly userId: number;
  readonly name: string;
  /** A computer player. */
  readonly bot: boolean;
  readonly ready: boolean;
  readonly you: boolean;
  readonly forfeited: boolean;
  readonly finalValueCents: number | null;
  readonly profitCents: number | null;
  readonly result: 'win' | 'loss' | 'tie' | 'forfeit' | null;
  readonly rewardCents: number | null;
}

export interface Match {
  readonly id: number;
  readonly phase: Phase;
  readonly playerCount: number;
  readonly capacity: 2;
  readonly players: MatchPlayer[];
  readonly message: string;
  readonly startCashCents: number;
  readonly durationTicks: number;
  readonly startTick: number | null;
  readonly endTick: number | null;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly tick: number;
  readonly ticksToStart: number | null;
  readonly ticksLeft: number | null;
  readonly outcome: 'win' | 'tie' | 'forfeit' | 'abandoned' | null;
  readonly winnerUserId: number | null;
  readonly cancelReason: string | null;
  readonly canTrade: boolean;
  /** True for a match between two friends who agreed to play (a challenge). */
  readonly friendMatch: boolean;
}

export interface HistoryEntry {
  readonly matchId: number;
  readonly state: 'finished' | 'cancelled';
  readonly outcome: string | null;
  readonly endedMs: number | null;
  readonly startTick: number | null;
  readonly you: { profitCents: number | null; finalValueCents: number | null; result: string | null; rewardCents: number | null };
  readonly opponent: { name: string | null; bot: boolean; profitCents: number | null; finalValueCents: number | null } | null;
  readonly cancelReason: string | null;
}

export interface Health {
  readonly ok: boolean;
  readonly tick: number;
  readonly clockTick: number;
  readonly lagTicks: number;
  readonly catchingUp: boolean;
  readonly stalled: string | null;
  readonly companies: number;
  readonly listed: number;
  readonly news?: { ok: boolean; items: number; behind: { ticker: string }[]; belowMinimum: string[] } | null;
  /** The owner's message for everybody, if there is one. */
  readonly announcement?: Announcement | null;
  /** Set while the owner has paused ALL trading. */
  readonly paused?: TradingPause | null;
}

export interface Announcement {
  readonly text: string;
  readonly ms: number;
}
export interface TradingPause {
  readonly reason: string;
  readonly sinceMs: number;
}
/** Why a signed-out visitor's old session no longer works: the owner banned that account. */
export interface BanNotice {
  readonly reason: string;
  readonly untilMs: number | null;
}

// ---- the owner's admin panel (only the owner's browser ever asks for these) ---------------------------------------------

export type AdminStyle = 'rug' | 'crash' | 'pump' | 'custom';
export type AdminSpeed = 'instant' | 'fast' | 'slow';

export interface AdminPlayer {
  readonly id: number;
  readonly username: string;
  readonly role: 'player' | 'owner';
  readonly createdMs: number;
  readonly cashCents: number;
  readonly netWorthCents: number;
  readonly coinsCents: number;
  /** The ban in force right now, or null. */
  readonly banned: { reason: string; bannedMs: number; untilMs: number | null } | null;
}

/** A company the owner made. */
export interface OwnStock {
  readonly id: number;
  readonly ticker: string;
  readonly name: string;
  readonly sector: string;
  readonly tier: string;
  readonly personality: string;
  readonly startPriceCents: number;
  readonly createdMs: number;
  /** False while it is saved but not yet running in the market (it then starts after the next server start). */
  readonly loaded: boolean;
  readonly trading: boolean;
  readonly listsInTicks: number;
  readonly priceCents: number;
  readonly halted: boolean;
}

/** What the "Create stock" form offers (the server decides the lists and the limits). */
export interface StockFormOptions {
  readonly sectors: { id: string; name: string }[];
  readonly tiers: { id: string; label: string; note: string }[];
  readonly personalities: { id: string; label: string; note: string }[];
  readonly minPriceCents: number;
  readonly maxPriceCents: number;
  readonly nameMax: number;
  readonly descriptionMax: number;
  readonly listsInSeconds: number;
}

/** What the coin launch form offers (the server decides the limits). */
export interface CoinFormOptions {
  /** What making a coin costs (cents), paid whatever the first buy is. */
  readonly launchFeeCents: number;
  /** The first buy is $0 (none) or from this much (cents) up to `maxSeedCents`. */
  readonly minSeedCents: number;
  readonly maxSeedCents: number;
  /** How many coins a launched coin has once the money is `fullSupplyFromSeedCents` or more: the money sets the market cap, so the starting price is that cap divided by this. */
  readonly supply: number;
  /** The least money that makes a coin with all of those coins; with less, the price stays at `minPriceCents` and there are fewer coins. */
  readonly fullSupplyFromSeedCents: number;
  /** The cheapest a coin can start (cents). */
  readonly minPriceCents: number;
  readonly nameMax: number;
  readonly descriptionMax: number;
  readonly devMax: number;
  readonly listsInSeconds: number;
  readonly ladder: { seedCents: number; priceCents: number; supply: number; sizeLabel: string; marketCapCents: number; liquidityPct: number; typicalMovePct: number; stakeOfBookPct: number; dumpCostPct: number }[];
}

/** What a coin launch would make (the server works it out, so the screen never guesses). */
export interface CoinPreview {
  readonly seedCents: number;
  /** The starting price: the server works it out from the money (the player does not pick it). */
  readonly priceCents: number;
  readonly stakeShares: number;
  /** What the first buy costs (0 with no first buy), the launch fee, and what leaves the cash in all. */
  readonly spentCents: number;
  readonly feeCents: number;
  readonly totalCents: number;
  readonly size: string;
  readonly sizeLabel: string;
  readonly sizeNote: string;
  readonly marketCapCents: number;
  readonly supply: number;
  readonly floatShares: number;
  readonly liquidityPct: number;
  readonly spreadBps: number;
  readonly typicalMovePct: number;
  readonly stakePct: number;
  /** Coins in the whole calm order book, and the stake as a share of it (percent). */
  readonly bookDepthShares: number;
  readonly stakeOfBookPct: number;
  /** Selling the whole stake in one order right after the launch: the share of it the book takes, the cash that comes back, what it costs (percent), how far the price falls (percent), how far the price must rise first to get the money back (percent). */
  readonly dumpFilledPct: number;
  readonly dumpReceiveCents: number;
  readonly dumpCostPct: number;
  readonly dumpPriceDropPct: number;
  readonly breakEvenRisePct: number;
  /** The player's Career cash, and whether it covers {@link totalCents}. */
  readonly cashCents: number;
  readonly enough: boolean;
}

/** What the stock launch form offers (the server decides the limits). */
export interface StockLaunchOptions {
  readonly sectors: { id: string; name: string }[];
  /** What making a stock costs (cents), paid whatever the money is. */
  readonly launchFeeCents: number;
  /** A stock needs a real stake: the money put in is from this much (cents) up to `maxSeedCents`. */
  readonly minSeedCents: number;
  readonly maxSeedCents: number;
  readonly nameMax: number;
  readonly descriptionMax: number;
  readonly listsInSeconds: number;
  readonly tiers: { id: string; label: string; note: string; fromSeedCents: number }[];
  /** What some amounts make: the starting price, the shares bought, the size class. */
  readonly ladder: { seedCents: number; priceCents: number; stakeShares: number; tierLabel: string }[];
}

/** What a stock launch would make (the server works it out, so the screen never guesses). */
export interface StockLaunchPreview {
  readonly seedCents: number;
  /** The starting price: the server works it out from the money (the player does not pick it). */
  readonly priceCents: number;
  readonly stakeShares: number;
  /** What the shares cost, the launch fee, and what leaves the cash in all. */
  readonly spentCents: number;
  readonly feeCents: number;
  readonly totalCents: number;
  readonly tier: string;
  readonly tierLabel: string;
  readonly tierNote: string;
  readonly capLoCents: number;
  readonly capHiCents: number;
  readonly cashCents: number;
  readonly enough: boolean;
}

/** The money pool behind a coin launched with one: what is in it now, what buyers paid in, what sellers took out, what the rug pull took (and `dead` once it did). */
export interface LaunchPool {
  readonly cents: number;
  readonly inCents: number;
  readonly outCents: number;
  readonly drainedCents: number;
  readonly dead: boolean;
}

/** One company the player launched (Launch tab). */
export interface LaunchView {
  readonly companyId: number;
  readonly ticker: string;
  readonly name: string;
  readonly kind: 'stock' | 'coin';
  readonly createdMs: number;
  readonly seedCents: number;
  readonly spentCents: number;
  readonly stakeShares: number;
  /** The launch fee he paid (0 for a stock). */
  readonly feeCents: number;
  readonly priceCents: number;
  readonly listed: boolean;
  readonly listsInSeconds: number;
  readonly halted: boolean;
  readonly sharesNow: number;
  readonly valueNowCents: number;
  readonly priceNowCents: number;
  /** Cash already received from sales plus what is held now, minus what was put in. */
  readonly profitCents: number;
  readonly rugs: number;
  readonly ruggedShares: number;
  readonly ruggedCents: number;
  readonly canRug: boolean;
  readonly blocked: string | null;
  /** The money pool behind a coin launched with one (null for a stock and a coin from before pools). A rug pull of such a coin takes everything in it. */
  readonly pool: LaunchPool | null;
}

export interface LaunchState {
  readonly cashCents: number;
  readonly coinForm: CoinFormOptions;
  readonly stockForm: StockLaunchOptions;
  readonly limits: { activePerKind: number; everPerKind: number };
  readonly counts: { coinActive: number; coinEver: number; stockActive: number; stockEver: number };
  readonly mine: LaunchView[];
}

export interface LaunchResult {
  readonly ok: boolean;
  readonly duplicate: boolean;
  readonly kind: 'stock' | 'coin';
  readonly ticker: string;
  readonly name?: string;
  readonly companyId?: number;
  readonly startsInSeconds?: number;
  readonly loaded?: boolean;
  readonly stakeShares?: number;
  readonly spentCents?: number;
  readonly feeCents?: number;
  readonly priceCents?: number;
  readonly sizeLabel?: string;
  readonly tierLabel?: string;
}

/** The answer to a rug pull of a coin with a money pool: the whole pool became your cash and the coin is dead. */
export interface DrainResult {
  readonly ok: boolean;
  readonly kind: 'drain';
  readonly duplicate: boolean;
  readonly ticker: string;
  readonly name: string;
  readonly takenCents: number;
  readonly paidInCents: number;
  readonly otherHolders: number;
  readonly otherCoins: number;
  readonly ownCoins: number;
}

export interface RugResult {
  readonly ok: boolean;
  readonly kind: 'sale';
  readonly duplicate: boolean;
  readonly ticker: string;
  readonly name: string;
  readonly requested: number;
  readonly filled: number;
  readonly partial: boolean;
  readonly remaining: number;
  readonly receivedCents: number;
  readonly avgPriceCents: number;
  readonly midBeforeCents: number;
  readonly feeCents: number;
  readonly tradeId: number;
}

/** A company a player launched, as the owner sees it. */
export interface AdminLaunch {
  readonly id: number;
  readonly ticker: string;
  readonly name: string;
  readonly kind: 'stock' | 'coin';
  readonly username: string;
  readonly createdMs: number;
  readonly spentCents: number;
  readonly stakeShares: number;
  readonly startPriceCents: number;
  readonly sharesNow: number;
  readonly trading: boolean;
  readonly priceCents: number;
  readonly halted: boolean;
  readonly rugs: number;
  readonly ruggedShares: number;
  readonly ruggedCents: number;
  /** The money pool behind a coin launched with one (null for a stock and a coin from before pools): what is in it, what buyers paid in, what sellers took out, what the rug pull took. */
  readonly pool: LaunchPool | null;
}

export interface AdminState {
  readonly tick: number;
  readonly announcement: Announcement | null;
  readonly paused: TradingPause | null;
  readonly halts: { ticker: string; name: string; reason: string; haltedMs: number; auto: boolean }[];
  readonly events: {
    id: number;
    ticker: string | null;
    headline: string;
    direction: string;
    publishTick: number;
    startTick: number;
    endTick: number;
    priceAtPublish: number | null;
    priceAtEnd: number | null;
  }[];
  readonly players: AdminPlayer[];
  /** Companies the owner made (newest first) and what the form offers. */
  readonly stocks: OwnStock[];
  readonly stockForm: StockFormOptions;
  /** Stocks and memecoins that players launched (newest first). */
  readonly launches: AdminLaunch[];
  readonly log: { id: number; createdMs: number; admin: string; action: string; target: string; detail: Record<string, unknown> }[];
}

// ---- earnings (docs/world.md §7.5) -------------------------------------------------------------------------------------------------

/** A quarterly report that has come out. The numbers are null for an old story written before the numbers existed (kind 'legacy'). */
export interface EarningsReport {
  readonly cycle: number;
  /** "Q3" (empty for a legacy story). */
  readonly label: string;
  readonly newsId: number;
  readonly headline: string;
  readonly publishTick: number;
  readonly publishedMs: number;
  readonly kind: 'beat' | 'miss' | 'inline' | 'epsBeatRevMiss' | 'epsMissRevBeat' | 'legacy';
  /** Profit per share in mills (a thousandth of a dollar) and what analysts expected. */
  readonly epsMills: number | null;
  readonly epsConsMills: number | null;
  /** The surprise against the consensus, basis points. */
  readonly epsBp: number | null;
  readonly revDollars: number | null;
  readonly revConsDollars: number | null;
  readonly revBp: number | null;
  /** Change of profit per share on a year earlier, basis points. */
  readonly yoyBp: number | null;
  /** How the price moved from the story to the end of its effect (basis points); null while it is still moving. */
  readonly reactionBps: number | null;
}

export interface UpcomingReport {
  readonly ticker: string;
  readonly name: string;
  readonly sector: string;
  readonly cycle: number;
  readonly label: string;
  readonly publishTick: number;
  readonly publishedMs: number;
  readonly epsConsMills: number;
  readonly revConsDollars: number;
}

export interface CompanyEarnings {
  readonly tick: number;
  readonly ticker: string;
  readonly name: string;
  /** False for a memecoin (no earnings) and for a company that does not trade yet. */
  readonly applies: boolean;
  readonly periodDays: number;
  readonly epsTtmMills: number | null;
  readonly peRatio: number | null;
  readonly revenueTtmDollars: number | null;
  readonly netMarginBps: number | null;
  readonly next: UpcomingReport | null;
  readonly history: EarningsReport[];
}

export interface EarningsCalendar {
  readonly tick: number;
  readonly hours: number;
  readonly upcoming: UpcomingReport[];
  readonly recent: (EarningsReport & { ticker: string; name: string })[];
}

// ---- players, friends and the leaderboard (server/social.ts, docs/world.md §13) -------------------------------------------------

/** How another player stands to you. */
export type Relation = 'you' | 'friend' | 'outgoing' | 'incoming' | 'none';

/** One line of the player list. `netWorthCents` and `rank` are null for the owner (he is not ranked). */
export interface PlayerEntry {
  readonly username: string;
  readonly displayName: string;
  readonly role: 'player' | 'owner';
  readonly netWorthCents: number | null;
  readonly rank: number | null;
  readonly relation: Relation;
}

export interface PlayerPage {
  readonly players: PlayerEntry[];
  readonly total: number;
  readonly offset: number;
  readonly updatedMs: number;
}

export interface BoardEntry {
  readonly rank: number;
  readonly username: string;
  readonly displayName: string;
  readonly netWorthCents: number;
  readonly relation: Relation;
}

export type BoardScope = 'all' | 'friends';

export interface Leaderboard {
  readonly scope: BoardScope;
  readonly rows: BoardEntry[];
  readonly total: number;
  readonly size: number;
  /** Where the player stands in this view, also outside the top; null when he is not ranked (the owner). */
  readonly me: { readonly rank: number; readonly netWorthCents: number; readonly inTop: boolean } | null;
  readonly updatedMs: number;
}

export interface FriendEntry {
  readonly username: string;
  readonly displayName: string;
  readonly role: 'player' | 'owner';
  readonly netWorthCents: number | null;
  readonly rank: number | null;
  readonly sinceMs: number;
}

export interface FriendsState {
  readonly friends: FriendEntry[];
  /** Requests other players sent to you. */
  readonly incoming: FriendEntry[];
  /** Requests you sent that nobody has answered yet. */
  readonly outgoing: FriendEntry[];
  readonly limits: { readonly maxFriends: number; readonly maxOutgoing: number };
}

export type FriendAction = 'request' | 'accept' | 'decline' | 'cancel' | 'remove';

// ---- friend challenges and the chat ---------------------------------------------------------------------------------------------

/** One open challenge: who the other player is and how long it still can be accepted (as the server said when it answered). */
export interface ChallengeEntry {
  readonly username: string;
  readonly displayName: string;
  readonly sinceMs: number;
  readonly msLeft: number;
}

export interface ChallengesState {
  /** Challenges other players sent to you, newest first. */
  readonly incoming: readonly ChallengeEntry[];
  /** The challenge you sent that nobody has answered yet (at most one). */
  readonly outgoing: readonly ChallengeEntry[];
  readonly limits: { readonly validMs: number };
}

export type ChallengeAction = 'send' | 'accept' | 'decline' | 'cancel';

export interface ChatMessage {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly role: 'player' | 'owner';
  readonly text: string;
  readonly createdMs: number;
}

/** Whether the player can write now, and if not, why and until when (the server's own words are in `message`). */
export interface ChatYou {
  readonly canWrite: boolean;
  readonly reason: 'new_account' | 'muted' | 'banned' | null;
  readonly untilMs: number | null;
  readonly message: string | null;
}

export interface ChatView {
  readonly messages: readonly ChatMessage[];
  readonly more: boolean;
  readonly you: ChatYou;
  readonly limits: { readonly maxLength: number; readonly minGapMs: number };
}

export interface AdminChatReport {
  readonly messageId: number;
  readonly text: string;
  readonly username: string;
  readonly displayName: string;
  readonly createdMs: number;
  readonly reporters: number;
  readonly firstReportedMs: number;
  readonly restriction: 'mute' | 'ban' | null;
}

export interface AdminChatRestriction {
  readonly username: string;
  readonly displayName: string;
  readonly kind: 'mute' | 'ban';
  readonly untilMs: number | null;
  readonly reason: string;
  readonly sinceMs: number;
  readonly by: string;
}

export interface AdminChatView {
  readonly reports: readonly AdminChatReport[];
  readonly restricted: readonly AdminChatRestriction[];
}

// ---- private chats (one player, or a small group of friends) -------------------------------------------------------------------

export interface PmPerson {
  readonly username: string;
  readonly displayName: string;
  readonly role: 'player' | 'owner';
}

export interface PmMessage {
  readonly id: number;
  readonly conversationId: number;
  readonly username: string;
  readonly displayName: string;
  readonly role: 'player' | 'owner';
  readonly text: string;
  readonly createdMs: number;
}

/** Whether the player can write at all right now (a brand-new account cannot yet). */
export interface PmYou {
  readonly canWrite: boolean;
  readonly reason: 'new_account' | null;
  readonly untilMs: number | null;
  readonly message: string | null;
}

export interface PmConversation {
  readonly id: number;
  readonly kind: 'direct' | 'group';
  /** The other player's name (a direct chat) or the name of the group. */
  readonly title: string;
  readonly other: PmPerson | null;
  readonly members: readonly PmPerson[];
  /** Players invited to a group who have not answered. */
  readonly invited: readonly PmPerson[];
  /** The username of the group's creator. */
  readonly creator: string | null;
  readonly last: PmMessage | null;
  readonly lastMs: number;
  readonly unread: number;
  /** Whether the player can write here, and the server's words about it (a request, a block...). */
  readonly canWrite: boolean;
  readonly note: string | null;
  /** 'incoming' = the other player asked to talk and has not been answered; 'waiting' = you asked and nothing more can be sent yet. */
  readonly requestState: 'incoming' | 'waiting' | null;
  readonly friends: boolean;
}

export type PmRequest =
  | { readonly kind: 'message'; readonly conversationId: number; readonly from: PmPerson; readonly text: string; readonly sinceMs: number }
  | { readonly kind: 'invite'; readonly conversationId: number; readonly title: string; readonly from: PmPerson; readonly memberCount: number; readonly sinceMs: number };

export interface PmBlocked {
  readonly username: string;
  readonly displayName: string;
  readonly sinceMs: number;
}

export interface MessagesView {
  readonly conversations: readonly PmConversation[];
  readonly requests: readonly PmRequest[];
  readonly blocked: readonly PmBlocked[];
  readonly unread: number;
  readonly you: PmYou;
  readonly limits: { readonly maxLength: number; readonly minGapMs: number; readonly maxGroupMembers: number; readonly maxGroups: number; readonly maxGroupTitle: number };
}

export interface PmThreadPage {
  readonly conversation: PmConversation;
  readonly messages: readonly PmMessage[];
  readonly more: boolean;
}

export interface PmSendResult {
  readonly conversationId: number;
  readonly message: PmMessage;
  readonly conversation: PmConversation;
  readonly you: PmYou;
}

export interface PrivateReportLine {
  readonly username: string;
  readonly displayName: string;
  readonly text: string;
  readonly createdMs: number;
  readonly reported: boolean;
}

export interface PrivateReport {
  readonly messageId: number;
  readonly kind: 'direct' | 'group' | null;
  readonly groupTitle: string | null;
  readonly author: PmPerson;
  readonly reporters: number;
  readonly firstReportedMs: number;
  readonly lines: readonly PrivateReportLine[];
  readonly authorOpenReports: number;
}

export interface AdminPrivateView {
  readonly reports: readonly PrivateReport[];
}
