// FX-1 … FX-12 — the price animations (docs/world.md §12.3): which milestone a rise crosses, the confetti, the flash and the wiring.
// They are looks only: nothing here may touch a price, an order or the database.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MILESTONES, crossedMilestones, directionOf, formatMultiple, milestoneFor, moveLabel, mulberry32, multipleOf, piecesFor } from '../src/ui/hype';
import { pulseClass } from '../src/ui/usePulse';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Milestones', () => {
  it('FX-1: the multiple is the price over the starting price, and 0 when either is not a real price', () => {
    expect(multipleOf(2000, 200)).toBe(10);
    expect(multipleOf(300, 200)).toBe(1.5);
    for (const [p, b] of [[0, 200], [200, 0], [-5, 200], [200, -1], [Number.NaN, 200], [200, Number.POSITIVE_INFINITY]]) expect(multipleOf(p as number, b as number)).toBe(0);
  });

  it('FX-2: the milestones are 2x, 5x, 10x, 25x, 50x and 100x, getting louder', () => {
    expect(MILESTONES.map((m) => m.x)).toEqual([2, 5, 10, 25, 50, 100]);
    expect(MILESTONES.map((m) => m.label)).toEqual(['2x', '5x', '10x', '25x', '50x', '100x']);
    const levels = MILESTONES.map((m) => m.level);
    expect(levels).toEqual([...levels].sort());
    expect(MILESTONES.find((m) => m.x === 10)?.level).toBe(3); // 10x is the big one
    for (let i = 1; i < MILESTONES.length; i++) {
      expect((MILESTONES[i] as { particles: number }).particles).toBeGreaterThanOrEqual((MILESTONES[i - 1] as { particles: number }).particles);
      expect((MILESTONES[i] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual((MILESTONES[i - 1] as { durationMs: number }).durationMs);
    }
  });

  it('FX-3: milestoneFor gives the biggest milestone reached, and nothing below 2x', () => {
    expect(milestoneFor(0)).toBeNull();
    expect(milestoneFor(1)).toBeNull();
    expect(milestoneFor(1.999)).toBeNull();
    expect(milestoneFor(2)?.x).toBe(2);
    expect(milestoneFor(4.99)?.x).toBe(2);
    expect(milestoneFor(5)?.x).toBe(5);
    expect(milestoneFor(10.01)?.x).toBe(10);
    expect(milestoneFor(99.9)?.x).toBe(50);
    expect(milestoneFor(5000)?.x).toBe(100);
  });

  it('FX-4: a rise crosses the milestones between the two multiples; a fall, a standstill and an old milestone cross nothing', () => {
    expect(crossedMilestones(1.9, 2.0).top?.x).toBe(2);
    expect(crossedMilestones(1.9, 1.99).top).toBeNull();
    expect(crossedMilestones(2, 2.5).top).toBeNull(); // 2x was already reached
    expect(crossedMilestones(3, 12).top?.x).toBe(10);
    expect(crossedMilestones(3, 12).all.map((m) => m.x)).toEqual([5, 10]);
    expect(crossedMilestones(1.5, 12).all.map((m) => m.x)).toEqual([2, 5, 10]); // one big jump passes them all
    expect(crossedMilestones(1.5, 12).top?.x).toBe(10);
    expect(crossedMilestones(12, 3).top).toBeNull(); // a fall crosses nothing
    expect(crossedMilestones(12, 12).top).toBeNull();
    expect(crossedMilestones(0.5, 0.4).all).toEqual([]);
    expect(crossedMilestones(9.99, 10).top?.x).toBe(10); // exactly 10x counts
  });

  it('FX-5: the badge text is short and honest', () => {
    expect(formatMultiple(2)).toBe('2x');
    expect(formatMultiple(2.04)).toBe('2x');
    expect(formatMultiple(2.45)).toBe('2.5x');
    expect(formatMultiple(10)).toBe('10x');
    expect(formatMultiple(12.5)).toBe('12.5x');
    expect(formatMultiple(137.4)).toBe('137x');
    expect(formatMultiple(0)).toBe('—');
  });
});

