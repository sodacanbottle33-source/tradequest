// The world's clock — pure arithmetic on numbers. The server supplies "now" in milliseconds; nothing here reads a clock.
// Tick 0 is the instant of genesis; tick n happens n·TICK_MS later. A client can never influence the tick: the server
// derives it from its own clock (docs/world.md §3).

import { CANDLES_PER_DAY, CANDLES_PER_HOUR, NEWS_CYCLE_TICKS, TICKS_PER_CANDLE, TICKS_PER_DAY, TICKS_PER_HOUR, TICK_MS } from './params';

/** The tick that is current at `nowMs`. Negative before genesis. */
export function tickAtMs(nowMs: number, genesisMs: number): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(genesisMs)) throw new Error('Bad time');
  return Math.floor((nowMs - genesisMs) / TICK_MS);
}

/** The instant (ms) at which `tick` happens. */
export function msOfTick(tick: number, genesisMs: number): number {
  return genesisMs + tick * TICK_MS;
}

/** Candle n (1-based) covers ticks 10(n−1)+1 … 10n and opens at the price of tick 10(n−1). Tick 0 belongs to no candle. */
export function candleOfTick(tick: number): number {
  if (!Number.isInteger(tick) || tick < 1) throw new Error(`Tick ${tick} belongs to no candle`);
  return Math.ceil(tick / TICKS_PER_CANDLE);
}

export function candleOpenTick(index: number): number {
  return (index - 1) * TICKS_PER_CANDLE;
}

export function candleCloseTick(index: number): number {
  return index * TICKS_PER_CANDLE;
}

/** Hour h (1-based) covers candles 360(h−1)+1 … 360h; day d likewise with 8640 candles. */
export function hourOfCandle(candle: number): number {
  return Math.ceil(candle / CANDLES_PER_HOUR);
}

export function dayOfCandle(candle: number): number {
  return Math.ceil(candle / CANDLES_PER_DAY);
}

export function hourCloseTick(hour: number): number {
  return hour * TICKS_PER_HOUR;
}

export function dayCloseTick(day: number): number {
  return day * TICKS_PER_DAY;
}

/** Day number (0-based) a tick falls in; the random streams are re-derived once per day. */
export function dayOfTick(tick: number): number {
  return Math.floor(tick / TICKS_PER_DAY);
}

/** News cycle (0-based) a tick falls in. */
export function cycleOfTick(tick: number): number {
  return Math.floor(tick / NEWS_CYCLE_TICKS);
}

export function cycleStartTick(cycle: number): number {
  return cycle * NEWS_CYCLE_TICKS;
}

/** Formats a tick count as m:ss (used for match timers). */
export function formatDuration(ticks: number): string {
  const s = Math.max(0, Math.round((ticks * TICK_MS) / 1000));
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}
