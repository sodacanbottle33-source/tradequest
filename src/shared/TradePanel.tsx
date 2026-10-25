// Order entry for the shared market and for 1v1 matches. Before you press the button it asks the server what the order would
// really cost (spread, price impact, whether the book is deep enough); the server decides the fill and the browser only
// shows it. Each order carries an id, so a double click or a retry after a bad connection can never trade twice.
//
// Four ways to trade: Buy (open a long position), Sell (close it), Short (sell shares you do not own, to buy them back cheaper) and
// Cover (buy back a short). Buy and Short can be levered 1x–50x and can carry a stop-loss and a take-profit price; a position that is
// already open can get them (or lose them) below the form.
//
// Career orders are either at the Market (they trade now) or Limit orders: the order waits in the market until the price reaches the limit
// the player typed, then trades at that price or better (docs/world.md §6.8). Cash for a limit order that opens a position is set aside
// when it is placed; the server works that out and the form only shows it.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from './api';
import { formatBps, formatCents, formatCount, formatShares, parsePriceInput, parseQty, priceInput } from './format';
import { GOOD_FOR_CHOICES, describeOrder, limitDirection } from './limitText';
import { OpenOrders } from './OpenOrders';
import { sharedStore, useShared } from './store';
import { celebrateTrade } from './winCelebration';
import type { Account, Estimate, GoodFor, LimitEstimate, LimitResult, OrderResult, Position } from './types';

/** The highest leverage (the server enforces the same number). */
const MAX_LEVERAGE = 50;
/** Quick choices next to the slider. */
const LEVERAGE_CHOICES = [1, 2, 5, 10, 25, 50];

export type Mode = 'buy' | 'sell' | 'short' | 'cover';
const MODES: readonly { mode: Mode; label: string }[] = [
  { mode: 'buy', label: 'Buy' },
  { mode: 'sell', label: 'Sell' },
  { mode: 'short', label: 'Short' },
  { mode: 'cover', label: 'Cover' },
];
const sideOf = (m: Mode): 'buy' | 'sell' => (m === 'buy' || m === 'cover' ? 'buy' : 'sell');
const isShort = (m: Mode): boolean => m === 'short' || m === 'cover';
const opens = (m: Mode): boolean => m === 'buy' || m === 'short';

export type PriceType = 'market' | 'limit';
/** Quick limit-price choices: how far from the price now (a buy waits below the ask, a sell above the bid). */
const LIMIT_CHOICES = [1, 3, 5, 10];

/** Quick stop-loss / take-profit choices, as a change from the current price. A short is the other way round. */
const STOP_CHOICES = [5, 10, 25];
const TAKE_CHOICES = [10, 25, 50];

interface Props {
  ticker: string;
  name: string;
  trading: boolean;
  /** Live bid / ask for the header line. */
  bid: number;
  ask: number;
  account: Account | null;
  kind: 'career' | 'match';
  /** A reason why trading is not possible right now (not signed in, match not live...). */
  blocked: string | null;
  onTraded: (r: OrderResult) => void;
  /** A coin with a money pool (docs/world.md §12.2): plain buying and selling at the market price only, no shorting, leverage, stops or limit orders. */
  spotOnly?: boolean;
  /** A company that went bankrupt (docs/world.md §18.2): nobody can open a position in it any more. Only the closing order is offered (Sell, or Cover for a short), at the price it stopped at. */
  closeOnly?: boolean;
}

function newOrderId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const signed = (cents: number): string => `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${formatCents(Math.abs(cents))}`;

function describeTrade(r: OrderResult): string {
  const t = r.trade;
  const part = t.filled < t.requested ? (t.poolLimited ? ` (the money pool behind ${t.ticker} could pay for only ${formatShares(t.filled)} of the ${formatShares(t.requested)} you asked to sell)` : ` (only ${formatShares(t.filled)} of ${formatShares(t.requested)} shares were available at this depth)`) : '';
  const dup = r.duplicate ? ' (this order had already been placed)' : '';
  const avg = `at an average of ${formatCents(t.avgPrice)} · total ${formatCents(t.totalCents)}`;
  // An order says what its fee was (the profit shown is already after it).
  const fee = t.feeCents > 0 ? ` · fee ${formatCents(t.feeCents)}` : '';
  if (t.short && t.side === 'sell') {
    const margin = t.leverage > 1 ? ` with ${t.leverage}x leverage` : '';
    return `Sold short ${formatShares(t.filled)} ${t.ticker} ${avg}${margin}${fee}. The money from the sale is held on the position until you cover${part}${dup}.`;
  }
  if (t.short) return `Covered ${formatShares(t.filled)} ${t.ticker} ${avg} · ${signed(t.realizedCents)} on this part${fee ? ' after the fee' : ''}${fee}${part}${dup}.`;
  const verb = t.side === 'buy' ? 'Bought' : 'Sold';
  const lev = t.side === 'buy' && t.leverage > 1 ? ` with ${t.leverage}x leverage (your own cash: ${formatCents(t.totalCents - t.debtCents)}, borrowed: ${formatCents(t.debtCents)})` : '';
  const pnl = t.side === 'sell' ? ` · ${signed(t.realizedCents)} on this part${fee ? ' after the fee' : ''}` : '';
  return `${verb} ${formatShares(t.filled)} ${t.ticker} ${avg}${lev}${pnl}${fee}${part}${dup}.`;
}