describe('Moves and pulses', () => {
  it('FX-6: the direction of a move; a company that is not listed (price 0) has none', () => {
    expect(directionOf(100, 101)).toBe('up');
    expect(directionOf(101, 100)).toBe('down');
    expect(directionOf(100, 100)).toBeNull();
    expect(directionOf(0, 100)).toBeNull();
    expect(directionOf(100, 0)).toBeNull();
  });

  it('FX-7: the floating label shows moves of 0.25% or more, with a sign and sensible digits', () => {
    expect(moveLabel(10_000, 10_100)).toBe('+1.00%');
    expect(moveLabel(10_000, 9_900)).toBe('−1.00%');
    expect(moveLabel(10_000, 10_024)).toBeNull(); // 0.24%: too small to label
    expect(moveLabel(10_000, 10_025)).toBe('+0.25%');
    expect(moveLabel(10_000, 12_500)).toBe('+25.0%');
    expect(moveLabel(0, 100)).toBeNull();
    expect(moveLabel(10_000, 10_030, 50)).toBeNull(); // a bigger minimum
  });

  it('FX-8: a pulse flips between two class names so the same animation starts again on the next tick', () => {
    expect(pulseClass({ dir: null, n: 0, from: 0 }, 'flash')).toBe('');
    expect(pulseClass({ dir: 'up', n: 1, from: 5 }, 'flash')).toBe('flash-up-b');
    expect(pulseClass({ dir: 'up', n: 2, from: 5 }, 'flash')).toBe('flash-up-a');
    expect(pulseClass({ dir: 'down', n: 3, from: 5 }, 'glow')).toBe('glow-down-b');
    expect(pulseClass({ dir: 'down', n: 4, from: 5 }, 'tag')).toBe('tag-down-a');
  });
});

describe('Confetti', () => {
  const m10 = MILESTONES.find((m) => m.x === 10) as (typeof MILESTONES)[number];
  const m2 = MILESTONES[0] as (typeof MILESTONES)[number];

  it('FX-9: the same seed always scatters the same way, another seed differently; the random generator stays in 0…1', () => {
    expect(piecesFor(42, m10)).toEqual(piecesFor(42, m10));
    expect(piecesFor(42, m10)).not.toEqual(piecesFor(43, m10));
    const rnd = mulberry32(7);
    for (let i = 0; i < 2000; i++) {
      const v = rnd();
      expect(v >= 0 && v < 1).toBe(true);
    }
  });

  it('FX-10: a bigger milestone has more pieces that fly further, and every piece is well formed', () => {
    const small = piecesFor(1, m2);
    const big = piecesFor(1, m10);
    expect(small).toHaveLength(m2.particles);
    expect(big).toHaveLength(m10.particles);
    const reach = (ps: typeof small) => Math.max(...ps.map((p) => Math.hypot(p.dx, p.dy)));
    expect(reach(big)).toBeGreaterThan(reach(small));
    for (const p of big) {
      expect(p.size).toBeGreaterThanOrEqual(6);
      expect(p.time).toBeGreaterThanOrEqual(1300);
      expect(p.delay).toBeLessThanOrEqual(260);
      expect(/^#[0-9a-f]{6}$/i.test(p.color)).toBe(true);
      expect([0, 1, 2]).toContain(p.shape);
    }
  });
});

describe('The wiring', () => {
  it('FX-11: the company page shows the animated price; the lists flash; the chart pulses; nothing in them places an order', () => {
    const view = code(src('shared', 'CompanyView.tsx'));
    expect(view).toContain('<CompanyPrice');
    expect(view).toContain('baseCents={detail.basePriceCents}');
    expect(code(src('shared', 'MarketScreen.tsx'))).toContain('<FlashPrice');
    const chart = code(src('ui', 'LiveChart.tsx'));
    for (const word of ['usePulse', 'pulseClass(pulse', 'live-dot', 'live-ping', 'float-move', 'big-move']) expect(chart).toContain(word);
    const fx = code(src('shared', 'PriceFx.tsx'));
    for (const word of ['useMilestones', 'MilestoneBurst', 'HypeBadge', 'CELEBRATED', 'createPortal', 'milestone-burst', 'hype-badge']) expect(fx).toContain(word);
    for (const file of [fx, chart, code(src('ui', 'usePulse.ts')), code(src('ui', 'hype.ts'))]) {
      expect(file).not.toMatch(/api\.(placeOrder|placeLimit|order|rugPull|launch)|fetch\(|sharedStore\./);
    }
  });

  it('FX-12: the styles have every animation, and reduced motion turns them all off (the badge and the banner text stay)', () => {
    const css = readFileSync(src('styles.css'), 'utf8');
    for (const name of ['fx-up-a', 'fx-down-b', 'roll-up-a', 'roll-down-b', 'glow-up-a', 'glow-big-down-b', 'tag-up-a', 'ring-idle', 'ring-ping', 'float-up', 'badge-in', 'piece-fly', 'banner-in', 'banner-out', 'vignette', 'fx-shake']) {
      expect(css).toContain(`@keyframes ${name}`);
    }
    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    for (const sel of ['.price-flash', '.price-roll', '.live-ring', '.live-ping', '.float-move', '.burst-banner', '.burst-flash', '.fx-shake']) expect(reduced).toContain(sel);
    expect(reduced).toContain('animation: none !important');
    expect(css).toMatch(/\.burst\s*\{[^}]*pointer-events:\s*none/); // a celebration never blocks a click
  });
});
