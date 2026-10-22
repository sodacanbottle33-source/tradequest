// React glue: holds the RoundState privately and exposes only the safe view (rules.md §5.5).
import { useCallback, useMemo, useReducer } from 'react';
import {
  advance,
  cancelOrder,
  createRound,
  finishRound,
  getResults,
  getView,
  replayRound,
  submitOrder,
  type RoundResults,
  type RoundState,
  type RoundView,
  type Side,
} from '../engine';
import { randomSeed } from './seed';

type RoundAction =
  | { type: 'submit'; side: Side; quantityText: string }
  | { type: 'cancel' }
  | { type: 'next' }
  | { type: 'finish' }
  | { type: 'newRound'; seed: number }
  | { type: 'replay' };

function reducer(state: RoundState, action: RoundAction): RoundState {
  switch (action.type) {
    case 'submit':
      return submitOrder(state, action.side, action.quantityText);
    case 'cancel':
      return cancelOrder(state);
    case 'next':
      return advance(state);
    case 'finish':
      return finishRound(state);
    case 'newRound':
      return createRound(action.seed);
    case 'replay':
      return replayRound(state);
  }
}

export interface RoundControls {
  view: RoundView;
  results: RoundResults | null;
  submit: (side: Side, quantityText: string) => void;
  cancel: () => void;
  next: () => void;
  finish: () => void;
  newRound: () => void;
  replay: () => void;
}

export function useRound(): RoundControls {
  const [state, dispatch] = useReducer(reducer, undefined, () => createRound(randomSeed()));
  const view = useMemo(() => getView(state), [state]);
  const results = useMemo(() => getResults(state), [state]);

  return {
    view,
    results,
    submit: useCallback((side: Side, quantityText: string) => dispatch({ type: 'submit', side, quantityText }), []),
    cancel: useCallback(() => dispatch({ type: 'cancel' }), []),
    next: useCallback(() => dispatch({ type: 'next' }), []),
    finish: useCallback(() => dispatch({ type: 'finish' }), []),
    newRound: useCallback(() => dispatch({ type: 'newRound', seed: randomSeed() }), []),
    replay: useCallback(() => dispatch({ type: 'replay' }), []),
  };
}