/** What the player is told when a limit order has been placed (it may also have traded at once). */
function describeLimitResult(r: LimitResult): string {
  const o = r.order;
  const dup = r.duplicate ? ' (this order had already been placed)' : '';
  const done = o.filled > 0 ? ` ${o.filled} of ${o.qty} shares filled already${o.avgFillCents !== null ? ` at an average of ${formatCents(o.avgFillCents)}` : ''}.` : '';
  if (o.state === 'filled') {
    const verb = o.kind === 'buy' ? 'Bought' : o.kind === 'sell' ? 'Sold' : o.kind === 'short' ? 'Sold short' : 'Covered';
    return `Filled at once: ${verb} ${o.filled} ${o.ticker} at an average of ${formatCents(o.avgFillCents ?? 0)}${dup}.`;
  }
  if (o.state !== 'open') return `The order ended: ${o.reason}${done}${dup}`;
  const aside = o.reservedCents > 0 ? ` ${formatCents(o.reservedCents)} of your cash is set aside for it until it fills, ends or you cancel it.` : '';
  return `Limit order placed: ${describeOrder(o)}.${done}${aside}${dup}`;
}

/** The part of a position's own cash that goes with `qty` of its `shares` (rounded down, like the server). */
function costPartOf(costCents: number, qty: number, shares: number): number {
  if (qty >= shares) return costCents;
  return Number((BigInt(costCents) * BigInt(qty)) / BigInt(shares));
}

