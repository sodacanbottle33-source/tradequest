// Round flow — see docs/rules.md §4, §6, §9.
// Every function is pure: it returns a new RoundState and never changes the old one.
// React must not read RoundState directly; it reads getView(state) from view.ts.

import { applyBuy, applySell, initialAccount, type Account } from './account';
import { generateCandles, roundNumber, type Candle } from './candles';
import { ENGINE_VERSION, HISTORY_LENGTH, LAST_INDEX, TOTAL_CANDLES } from './constants';
import { formatCents, formatSignedCents } from './format';
import { floorDiv } from './money';
import { describeOrder, parseQuantity, type PendingOrder, type Side } from './orders';

export type RoundStatus = 'PLAYING' | 'FINISHED';

export interface Trade {
  readonly id: number;
  readonly type: 'player' | 'liquidation';
  readonly side: Side;
  /** Global candle index 11–70 whose open (player) or close (liquidation) was used. */
  readonly candleIndex: number;
  readonly quantity: number;
  readonly price: number;
  /** Cost (buy) or proceeds (sell), in cents. */
  readonly amount: number;
  /** Sells only; null for buys. */
  readonly tradePnl: number | null;
  readonly cashAfter: number;
  readonly sharesAfter: number;
}

export type NoticeKind = 'info' | 'success' | 'error';

export interface Notice {
  readonly id: number;
  readonly kind: NoticeKind;
  readonly message: string;
}

export interface RoundState {
  readonly engineVersion: number;
  readonly seed: number;
  /** All 70 candles. INTERNAL — never hand this to the UI (see view.ts). */
  readonly candles: readonly Candle[];
  /** Newest visible candle index (10..70). */
  readonly k: number;
  readonly status: RoundStatus;
  readonly account: Account;
  readonly pending: PendingOrder | null;
  readonly trades: readonly Trade[];
  readonly notices: readonly Notice[];
  readonly nextNoticeId: number;
}

const MAX_NOTICES = 20;

// ----- Creating rounds -----

/** New round from a seed (§4.3). The seed comes from outside the engine (§8). */
export function createRound(seed: number): RoundState {
  return createRoundFromCandles(seed, generateCandles(seed));
}

/** Builds a round from given candles. Used by createRound and by tests that need exact prices. */
export function createRoundFromCandles(seed: number, candles: readonly Candle[]): RoundState {
  if (candles.length !== TOTAL_CANDLES) throw new Error(`A round needs ${TOTAL_CANDLES} candles`);
  candles.forEach((c, i) => {
    if (c.index !== i + 1) throw new Error(`Candle at position ${i} has index ${c.index}`);
  });
  return {
    engineVersion: ENGINE_VERSION,
    seed,
    candles,
    k: HISTORY_LENGTH,
    status: 'PLAYING',
    account: initialAccount(),
    pending: null,
    trades: [],
    notices: [],
    nextNoticeId: 1,
  };
}

/** Replay: same seed, everything reset, identical candles (§9). */
export function replayRound(state: RoundState): RoundState {
  return createRound(state.seed);
}

// ----- Helpers -----

export function candleAt(state: RoundState, index: number): Candle {
  const candle = state.candles[index - 1];
  if (!candle) throw new Error(`No candle ${index}`);
  return candle;
}

/** Close of the newest visible candle (§4.2). */
export function markPrice(state: RoundState): number {
  return candleAt(state, state.k).close;
}

function addNotice(state: RoundState, kind: NoticeKind, message: string): RoundState {
  const notices = [...state.notices, { id: state.nextNoticeId, kind, message }].slice(-MAX_NOTICES);
  return { ...state, notices, nextNoticeId: state.nextNoticeId + 1 };
}

function candleLabel(index: number): string {
  return `candle ${roundNumber(index)}`;
}

// ----- Player actions -----

/** Submit an order (§6.2). Replaces any pending order (§6.4). */
export function submitOrder(state: RoundState, side: Side, quantityText: string): RoundState {
  if (state.status !== 'PLAYING') return state;
  if (state.k >= LAST_INDEX) {
    return addNotice(state, 'error', 'No next candle: this is the final candle. Finish the round to see your results.');
  }

  const parsed = parseQuantity(quantityText);
  if (!parsed.ok) return addNotice(state, 'error', parsed.reason);
  const quantity = parsed.value;
  const { account } = state;

  if (side === 'SELL') {
    if (account.shares === 0) return addNotice(state, 'error', "You don't hold any shares to sell.");
    if (quantity > account.shares) {
      return addNotice(state, 'error', `You only hold ${account.shares} share${account.shares === 1 ? '' : 's'}.`);
    }
  } else {
    const mark = markPrice(state);
    const estimate = quantity * mark;
    if (estimate > account.cash) {
      // Tell the player what they CAN do, not just that this order failed.
      const affordable = floorDiv(account.cash, mark);
      const canDo =
        affordable > 0
          ? `You can afford up to ${affordable} share${affordable === 1 ? '' : 's'}.`
          : 'You cannot afford even 1 share at this price.';
      return addNotice(
        state,
        'error',
        `Not enough cash: estimated cost ${formatCents(estimate)} at the last close, but you have ${formatCents(account.cash)}. ${canDo}`,
      );
    }
  }

  const previous = state.pending;
  const next: RoundState = { ...state, pending: { side, quantity, submittedAt: state.k } };
  const message = previous
    ? `Previous order (${describeOrder(previous.side, previous.quantity)}) replaced by ${describeOrder(side, quantity)}.`
    : `Order placed: ${describeOrder(side, quantity)}. It fills at the next candle's open.`;
  return addNotice(next, 'info', message);
}

