// Account accounting — see docs/rules.md §7.
// Callers validate orders first; these functions throw only on programming errors.

import { START_CASH } from './constants';
import { assertMoney, roundHalfUpRatio } from './money';

export interface Account {
  /** Cents. */
  readonly cash: number;
  /** Whole shares held. */
  readonly shares: number;
  /** Cents — total cost of the shares currently held. */
  readonly costBasis: number;
  /** Cents — running total of realized P&L. */
  readonly realizedPnl: number;
}

export function initialAccount(): Account {
  return { cash: START_CASH, shares: 0, costBasis: 0, realizedPnl: 0 };
}

function checkFill(quantity: number, price: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error(`Invalid quantity ${quantity}`);
  if (!Number.isSafeInteger(price) || price < 1) throw new Error(`Invalid price ${price}`);
}

function checkAccount(a: Account): Account {
  assertMoney(a.cash, 'cash');
  assertMoney(a.shares, 'shares');
  assertMoney(a.costBasis, 'costBasis');
  assertMoney(a.realizedPnl, 'realizedPnl');
  return a;
}

/** Buy fill (§7.2). */
export function applyBuy(account: Account, quantity: number, price: number): { account: Account; cost: number } {
  checkFill(quantity, price);
  const cost = quantity * price;
  if (cost > account.cash) throw new Error(`Buy costs ${cost} but cash is ${account.cash}`);
  return {
    cost,
    account: checkAccount({
      cash: account.cash - cost,
      shares: account.shares + quantity,
      costBasis: account.costBasis + cost,
      realizedPnl: account.realizedPnl,
    }),
  };
}

/** Sell fill (§7.3). removedBasis uses the values BEFORE the sell. */
export function applySell(
  account: Account,
  quantity: number,
  price: number,
): { account: Account; proceeds: number; removedBasis: number; tradePnl: number } {
  checkFill(quantity, price);
  if (quantity > account.shares) throw new Error(`Cannot sell ${quantity}, holding ${account.shares}`);
  const proceeds = quantity * price;
  const removedBasis = roundHalfUpRatio(account.costBasis * quantity, account.shares);
  const tradePnl = proceeds - removedBasis;
  return {
    proceeds,
    removedBasis,
    tradePnl,
    account: checkAccount({
      cash: account.cash + proceeds,
      shares: account.shares - quantity,
      costBasis: account.costBasis - removedBasis,
      realizedPnl: account.realizedPnl + tradePnl,
    }),
  };
}

// ----- Derived values (§7.4) -----

export function positionValue(account: Account, markPrice: number): number {
  return account.shares * markPrice;
}

export function unrealizedPnl(account: Account, markPrice: number): number {
  return account.shares * markPrice - account.costBasis;
}

export function equity(account: Account, markPrice: number): number {
  return account.cash + account.shares * markPrice;
}

/** Display only. null when no shares are held. */
export function averageEntry(account: Account): number | null {
  return account.shares > 0 ? roundHalfUpRatio(account.costBasis, account.shares) : null;
}