export function TradePanel({ ticker, name, trading, bid, ask, account, kind, blocked, onTraded, spotOnly = false, closeOnly = false }: Props) {
  const position: Position | undefined = account?.positions.find((p) => p.ticker === ticker);
  const [mode, setMode] = useState<Mode>(position?.short ? 'cover' : closeOnly ? 'sell' : 'buy');
  // A coin with a money pool, or a company that went bankrupt: plain orders only (no leverage, limit orders or stops).
  const plain = spotOnly || closeOnly;
  const [qtyText, setQtyText] = useState('');
  const [leverage, setLeverage] = useState(1);
  const [stopText, setStopText] = useState('');
  const [takeText, setTakeText] = useState('');
  const [priceType, setPriceType] = useState<PriceType>('market');
  const [limitText, setLimitText] = useState('');
  const [goodFor, setGoodFor] = useState<GoodFor>('1d');
  const [limitEstimate, setLimitEstimate] = useState<LimitEstimate | null>(null);
  const [spendText, setSpendText] = useState('');
  const { limits } = useShared();
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const orderId = useRef<{ key: string; id: string } | null>(null);
  const positionRef = useRef(position);
  positionRef.current = position;

  const side = sideOf(mode);
  const short = isShort(mode);
  const opening = opens(mode);
  // Plain digits, or a letter after the number for big amounts (5k, 2m, 1.5b, 1t): a launched coin has a trillion tokens.
  const qty = parseQty(qtyText);
  // Shares held (long) or owed (short) in the part of the position this mode acts on.
  const held = position && position.short === short ? position.shares : 0;
  const stop = parsePriceInput(stopText);
  const take = parsePriceInput(takeText);
  // A limit order is for Career only (a 1v1 match is three minutes of market orders).
  const isLimit = kind === 'career' && priceType === 'limit' && !plain;
  const limit = parsePriceInput(limitText);
  const limitCents = typeof limit === 'number' ? limit : null;
  // Shares of this company that other open limit orders of the same kind have already been promised.
  const promisedHere = limits.filter((o) => o.ticker === ticker && o.short === short && o.side === side).reduce((n, o) => n + o.remaining, 0);

  // Leverage only exists for orders that open a position (Buy, Short); closing is always 1x.
  const lev = opening && !plain ? leverage : 1;

  // Another company or account: start with a clean form (and no leverage: it is chosen again for each new order). A player who is short
  // in this company starts on Cover, because that is the only thing he can do with it besides shorting more.
  useEffect(() => {
    setMode(positionRef.current?.short ? 'cover' : closeOnly ? 'sell' : 'buy');
    setQtyText('');
    setLeverage(1);
    setStopText('');
    setTakeText('');
    setLimitText('');
    setSpendText('');
    // A new company starts as a plain market order: a waiting order is something the player chooses each time.
    setPriceType('market');
    setEstimate(null);
    setLimitEstimate(null);
    setProblem(null);
    setResult(null);
  }, [ticker, kind]);
  // A company that went bankrupt while the page was open: only the closing order is left.
  useEffect(() => {
    if (closeOnly) setMode(positionRef.current?.short ? 'cover' : 'sell');
  }, [closeOnly]);
  // Another way of trading: clear the amounts, keep nothing that belonged to the other way.
  useEffect(() => {
    setQtyText('');
    setLeverage(1);
    setStopText('');
    setTakeText('');
    setLimitText('');
    setSpendText('');
    setEstimate(null);
    setLimitEstimate(null);
    setProblem(null);
    setResult(null);
  }, [mode]);
  // Market or Limit: the amounts stay, the old preview does not.
  useEffect(() => {
    setEstimate(null);
    setLimitEstimate(null);
    setProblem(null);
    setResult(null);
  }, [priceType]);

  // Ask the server what this order would cost (a moment after the player stops typing, and again as the market moves).
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setRefresh((n) => n + 1), 4000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (isLimit || qty === null || qty < 1 || !sharedStore.getSnapshot().user || blocked) {
      setEstimate(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .estimate(ticker, side, qty, kind, lev, short)
        .then((e) => {
          if (!cancelled) {
            setEstimate(e);
            setProblem(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setEstimate(null);
            setProblem(err instanceof Error ? err.message : String(err));
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ticker, side, short, qty, kind, blocked, refresh, lev, isLimit]);

  // The same for a limit order: what it would set aside, the most shares that fit, and whether the price is already there.
  useEffect(() => {
    if (!isLimit || qty === null || qty < 1 || limitCents === null || !sharedStore.getSnapshot().user || blocked) {
      setLimitEstimate(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .limitEstimate(ticker, side, qty, limitCents, lev, short)
        .then((e) => {
          if (!cancelled) {
            setLimitEstimate(e);
            setProblem(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setLimitEstimate(null);
            setProblem(err instanceof Error ? err.message : String(err));
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isLimit, ticker, side, short, qty, limitCents, lev, blocked, refresh]);

  const setMax = async () => {
    try {
      if (!opening) {
        // A limit order can only ask for shares no other open order has been promised.
        setQtyText(String(Math.max(0, isLimit ? held - promisedHere : held)));
        return;
      }
      if (isLimit) {
        if (limitCents === null) {
          setProblem('Enter your limit price first: the most shares depend on it.');
          return;
        }
        const le = await api.limitEstimate(ticker, side, 1, limitCents, lev, short);
        setQtyText(String(Math.max(0, le.maxQty)));
        return;
      }
      const e = await api.estimate(ticker, side, 1, kind, lev, short);
      setQtyText(String(Math.max(0, e.maxQty)));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  // Quick amounts for a coin: a share of your cash (Buy) or of the coins you hold (Sell), or a sum of money to spend. The server works out
  // how many coins that is (fee and rounding included); the form only puts the number in the box.
  const fillBudget = async (budgetCents: number) => {
    try {
      const e = await api.estimate(ticker, 'buy', 1, kind, 1, false, budgetCents);
      setQtyText(String(Math.max(0, e.maxQty)));
      setProblem(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };
  const fillPercent = (pct: number) => {
    if (!opening) {
      setQtyText(String(held > 0 ? Math.max(1, Math.floor((held * pct) / 100)) : 0));
      return;
    }
    void fillBudget(Math.floor(((account?.cashCents ?? 0) * pct) / 100));
  };
  const fillSpend = () => {
    const cents = parsePriceInput(spendText);
    if (typeof cents === 'number') void fillBudget(cents);
    else setProblem('Enter how much to spend in dollars, like 5.00.');
  };

  const exitProblem = opening && (stop === 'bad' || take === 'bad') ? 'A stop-loss or take-profit must be a price in dollars, like 12.50.' : null;
  const limitProblem = isLimit && limit === 'bad' ? 'The limit price must be a price in dollars, like 12.50.' : null;
  const needLimit = isLimit && limitCents === null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || qty === null || qty < 1 || exitProblem || limitProblem || needLimit) return;
    const stopPrice = opening && typeof stop === 'number' ? stop : undefined;
    const takePrice = opening && typeof take === 'number' ? take : undefined;
    const key = `${kind}:${ticker}:${mode}:${isLimit ? `L${limitCents}:${goodFor}` : 'M'}:${qty}:${lev}:${stopPrice ?? ''}:${takePrice ?? ''}`;
    // Pressing again with the same order (for example after a lost connection) re-sends the same id: it can only trade once.
    if (orderId.current?.key !== key) orderId.current = { key, id: newOrderId() };
    setBusy(true);
    setProblem(null);
    setResult(null);
    try {
      if (isLimit && limitCents !== null) {
        const placed = await api.placeLimit({
          ticker,
          side,
          qty,
          limitPrice: limitCents,
          clientOrderId: orderId.current.id,
          goodFor,
          ...(lev > 1 ? { leverage: lev } : {}),
          ...(short ? { short: true } : {}),
          ...(stopPrice !== undefined ? { stopPrice } : {}),
          ...(takePrice !== undefined ? { takePrice } : {}),
        });
        orderId.current = null;
        setResult(describeLimitResult(placed));
        setQtyText('');
        setStopText('');
        setTakeText('');
        setLimitEstimate(null);
        void sharedStore.refreshAccount();
        return;
      }
      const r = await api.order({
        account: kind,
        ticker,
        side,
        qty,
        clientOrderId: orderId.current.id,
        ...(lev > 1 ? { leverage: lev } : {}),
        ...(short ? { short: true } : {}),
        ...(stopPrice !== undefined ? { stopPrice } : {}),
        ...(takePrice !== undefined ? { takePrice } : {}),
      });
      orderId.current = null;
      setResult(describeTrade(r));
      // A good win on your own Career money gets confetti (a 1v1 match is only three minutes of trading: no party there).
      if (kind === 'career') celebrateTrade(r);
      setQtyText('');
      setStopText('');
      setTakeText('');
      setEstimate(null);
      onTraded(r);
    } catch (err) {
      if (err instanceof ApiError) {
        const max = err.details.maxQty;
        setProblem(typeof max === 'number' ? `${err.message} You can ${short ? 'short' : 'afford'} up to ${formatShares(max)} shares.` : err.message);
        // The server said no: that order id is finished, a new attempt is a new order.
        if (err.status !== 0) orderId.current = null;
      } else {
        setProblem(String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const disabled = blocked !== null || !trading;
  const cash = account?.cashCents ?? 0;
  // What really leaves your cash (Buy / Short: only the margin) or arrives in it (Sell: the proceeds minus the debt; Cover: what is left of the collateral).
  const cashAfter = estimate ? (opening ? cash - estimate.netCents : cash + estimate.netCents) : null;
  const levered = opening && lev > 1;
  const liqGap = estimate && estimate.liqPrice > 0 && estimate.mid > 0 ? (Math.abs(estimate.liqPrice - estimate.mid) / estimate.mid) * 100 : null;
  const refPrice = bid > 0 && ask > 0 ? Math.round((bid + ask) / 2) : Math.max(bid, ask);
  // The kind of position this order would open: stops and takes are on opposite sides for a long and a short.
  const stopSign = short ? 1 : -1;
  const takeSign = short ? -1 : 1;
  // A limit order's stop-loss and take-profit are counted from its limit price (that is the price it will trade at); other orders from the price now.
  const chipBase = isLimit && limitCents !== null ? limitCents : refPrice;
  const chipPrice = (pct: number, sign: number): string => priceInput(Math.max(100, Math.round(chipBase * (1 + (sign * pct) / 100))));
  // Quick limit prices: a buy waits below the ask, a sell above the bid.
  const limitBase = side === 'buy' ? ask : bid;
  const limitChip = (pct: number): string => priceInput(Math.max(100, Math.round(limitBase * (1 + ((side === 'buy' ? -1 : 1) * pct) / 100))));
  const limitWord = limitDirection(mode);
  const conflict = opening && position && position.short !== short;
  const label = MODES.find((m) => m.mode === mode)?.label ?? 'Buy';
  const buttonText = busy
    ? 'Sending…'
    : isLimit
      ? `Place limit ${mode}${levered ? ` ${lev}x` : ''} order`
      : mode === 'buy'
      ? levered ? `Buy ${lev}x at market` : 'Buy at market'
      : mode === 'sell'
        ? 'Sell at market'
        : mode === 'short'
          ? levered ? `Short ${lev}x at market` : 'Short at market'
          : 'Cover at market';
  const costPart = position && !opening && qty !== null ? costPartOf(position.costCents, Math.min(qty, position.shares), position.shares) : 0;
  const closingResult = estimate && !opening && position ? estimate.netCents - costPart : null;

  return (
    <section className="card order trade-panel" aria-label="Order entry">
      <h2>
        Trade · <span className="order-ticker">{ticker}</span> <span className="h2-note">{kind === 'match' ? '· match account' : '· Career account'}</span>
      </h2>
      <div className="quote-line" title={`${name}: the price you would pay (ask) or receive (bid) for the first share`}>
        <span>
          Bid <strong>{bid > 0 ? formatCents(bid) : '—'}</strong>
        </span>
        <span>
          Ask <strong>{ask > 0 ? formatCents(ask) : '—'}</strong>
        </span>
        {account && (
          <span>
            Cash <strong data-testid="cash">{formatCents(account.cashCents)}</strong>
          </span>
        )}
        {account && (
          <span>
            {position?.short ? 'Short' : 'Held'} <strong data-testid="held">{formatShares(position?.shares ?? 0)}</strong>
          </span>
        )}
      </div>
      {blocked && <p className="notice info">{blocked}</p>}
      {!trading && <p className="notice info">This company is not trading yet.</p>}
      <form onSubmit={submit}>
        <fieldset disabled={disabled} className="order-fields">
          <div className={plain ? 'segmented' : 'segmented four'} role="group" aria-label="Order type">
            {MODES.filter((m) => (closeOnly ? m.mode === (position?.short ? 'cover' : 'sell') : !spotOnly || m.mode === 'buy' || m.mode === 'sell')).map((m) => (
              <button
                key={m.mode}
                type="button"
                className={mode === m.mode ? `seg active ${m.mode}` : 'seg'}
                onClick={() => setMode(m.mode)}
                data-testid={`mode-${m.mode}`}
                aria-pressed={mode === m.mode}
              >
                {m.label}
              </button>
            ))}
          </div>
          {spotOnly && (
            <p className="hint" data-testid="pool-hint">
              {ticker} has a money pool: what buyers pay goes into it and a sale is paid out of it
              {estimate?.poolCents != null ? ` (it holds ${formatCents(estimate.poolCents)} now)` : ''}. Its developer can take all of it and kill the coin. Plain buying and selling at the market price only: no shorting, leverage, stop-loss or limit orders.
            </p>
          )}
          {kind === 'career' && !plain && (
            <div className="segmented" role="group" aria-label="Price type">
              {(['market', 'limit'] as const).map((t) => (
                <button key={t} type="button" className={priceType === t ? 'seg active price-type' : 'seg'} onClick={() => setPriceType(t)} data-testid={`type-${t}`} aria-pressed={priceType === t}>
                  {t === 'market' ? 'Market' : 'Limit'}
                </button>
              ))}
            </div>
          )}
          {isLimit && (
            <p className="hint" data-testid="limit-hint">
              {opening
                ? `A limit order waits in the market until the price reaches your limit, then trades at that price or better (${mode === 'buy' ? 'a buy: your price or lower' : 'a short sale: your price or higher'}). The most it could cost is set aside from your cash until it fills, ends or you cancel it.`
                : `A limit order waits in the market until the price reaches your limit, then trades at that price or better (${mode === 'sell' ? 'a sale: your price or higher' : 'buying back: your price or lower'}). The shares stay yours, but are promised to this order.`}
            </p>
          )}
          {mode === 'short' && !conflict && (
            <p className="hint" data-testid="short-hint">
              Short: sell shares you do not own. You win if the price falls (buy them back cheaper) and lose if it rises.
            </p>
          )}
          {conflict && (
            <p className="notice warn" role="status" data-testid="position-conflict">
              {position?.short
                ? `You are short ${position.shares} shares of ${ticker}. Cover them first (the Cover tab) before you buy.`
                : `You hold ${position?.shares} shares of ${ticker}. Sell them first (the Sell tab) before you short it.`}
            </p>
          )}
          {!opening && held === 0 && !conflict && (
            <p className="notice info" data-testid="nothing-to-close">
              {mode === 'sell'
                ? position?.short
                  ? `You are short ${ticker}. Use Cover to buy the shares back.`
                  : `You hold no shares of ${ticker}.`
                : position && !position.short
                  ? `You hold ${ticker} shares. Use Sell to sell them.`
                  : `You are not short ${ticker}.`}
            </p>
          )}
          {opening && !plain && (
            <div className="leverage-box" data-testid={`leverage-${kind}`}>
              <div className="leverage-head">
                <label htmlFor={`lev-${kind}`}>Leverage</label>
                <strong className="leverage-value" data-testid={`leverage-value-${kind}`}>
                  {lev === 1 ? 'none (1x)' : `${lev}x`}
                </strong>
              </div>
              <input
                id={`lev-${kind}`}
                className="leverage-slider"
                type="range"
                min={1}
                max={MAX_LEVERAGE}
                step={1}
                value={lev}
                onChange={(e) => setLeverage(Number(e.target.value))}
                data-testid={`leverage-slider-${kind}`}
              />
              <div className="leverage-choices" role="group" aria-label="Leverage choices">
                {LEVERAGE_CHOICES.map((n) => (
                  <button key={n} type="button" className={lev === n ? 'lev-chip active' : 'lev-chip'} onClick={() => setLeverage(n)} data-testid={`leverage-${kind}-${n}`}>
                    {n}x
                  </button>
                ))}
              </div>
            </div>
          )}
          {isLimit && (
            <div className="limit-box" data-testid={`limit-box-${kind}`}>
              <div className="exits-row">
                <label htmlFor={`limit-${kind}`}>Limit price</label>
                <input
                  id={`limit-${kind}`}
                  className="price-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="12.50"
                  value={limitText}
                  onChange={(e) => setLimitText(e.target.value)}
                  data-testid={`limit-price-${kind}`}
                />
                <button type="button" className="lev-chip" onClick={() => setLimitText(priceInput(limitBase))} disabled={limitBase <= 0} title={`The ${side === 'buy' ? 'ask' : 'bid'} now`} data-testid={`limit-now-${kind}`}>
                  Now
                </button>
                {LIMIT_CHOICES.map((p) => (
                  <button key={p} type="button" className="lev-chip" onClick={() => setLimitText(limitChip(p))} disabled={limitBase <= 0} data-testid={`limit-chip-${kind}-${p}`}>
                    {side === 'buy' ? '−' : '+'}
                    {p}%
                  </button>
                ))}
              </div>
              <div className="exits-row">
                <label htmlFor={`goodfor-${kind}`}>Good for</label>
                <select id={`goodfor-${kind}`} className="price-input good-for" value={goodFor} onChange={(e) => setGoodFor(e.target.value as GoodFor)} data-testid={`goodfor-${kind}`}>
                  {GOOD_FOR_CHOICES.map((g) => (
                    <option key={g.value} value={g.value}>
                      {g.label}
                    </option>
                  ))}
                </select>
                <span className="muted">then it ends by itself</span>
              </div>
            </div>
          )}
          <label className="qty-label" htmlFor={`qty-${kind}`}>
            Shares of {ticker}
          </label>
          <div className="qty-row">
            <input
              id={`qty-${kind}`}
              className="qty-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="0"
              value={qtyText}
              onChange={(e) => setQtyText(e.target.value)}
              data-testid={`qty-${kind}`}
            />
            <button type="button" className="btn btn-small" onClick={() => void setMax()}>
              Max
            </button>
          </div>
          {plain && (
            <div className="exits-row" data-testid={`quick-qty-${kind}`}>
              {[25, 50, 75, 100].map((p) => (
                <button key={p} type="button" className="lev-chip" onClick={() => fillPercent(p)} data-testid={`pct-${kind}-${p}`} title={opening ? `${p}% of your cash` : `${p}% of the coins you hold`}>
                  {p}%
                </button>
              ))}
            </div>
          )}
          {plain && opening && (
            <div className="exits-row">
              <label htmlFor={`spend-${kind}`}>Or spend $</label>
              <input
                id={`spend-${kind}`}
                className="price-input"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="5.00"
                value={spendText}
                onChange={(e) => setSpendText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    fillSpend();
                  }
                }}
                data-testid={`spend-${kind}`}
              />
              <button type="button" className="lev-chip" onClick={fillSpend} data-testid={`spend-fill-${kind}`}>
                Fill
              </button>
            </div>
          )}

          {opening && !plain && (
            <div className="exits-box" data-testid={`exits-new-${kind}`}>
              <div className="exits-row">
                <label htmlFor={`stop-${kind}`}>Stop-loss</label>
                <input
                  id={`stop-${kind}`}
                  className="price-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="none"
                  value={stopText}
                  onChange={(e) => setStopText(e.target.value)}
                  data-testid={`stop-${kind}`}
                />
                {STOP_CHOICES.map((p) => (
                  <button key={p} type="button" className="lev-chip" onClick={() => setStopText(chipPrice(p, stopSign))} disabled={refPrice <= 0}>
                    {short ? '+' : '−'}
                    {p}%
                  </button>
                ))}
              </div>
              <div className="exits-row">
                <label htmlFor={`take-${kind}`}>Take-profit</label>
                <input
                  id={`take-${kind}`}
                  className="price-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="none"
                  value={takeText}
                  onChange={(e) => setTakeText(e.target.value)}
                  data-testid={`take-${kind}`}
                />
                {TAKE_CHOICES.map((p) => (
                  <button key={p} type="button" className="lev-chip" onClick={() => setTakeText(chipPrice(p, takeSign))} disabled={refPrice <= 0}>
                    {short ? '−' : '+'}
                    {p}%
                  </button>
                ))}
              </div>
              <p className="hint">
                Optional. The market closes the whole position by itself when the price reaches them: the stop-loss when it moves {short ? 'up' : 'down'} against you, the take-profit when it moves {short ? 'down' : 'up'} in your favour.
              </p>
            </div>
          )}

          {qtyText !== '' && qty === null && <p className="notice error">{spotOnly ? 'Enter a whole number of coins. For big amounts you can write 5k, 2m, 1.5b or 1t.' : 'Enter a whole number of shares.'}</p>}
          {exitProblem && <p className="notice error">{exitProblem}</p>}
          {limitProblem && <p className="notice error">{limitProblem}</p>}
          {isLimit && qty !== null && qty >= 1 && limitCents === null && limit !== 'bad' && <p className="hint">Enter your limit price to see what the order would set aside.</p>}
          {isLimit && limitEstimate && (
            <dl className="estimate-box" data-testid="limit-estimate">
              <div>
                <dt>{opening ? (mode === 'buy' ? 'Costs at most' : 'Sale brings at least') : mode === 'sell' ? 'Sale brings at least' : 'Buying back costs at most'}</dt>
                <dd>
                  <strong data-testid="limit-total">{formatCents(limitEstimate.valueCents)}</strong> for {formatCount(qty ?? 0)} shares at {formatCents(limitCents ?? 0)} or {limitWord}
                </dd>
              </div>
              {opening && (
                <div data-testid="limit-reserve-row">
                  <dt>Set aside now</dt>
                  <dd>
                    <strong data-testid="limit-reserve">{formatCents(limitEstimate.reserveCents)}</strong>{' '}
                    <span className="muted">
                      {lev > 1 ? `margin at ${lev}x` : 'of your cash'}
                      {limitEstimate.feeBps > 0 ? `, with the ${(limitEstimate.feeBps / 100).toFixed(2)}% fee` : ''}
                    </span>
                  </dd>
                </div>
              )}
              {opening && (
                <div>
                  <dt>Cash afterwards</dt>
                  <dd data-testid="limit-cash-after">{formatCents(limitEstimate.cashCents - limitEstimate.reserveCents)}</dd>
                </div>
              )}
              {!opening && (
                <div data-testid="limit-promise-row">
                  <dt>Shares promised to it</dt>
                  <dd>
                    {formatCount(qty ?? 0)} of the {formatCount(limitEstimate.held)} you {short ? 'are short' : 'hold'}
                    {limitEstimate.promised > 0 ? <span className="muted"> ({formatCount(limitEstimate.promised)} already promised to other orders)</span> : null}
                  </dd>
                </div>
              )}
              <div data-testid="limit-when">
                <dt>It trades</dt>
                <dd>
                  {limitEstimate.fillsNow ? (
                    <strong>Right away: the price is already there.</strong>
                  ) : (
                    <>
                      when the {side === 'buy' ? 'ask' : 'bid'} {side === 'buy' ? 'falls' : 'rises'} to {formatCents(limitCents ?? 0)}{' '}
                      <span className="muted">
                        (now {formatCents(side === 'buy' ? limitEstimate.ask : limitEstimate.bid)})
                      </span>
                    </>
                  )}
                </dd>
              </div>
            </dl>
          )}
          {isLimit && limitEstimate && limitEstimate.fillsNow && (
            <p className="notice info" role="status" data-testid="limit-fills-now">
              The market is already at your price, so this order trades at once, like a market order that never pays {side === 'buy' ? 'more' : 'less'} than {formatCents(limitCents ?? 0)}.
              If the book is thin at that price, the rest keeps waiting.
            </p>
          )}
          {isLimit && limitEstimate && opening && limitEstimate.reserveCents > limitEstimate.cashCents && (
            <p className="notice error" role="alert" data-testid="limit-too-dear">
              Setting aside {formatCents(limitEstimate.reserveCents)} for this order is more than your cash ({formatCents(limitEstimate.cashCents)}). At this price you can place up to {formatCount(limitEstimate.maxQty)} shares
              {levered ? ` at ${lev}x` : ''}.
            </p>
          )}
          {isLimit && limitEstimate && !opening && qty !== null && qty > limitEstimate.maxQty && (
            <p className="notice error" role="alert" data-testid="limit-too-many">
              {limitEstimate.held === 0
                ? `You ${short ? 'are not short' : 'hold no shares of'} ${ticker}.`
                : `You ${short ? 'are short' : 'hold'} ${formatCount(limitEstimate.held)} shares of ${ticker}${limitEstimate.promised > 0 ? `, and ${formatCount(limitEstimate.promised)} of them are already promised to other open orders` : ''}: ask for up to ${formatCount(limitEstimate.maxQty)}.`}
            </p>
          )}
          {isLimit && limitEstimate && levered && lev >= 10 && (
            <p className="notice info" data-testid="leverage-warning">
              With {lev}x {short ? 'a rise' : 'a fall'} of about {(100 / lev).toFixed(lev > 20 ? 1 : 0)}% after it fills closes the position and you lose the margin. Nothing worse than that can happen: you never owe more than the margin.
            </p>
          )}
          {estimate && (
            <dl className="estimate-box" data-testid="estimate">
              <div>
                <dt>{mode === 'buy' ? (levered ? 'Order value' : 'You would pay') : mode === 'sell' ? 'You would receive' : mode === 'short' ? 'Sale value' : 'Buying back costs'}</dt>
                <dd>
                  <strong data-testid="estimate-total">{formatCents(estimate.totalCents)}</strong> for {formatCount(estimate.filledQty)} shares
                </dd>
              </div>
              {mode === 'buy' && levered && (
                <div data-testid="estimate-margin-row">
                  <dt>Your own cash (margin)</dt>
                  <dd>
                    <strong data-testid="estimate-margin">{formatCents(estimate.netCents - estimate.feeCents)}</strong> <span className="muted">+ {formatCents(estimate.debtCents)} borrowed</span>
                  </dd>
                </div>
              )}
              {mode === 'short' && (
                <div data-testid="estimate-margin-row">
                  <dt>Your own cash (margin)</dt>
                  <dd>
                    <strong data-testid="estimate-margin">{formatCents(estimate.netCents - estimate.feeCents)}</strong>{' '}
                    <span className="muted">+ {formatCents(estimate.creditCents)} from the sale, held until you cover</span>
                  </dd>
                </div>
              )}
              {estimate.feeBps > 0 && (
                <div data-testid="estimate-fee">
                  <dt>Trading fee ({(estimate.feeBps / 100).toFixed(2)}% of the order value)</dt>
                  <dd>
                    <strong>{formatCents(estimate.feeCents)}</strong>{' '}
                    <span className="muted">{opening ? 'paid on top, from your cash' : 'taken out of what comes back'}</span>
                  </dd>
                </div>
              )}
              {estimate.feeBps > 0 && opening && (
                <div data-testid="estimate-from-cash">
                  <dt>Leaves your cash in total</dt>
                  <dd>
                    <strong>{formatCents(estimate.netCents)}</strong>
                  </dd>
                </div>
              )}
              {estimate.feeBps > 0 && mode === 'sell' && estimate.debtCents === 0 && (
                <div data-testid="estimate-to-cash">
                  <dt>Comes to your cash, after the fee</dt>
                  <dd>
                    <strong>{formatCents(estimate.netCents)}</strong>
                  </dd>
                </div>
              )}
              {opening && estimate.liqPrice > 0 && (levered || mode === 'short') && (
                <div data-testid="estimate-liq">
                  <dt>Closed by the market at</dt>
                  <dd>
                    <strong>{formatCents(estimate.liqPrice)}</strong> or {short ? 'higher' : 'lower'}{' '}
                    {liqGap !== null && (
                      <span className="muted">
                        ({liqGap.toFixed(liqGap < 10 ? 2 : 1)}% {short ? 'above' : 'below'} now)
                      </span>
                    )}
                  </dd>
                </div>
              )}
              {opening && estimate.rateBps > 0 && (levered || mode === 'short') && (
                <div data-testid="estimate-cost">
                  <dt>{short ? 'Borrow fee' : 'Interest on the debt'}</dt>
                  <dd>
                    <strong>{(estimate.rateBps / 100).toFixed(estimate.rateBps % 100 === 0 ? 0 : 1)}% a year</strong>{' '}
                    <span className="muted">≈ {formatCents(estimate.costDayCents)} a day, taken from the position</span>
                  </dd>
                </div>
              )}
              {mode === 'sell' && estimate.debtCents > 0 && (
                <div data-testid="estimate-repay">
                  <dt>Debt repaid out of that</dt>
                  <dd>
                    {formatCents(estimate.debtCents)} <span className="muted">→ you keep {formatCents(estimate.netCents)}</span>
                  </dd>
                </div>
              )}
              {mode === 'cover' && (
                <div data-testid="estimate-cover">
                  <dt>Comes back to your cash</dt>
                  <dd>
                    <strong>{formatCents(estimate.netCents)}</strong> <span className="muted">(what is left of the collateral{estimate.feeBps > 0 ? ', after the fee' : ''})</span>
                  </dd>
                </div>
              )}
              {closingResult !== null && (
                <div data-testid="estimate-result">
                  <dt>Profit or loss on this part</dt>
                  <dd>
                    <strong className={closingResult > 0 ? 'pos' : closingResult < 0 ? 'neg' : ''}>{signed(closingResult)}</strong>
                  </dd>
                </div>
              )}
              <div>
                <dt>Average price</dt>
                <dd>
                  {formatCents(estimate.avgPrice)} <span className="muted">(first {formatCents(estimate.firstPrice)} → last {formatCents(estimate.lastPrice)})</span>
                </dd>
              </div>
              <div>
                <dt>Spread cost · price impact</dt>
                <dd>
                  {formatCents(estimate.spreadCostCents)} · {formatCents(estimate.impactCostCents)} <span className="muted">(slippage {formatBps(estimate.slippageBps)})</span>
                </dd>
              </div>
              {estimate.moveBps !== 0 && (
                <div data-testid="estimate-move">
                  <dt>Effect on the price</dt>
                  <dd>
                    {estimate.moveBps > 0 ? 'pushes it up' : 'pushes it down'} about <strong>{formatBps(estimate.moveBps)}</strong> for everyone{' '}
                    <span className="muted">(you pay about {formatBps(estimate.paidBps)} extra for that)</span>
                  </dd>
                </div>
              )}
              {cashAfter !== null && (
                <div>
                  <dt>Cash afterwards</dt>
                  <dd>{formatCents(cashAfter)}</dd>
                </div>
              )}
            </dl>
          )}
          {estimate && estimate.unfilledQty > 0 && (
            <p className="notice warn" role="status">
              {estimate.poolLimited
                ? `The money pool behind ${ticker} holds only ${formatCents(estimate.poolCents ?? 0)}, so only ${formatCount(estimate.filledQty)} of the ${formatCount(estimate.requestedQty)} ${ticker} you want to sell can be paid for now. The rest would not be sold.`
                : estimate.note === 'limit'
                ? 'Only part of this order would fill at your price limit.'
                : `Not enough shares are on offer at this depth: only ${formatCount(estimate.filledQty)} of ${formatCount(estimate.requestedQty)} would fill. The rest would be cancelled.`}
            </p>
          )}
          {estimate && opening && lev > 1 && lev > estimate.maxLeverage && (
            <p className="notice warn" role="status" data-testid="leverage-too-high">
              {estimate.maxLeverage > 1
                ? `At ${lev}x the cost of opening this order is too big for its margin. The most for this order is ${estimate.maxLeverage}x; the server would refuse ${lev}x.`
                : 'The cost of opening this order is too big for any leverage: use 1x or a smaller order.'}
            </p>
          )}
          {estimate && levered && lev >= 10 && (
            <p className="notice info" data-testid="leverage-warning">
              With {lev}x {short ? 'a rise' : 'a fall'} of about {(100 / lev).toFixed(lev > 20 ? 1 : 0)}% closes the position and you lose the margin. Nothing worse than that can happen: you never owe more than the margin.
            </p>
          )}
          {estimate && opening && account && estimate.netCents > account.cashCents && (
            <p className="notice error" role="alert">
              {levered || short ? `The margin${estimate.feeCents > 0 ? ' and fee come to' : ' is'} ${formatCents(estimate.netCents)}, more than your cash` : `That costs more than your cash`} ({formatCents(account.cashCents)}). You can {short ? 'short' : 'afford'} up to {formatCount(estimate.maxQty)} shares
              {levered ? ` at ${lev}x` : ''}.
            </p>
          )}
          {estimate && !opening && qty !== null && qty > held && held > 0 && (
            <p className="notice error" role="alert">
              You {short ? 'are short' : 'only hold'} {held} share{held === 1 ? '' : 's'} of {ticker}.
            </p>
          )}
          {problem && (
            <p className="notice error" role="alert" data-testid="order-problem">
              {problem}
            </p>
          )}
          {result && (
            <p className="notice ok" role="status" data-testid="order-result">
              {result}
            </p>
          )}
          <button
            type="submit"
            className={`btn btn-wide ${mode === 'buy' || mode === 'cover' ? 'btn-buy' : 'btn-sell'}`}
            disabled={busy || qty === null || qty < 1 || exitProblem !== null || limitProblem !== null || needLimit}
            data-testid={`submit-${kind}`}
            aria-label={`${label} order`}
          >
            {buttonText}
          </button>
          {isLimit ? (
            <p className="hint" data-testid="limit-footer-hint">
              A limit order never trades at a worse price than your limit, but it may never trade at all if the price does not get there; it ends by itself when its time is up. It pays the same spread and fee, and
              moves the price like any other order when it trades. You can have up to 20 open orders; cancel one from the list below or on the My account tab.
            </p>
          ) : (
            <p className="hint">
              Market orders buy from the asks and sell to the bids. Big orders move the price against you; thin stocks may only fill
              partly. The server works out the real fill when it receives the order.
            </p>
          )}
          {estimate && estimate.feeBps > 0 && (
            <p className="hint" data-testid="fee-hint">
              Trading {ticker} costs a fee of {(estimate.feeBps / 100).toFixed(2)}% of the order&apos;s value on every buy, sell, short and cover, and when a
              stop-loss or take-profit closes the position (memecoins pay 0.5%, stocks 0.1%, and a 1v1 match has no fee). The market closing a wiped-out
              position has no fee.
            </p>
          )}
          {!plain && (
            <p className="hint">
              Leverage (Buy and Short): you put in a part of the order&apos;s value (the margin) and the rest is borrowed (Buy) or held from the
              sale (Short). Borrowing costs a little every day (interest on the debt, a borrow fee on a short sale), taken from the position. When
              the price moves so far against you that the margin is gone, the market closes the position and the margin is lost — never more than
              the margin.
            </p>
          )}
        </fieldset>
      </form>
      {kind === 'career' && limits.some((o) => o.ticker === ticker) && (
        <div className="exits-box open-orders-box" data-testid="open-orders-here">
          <h3>Your open limit orders in {ticker}</h3>
          <OpenOrders orders={limits.filter((o) => o.ticker === ticker)} showCompany={false} />
        </div>
      )}
      {position && !disabled && account && !plain && <ExitsEditor key={`${kind}:${ticker}:${position.short ? 's' : 'l'}`} position={position} kind={kind} onSaved={() => void sharedStore.refreshAccount()} />}
    </section>
  );
}

/** Changes the stop-loss and take-profit of a position that is already open. An empty box removes the price. */
function ExitsEditor({ position, kind, onSaved }: { position: Position; kind: 'career' | 'match'; onSaved: () => void }) {
  const [stopText, setStopText] = useState(priceInput(position.stopCents));
  const [takeText, setTakeText] = useState(priceInput(position.takeCents));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // When the server changed them (the market closed part of it, another page edited them) show what it has.
  useEffect(() => {
    setStopText(priceInput(position.stopCents));
    setTakeText(priceInput(position.takeCents));
  }, [position.stopCents, position.takeCents]);

  const stop = parsePriceInput(stopText);
  const take = parsePriceInput(takeText);
  const bad = stop === 'bad' || take === 'bad';
  const changed = (stop === null ? 0 : stop === 'bad' ? -1 : stop) !== position.stopCents || (take === null ? 0 : take === 'bad' ? -1 : take) !== position.takeCents;

  const save = async () => {
    if (busy || bad) return;
    setBusy(true);
    setProblem(null);
    setSaved(null);
    try {
      await api.exits({ account: kind, ticker: position.ticker, stopPrice: stop as number | null, takePrice: take as number | null });
      setSaved('Saved.');
      onSaved();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="exits-box exits-edit" data-testid={`exits-edit-${kind}`}>
      <h3>
        Your {position.short ? 'short' : 'long'} position · stop-loss and take-profit
      </h3>
      <div className="exits-row">
        <label htmlFor={`edit-stop-${kind}`}>Stop-loss</label>
        <input id={`edit-stop-${kind}`} className="price-input" type="text" inputMode="decimal" autoComplete="off" placeholder="none" value={stopText} onChange={(e) => setStopText(e.target.value)} data-testid={`edit-stop-${kind}`} />
      </div>
      <div className="exits-row">
        <label htmlFor={`edit-take-${kind}`}>Take-profit</label>
        <input id={`edit-take-${kind}`} className="price-input" type="text" inputMode="decimal" autoComplete="off" placeholder="none" value={takeText} onChange={(e) => setTakeText(e.target.value)} data-testid={`edit-take-${kind}`} />
      </div>
      <p className="hint">
        A {position.short ? 'short' : 'long'} position is stopped when the price goes {position.short ? 'up' : 'down'} to the stop-loss and taken when it goes {position.short ? 'down' : 'up'} to the take-profit. Leave a box empty for none.
        {position.liqPrice > 0 && ` The market closes it anyway at ${formatCents(position.liqPrice)} ${position.short ? 'or higher' : 'or lower'}.`}
      </p>
      {bad && <p className="notice error">A price must be in dollars, like 12.50.</p>}
      {problem && (
        <p className="notice error" role="alert" data-testid="exits-problem">
          {problem}
        </p>
      )}
      {saved && (
        <p className="notice ok" role="status" data-testid="exits-saved">
          {saved}
        </p>
      )}
      <button type="button" className="btn btn-small" disabled={busy || bad || !changed} onClick={() => void save()} data-testid={`exits-save-${kind}`}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