export function cancelOrder(state: RoundState): RoundState {
  if (state.status !== 'PLAYING' || state.pending === null) return state;
  return addNotice({ ...state, pending: null }, 'info', 'Order cancelled.');
}

/** Reveal the next candle, filling any pending order at its open (§4.4, steps 1–6). */
export function advance(state: RoundState): RoundState {
  // 1. Check k < 70.
  if (state.status !== 'PLAYING' || state.k >= LAST_INDEX) return state;

  // 2. Read candle k+1 (not visible yet).
  const nextIndex = state.k + 1;
  const nextCandle = candleAt(state, nextIndex);
  let result: RoundState = state;

  // 3. Process the pending order at open(k+1).
  const order = state.pending;
  if (order) {
    const price = nextCandle.open;
    const { account } = state;
    if (order.side === 'BUY') {
      const cost = order.quantity * price;
      if (cost > account.cash) {
        result = addNotice(
          result,
          'error',
          `Order rejected: the price opened at ${formatCents(price)}. This order would cost ${formatCents(cost)}, but you have ${formatCents(account.cash)}.`,
        );
      } else {
        const fill = applyBuy(account, order.quantity, price);
        result = recordTrade(result, fill.account, {
          type: 'player',
          side: 'BUY',
          candleIndex: nextIndex,
          quantity: order.quantity,
          price,
          amount: fill.cost,
          tradePnl: null,
        });
        result = addNotice(
          result,
          'success',
          `Bought ${order.quantity} at ${formatCents(price)} (${candleLabel(nextIndex)} open). Cost ${formatCents(fill.cost)}.`,
        );
      }
    } else if (order.quantity > account.shares) {
      result = addNotice(result, 'error', `Order rejected: you hold only ${account.shares} shares.`);
    } else {
      const fill = applySell(account, order.quantity, price);
      result = recordTrade(result, fill.account, {
        type: 'player',
        side: 'SELL',
        candleIndex: nextIndex,
        quantity: order.quantity,
        price,
        amount: fill.proceeds,
        tradePnl: fill.tradePnl,
      });
      result = addNotice(
        result,
        'success',
        `Sold ${order.quantity} at ${formatCents(price)} (${candleLabel(nextIndex)} open). Realized P&L ${formatSignedCents(fill.tradePnl)}.`,
      );
    }
  }

  // 4. Clear the pending order. 5. Reveal candle k+1. (6. Marks are derived in view.ts.)
  return { ...result, pending: null, k: nextIndex };
}

/** Finish the round: liquidate at close(70) and mark FINISHED (§4.6). Idempotent. */
export function finishRound(state: RoundState): RoundState {
  if (state.status !== 'PLAYING' || state.k !== LAST_INDEX) return state;
  let result: RoundState = state;
  const { account } = state;
  if (account.shares > 0) {
    const price = candleAt(state, LAST_INDEX).close;
    const fill = applySell(account, account.shares, price);
    result = recordTrade(result, fill.account, {
      type: 'liquidation',
      side: 'SELL',
      candleIndex: LAST_INDEX,
      quantity: account.shares,
      price,
      amount: fill.proceeds,
      tradePnl: fill.tradePnl,
    });
    result = addNotice(
      result,
      'info',
      `Round finished. Your remaining ${account.shares} shares were sold at the final close, ${formatCents(price)}.`,
    );
  } else {
    result = addNotice(result, 'info', 'Round finished.');
  }
  return { ...result, status: 'FINISHED', pending: null };
}

function recordTrade(
  state: RoundState,
  account: Account,
  t: Omit<Trade, 'id' | 'cashAfter' | 'sharesAfter'>,
): RoundState {
  const trade: Trade = {
    ...t,
    id: state.trades.length + 1,
    cashAfter: account.cash,
    sharesAfter: account.shares,
  };
  return { ...state, account, trades: [...state.trades, trade] };
}
