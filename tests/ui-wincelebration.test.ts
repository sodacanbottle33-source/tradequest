// The celebration for your own wins and launches (src/shared/winCelebration.ts, src/shared/WinBurst.tsx). Looks only: it decides from a trade the server already
// answered with whether to play a burst, and which one. Checked: what counts as a win (a trade that CLOSES a position with a real profit), what never does
// (an opening trade, a loss, a tiny win, a stop-loss, a liquidation, a repeated request), how the size is chosen, the text, that the same win scatters the same
// confetti, and that the page's layer hears each celebration once and can stop listening.
import { describe, expect, it } from 'vitest';
import { piecesFor } from '../src/ui/hype';
import {
  WIN_BIG_CENTS,
  WIN_HUGE_CENTS,
  WIN_MIN_CENTS,
  celebrate,
  celebrateTrade,
  closesPosition,
  launchWin,
  milestoneOfWin,
  onCelebrate,
  winOf,
  type Win,
} from '../src/shared/winCelebration';

type T = Parameters<typeof winOf>[0];
const sale = (over: Partial<T> = {}): T => ({ id: 1, ticker: 'ACME', side: 'sell', short: false, realizedCents: 5_000, totalCents: 55_000, liquidated: false, auto: '', ...over });

describe('Which trades are celebrated', () => {
  it('WIN-1: only a trade that closes a position counts: a sale of shares or the cover of a short; opening trades never do', () => {
    expect(closesPosition({ side: 'sell', short: false })).toBe(true);
    expect(closesPosition({ side: 'buy', short: false })).toBe(false);
    expect(closesPosition({ side: 'buy', short: true })).toBe(true);
    expect(closesPosition({ side: 'sell', short: true })).toBe(false);
    expect(winOf(sale({ side: 'buy' }))).toBeNull();
    expect(winOf(sale({ side: 'sell', short: true }))).toBeNull();
    expect(winOf(sale())).not.toBeNull();
    expect(winOf(sale({ side: 'buy', short: true, realizedCents: 5_000, totalCents: 30_000 }))).not.toBeNull();
  });

  it('WIN-2: a loss, a tiny win, a win that is a tiny share of the money, a stop-loss and a liquidation are not celebrated', () => {
    expect(winOf(sale({ realizedCents: -5_000 }))).toBeNull();
    expect(winOf(sale({ realizedCents: 0 }))).toBeNull();
    expect(winOf(sale({ realizedCents: WIN_MIN_CENTS - 1, totalCents: 20_000 }))).toBeNull();
    expect(winOf(sale({ realizedCents: WIN_MIN_CENTS, totalCents: 20_000 + WIN_MIN_CENTS }))).not.toBeNull();
    // $30 on $10,000 is 0.3 %: not a party; but $100 is a party even on a big position
    expect(winOf(sale({ realizedCents: 3_000, totalCents: 1_003_000 }))).toBeNull();
    expect(winOf(sale({ realizedCents: WIN_BIG_CENTS, totalCents: 1_000_000 + WIN_BIG_CENTS }))).not.toBeNull();
    expect(winOf(sale({ auto: 'stop' }))).toBeNull();
    expect(winOf(sale({ liquidated: true }))).toBeNull();
    expect(winOf(sale({ realizedCents: Number.NaN }))).toBeNull();
    // a take-profit the market made for you is a win
    expect(winOf(sale({ auto: 'take' }))).not.toBeNull();
  });

  it('WIN-3: the size grows with the profit or the percentage; the text says how much and on what', () => {
    const small = winOf(sale({ realizedCents: 4_000, totalCents: 104_000 })) as Win; // $40 on $1,000: 4 %... below the minimum of 5 % -> use a bigger share
    expect(small).toBeNull();
    const nice = winOf(sale({ realizedCents: 3_000, totalCents: 33_000 })) as Win; // 10 %
    expect(nice).toMatchObject({ level: 1, tag: 'Nice trade!', icon: '💰', label: '+$30.00', kind: 'trade', ticker: 'ACME' });
    expect(nice.sub).toBe('ACME: 10% on the shares you sold');
    const big = winOf(sale({ realizedCents: WIN_BIG_CENTS, totalCents: 400_000 + WIN_BIG_CENTS })) as Win;
    expect(big).toMatchObject({ level: 2, tag: 'Big win!' });
    const bigByPct = winOf(sale({ realizedCents: 3_000, totalCents: 9_000 })) as Win; // +50 %
    expect(bigByPct.level).toBe(2);
    const huge = winOf(sale({ realizedCents: WIN_HUGE_CENTS, totalCents: 900_000 })) as Win;
    expect(huge).toMatchObject({ level: 3, tag: 'HUGE win!', icon: '🏆' });
    const hugeByPct = winOf(sale({ realizedCents: 3_000, totalCents: 6_000 })) as Win; // +100 %
    expect(hugeByPct.level).toBe(3);
    const cover = winOf(sale({ side: 'buy', short: true, realizedCents: 6_000, totalCents: 60_000, ticker: 'MEME' })) as Win;
    expect(cover.sub).toBe('MEME: 10% on the short you covered');
  });

  it('WIN-4: the confetti is the same for the same win and different for another', () => {
    const a = winOf(sale({ id: 7 })) as Win;
    const b = winOf(sale({ id: 7 })) as Win;
    const c = winOf(sale({ id: 8 })) as Win;
    expect(a.seed).toBe(b.seed);
    expect(a.seed).not.toBe(c.seed);
    const m = milestoneOfWin(a);
    expect(piecesFor(a.seed, m)).toEqual(piecesFor(b.seed, milestoneOfWin(b)));
    expect(piecesFor(a.seed, m)).not.toEqual(piecesFor(c.seed, milestoneOfWin(c)));
    expect(piecesFor(a.seed, m)).toHaveLength(m.particles);
    expect([1, 2, 3].map((level) => milestoneOfWin({ ...a, level: level as 1 | 2 | 3 }).particles)).toEqual([26, 52, 96]);
  });
});

describe('Playing them', () => {
  it('WIN-5: a launch has its own celebration', () => {
    const w = launchWin('PEPE', 3);
    expect(w).toMatchObject({ kind: 'launch', ticker: 'PEPE', label: 'PEPE', tag: 'Launched!', icon: '🚀', level: 2 });
    expect(w.sub).toContain('PEPE');
    expect(launchWin('PEPE', 3).seed).toBe(w.seed);
  });

  it('WIN-6: the page hears each celebration once; a repeated request never celebrates; a listener that stopped hears nothing; nothing listening is fine', () => {
    const heard: Win[] = [];
    expect(() => celebrate(launchWin('NONE'))).not.toThrow(); // nobody is listening
    const stop = onCelebrate((w) => heard.push(w));
    expect(celebrateTrade({ duplicate: false, trade: sale() })).not.toBeNull();
    expect(heard).toHaveLength(1);
    expect(celebrateTrade({ duplicate: true, trade: sale() })).toBeNull();
    expect(celebrateTrade({ duplicate: false, trade: sale({ realizedCents: -10 }) })).toBeNull();
    expect(heard).toHaveLength(1);
    celebrate(launchWin('PEPE'));
    expect(heard).toHaveLength(2);
    expect(heard[1]?.kind).toBe('launch');
    stop();
    celebrate(launchWin('PEPE'));
    expect(heard).toHaveLength(2);
  });
});
