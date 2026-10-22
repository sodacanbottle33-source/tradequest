// Milestone 1 parameters — see docs/rules.md §2.
// Changing any engine parameter changes the market for a given seed and
// requires bumping ENGINE_VERSION (rules.md §5.6).

export const ENGINE_VERSION = 1;

// Money is always integer cents.
export const START_CASH = 100_000; // $1,000.00

// Candle layout (global index 1..70).
export const HISTORY_LENGTH = 10;
export const ROUND_LENGTH = 60;
export const TOTAL_CANDLES = HISTORY_LENGTH + ROUND_LENGTH; // 70
export const FIRST_PLAYABLE = HISTORY_LENGTH + 1; // 11
export const LAST_INDEX = TOTAL_CANDLES; // 70

// Prices (cents).
export const START_PRICE_MIN = 2_000; // $20.00
export const START_PRICE_MAX = 5_000; // $50.00
export const MIN_PRICE = 100; // $1.00

// Orders.
export const MAX_ORDER_QTY = 1_000_000;

// Price model (tunable — rules.md §2).
export const DRIFT = 0;
export const BODY_SIGMA = 0.015;
export const GAP_SIGMA = 0.002;
export const MAX_MOVE = 0.1;
export const MAX_GAP = 0.02;
export const WICK_MAX = 0.01;

// Random draws per candle: zGap (12) + zBody (12) + uUp (1) + uDown (1).
export const DRAWS_PER_CANDLE = 26;
export const DRAWS_PER_ROUND = 1 + TOTAL_CANDLES * DRAWS_PER_CANDLE; // 1821

// Fictional company (rules.md §10).
export const COMPANY_NAME = 'Quellaris Energy';
export const TICKER = 'QLRX';
