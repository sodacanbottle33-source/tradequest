// React glue for market mode: holds the MarketState privately and exposes only the safe view
// (rules.md §12.7). The selected stock is plain UI state and lives in App, not in the engine.
import { useCallback, useMemo, useReducer } from 'react';
import {
  advanceMarket,
  cancelMarketOrder,
  createMarketRound,
  finishMarket,
  getMarketResults,
  getMarketView,
  replayMarket,
  submitMarketOrder,
  type MarketResults,
  type MarketState,
  type MarketView,
  type Side,
} from '../engine';
import { randomSeed } from './seed';

type MarketAction =
  | { type: 'submit'; ticker: string; side: Side; quantityText: string }
  | { type: 'cancel'; ticker: string }
  | { type: 'next' }
  | { type: 'finish' }
  | { type: 'newRound'; seed: number }
  | { type: 'replay' };

function reducer(state: MarketState, action: MarketAction): MarketState {
  switch (action.type) {
    case 'submit':
      return submitMarketOrder(state, action.ticker, action.side, action.quantityText);
    case 'cancel':
      return cancelMarketOrder(state, action.ticker);
    case 'next':
      return advanceMarket(state);
    case 'finish':
      return finishMarket(state);
    case 'newRound':
      return createMarketRound(action.seed);
    case 'replay':
      return replayMarket(state);
  }
}

export interface MarketControls {
  view: MarketView;
  results: MarketResults | null;
  submit: (ticker: string, side: Side, quantityText: string) => void;
  cancel: (ticker: string) => void;
  next: () => void;
  finish: () => void;
  newRound: () => void;
  replay: () => void;
}

export function useMarket(): MarketControls {
  const [state, dispatch] = useReducer(reducer, undefined, () => createMarketRound(randomSeed()));
  const view = useMemo(() => getMarketView(state), [state]);
  const results = useMemo(() => getMarketResults(state), [state]);

  return {
    view,
    results,
    submit: useCallback(
      (ticker: string, side: Side, quantityText: string) => dispatch({ type: 'submit', ticker, side, quantityText }),
      [],
    ),
    cancel: useCallback((ticker: string) => dispatch({ type: 'cancel', ticker }), []),
    next: useCallback(() => dispatch({ type: 'next' }), []),
    finish: useCallback(() => dispatch({ type: 'finish' }), []),
    newRound: useCallback(() => dispatch({ type: 'newRound', seed: randomSeed() }), []),
    replay: useCallback(() => dispatch({ type: 'replay' }), []),
  };
}
