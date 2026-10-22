// Reproducible property testing (test-cases.md "General rules").
// Every case uses a fixed seed; a failure reports the market seed and the full
// action sequence, which replayActions() can run again exactly.

import {
  advance,
  cancelOrder,
  createRound,
  finishRound,
  getView,
  Mulberry32,
  replayRound,
  submitOrder,
  type RoundState,
  type Side,
} from '../../src/engine';

export type Action =
  | { type: 'submit'; side: Side; qty: string }
  | { type: 'cancel' }
  | { type: 'advance' }
  | { type: 'finish' }
  | { type: 'replay' };

export function applyAction(state: RoundState, action: Action): RoundState {
  switch (action.type) {
    case 'submit':
      return submitOrder(state, action.side, action.qty);
    case 'cancel':
      return cancelOrder(state);
    case 'advance':
      return advance(state);
    case 'finish':
      return finishRound(state);
    case 'replay':
      return replayRound(state);
  }
}

/** Re-runs a recorded action sequence from scratch. */
export function replayActions(seed: number, actions: readonly Action[]): RoundState {
  return actions.reduce(applyAction, createRound(seed));
}

const INVALID_QUANTITIES = ['0', '-3', '1.5', '', ' ', 'abc', '1e3', '+5', ' 5', '05', '1000001'];

/** Picks a random action — valid and invalid ones (test-cases.md §12). */
export function randomAction(rng: Mulberry32, state: RoundState): Action {
  const r = rng.next();
  if (state.k === 70 && r < 0.3) return { type: 'finish' };
  if (r < 0.42) return { type: 'advance' };
  if (r < 0.84) {
    const side: Side = rng.next() < 0.55 ? 'BUY' : 'SELL';
    const v = getView(state);
    const q = rng.next();
    let qty: string;
    if (q < 0.1) qty = INVALID_QUANTITIES[Math.floor(rng.next() * INVALID_QUANTITIES.length)] ?? '0';
    else if (q < 0.3) qty = String(side === 'BUY' ? Math.max(1, v.maxBuyQuantity) : Math.max(1, v.maxSellQuantity));
    else {
      const cap = side === 'BUY' ? v.maxBuyQuantity : v.maxSellQuantity;
      qty = String(1 + Math.floor(rng.next() * (cap + 3)));
    }
    return { type: 'submit', side, qty };
  }
  if (r < 0.93) return { type: 'cancel' };
  if (r < 0.995) return { type: 'finish' };
  return { type: 'replay' };
}

export class PropertyFailure extends Error {
  constructor(
    readonly seed: number,
    readonly actions: readonly Action[],
    cause: unknown,
  ) {
    super(
      `Property failed for market seed ${seed} after ${actions.length} actions.\n` +
        `Reproduce with: replayActions(${seed}, ${JSON.stringify(actions)})\n` +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PropertyFailure';
  }
}

export interface PropertyOptions {
  cases: number;
  baseSeed: number;
  steps: number;
}

/**
 * Runs `cases` random action sequences. After every action, `check(next, prev, action)` runs.
 * Any thrown error is re-thrown as a PropertyFailure with the seed and actions.
 */
export function forEachRandomRun(
  options: PropertyOptions,
  check: (next: RoundState, prev: RoundState, action: Action) => void,
): void {
  for (let i = 0; i < options.cases; i += 1) {
    const seed = (options.baseSeed + Math.imul(i, 0x9e3779b1)) >>> 0;
    const actionRng = new Mulberry32((seed ^ 0x5bd1e995) >>> 0);
    const actions: Action[] = [];
    let state = createRound(seed);
    try {
      for (let step = 0; step < options.steps; step += 1) {
        const action = randomAction(actionRng, state);
        actions.push(action);
        const next = applyAction(state, action);
        check(next, state, action);
        state = next;
      }
    } catch (err) {
      throw new PropertyFailure(seed, actions, err);
    }
  }
}
