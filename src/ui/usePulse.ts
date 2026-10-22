// A "pulse" for a number that changes every tick (a price): which way it just moved, and a counter that goes up with every move.
// The screens use it to restart a short CSS animation (a flash, a glow) each time the price ticks. Nothing here reads or changes a
// price: it only watches the value it is given.
import { useEffect, useRef, useState } from 'react';
import { directionOf, type Direction } from './hype';

export interface Pulse {
  readonly dir: Direction | null;
  /** 0 until the first move, then up by one with every move. */
  readonly n: number;
  /** The value before the last move (for "+1.2%" labels). */
  readonly from: number;
}

const NONE: Pulse = { dir: null, n: 0, from: 0 };

/**
 * Watches `value`. A move from one real value to another sets `dir` and bumps `n`; the first value, a value that is not a real
 * price (0: not listed yet) and a `resetKey` change (another company) do not pulse.
 */
export function usePulse(value: number, resetKey: string | number = ''): Pulse {
  const last = useRef({ key: resetKey, value });
  const [pulse, setPulse] = useState<Pulse>(NONE);

  useEffect(() => {
    const prev = last.current;
    last.current = { key: resetKey, value };
    if (prev.key !== resetKey) {
      setPulse(NONE);
      return;
    }
    const dir = directionOf(prev.value, value);
    if (dir) setPulse((p) => ({ dir, n: p.n + 1, from: prev.value }));
  }, [value, resetKey]);

  return pulse;
}

/**
 * The class that plays a pulse's animation. The animation of "a" and "b" is the same, only the name differs: flipping between
 * them is what makes the browser start it again on the next tick.
 */
export function pulseClass(pulse: Pulse, prefix: string): string {
  return pulse.dir ? `${prefix}-${pulse.dir}-${pulse.n % 2 === 0 ? 'a' : 'b'}` : '';
}

/** Follows `target` smoothly (an eased roll over `ms`), so a big number rolls to its new value instead of jumping. */
export function useTween(target: number, ms = 450, resetKey: string | number = ''): number {
  const [shown, setShown] = useState(target);
  const state = useRef({ key: resetKey, from: target, to: target, start: 0, raf: 0, shown: target });
  useEffect(() => {
    const s = state.current;
    const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (s.key !== resetKey || reduce || !(s.shown > 0) || !(target > 0) || typeof requestAnimationFrame !== 'function') {
      s.key = resetKey;
      s.from = s.to = s.shown = target;
      setShown(target);
      return undefined;
    }
    s.from = s.shown;
    s.to = target;
    s.start = performance.now();
    cancelAnimationFrame(s.raf);
    const step = (now: number) => {
      const t = Math.min(1, (now - s.start) / ms);
      const eased = 1 - (1 - t) * (1 - t) * (1 - t);
      s.shown = s.from + (s.to - s.from) * eased;
      setShown(s.shown);
      if (t < 1) s.raf = requestAnimationFrame(step);
    };
    s.raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(s.raf);
  }, [target, ms, resetKey]);
  return shown;
}
