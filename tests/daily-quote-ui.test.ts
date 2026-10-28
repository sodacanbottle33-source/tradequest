// DQ — the quote of the day (src/shared/dailyQuote.ts, dailyQuoteData.ts, DailyQuoteCard.tsx): 366 short original lines and 120 tips, one pair for every
// calendar day on the player's own clock, no repeats within a year, what Copy puts on the clipboard, and "hide until tomorrow" in the browser's storage.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY_STEP, HIDE_KEY, copyText, dailyPick, dayKey, dayNumber, dayNumberOf, hiddenToday, readHiddenDay, writeHiddenDay, type QuoteStorage } from '../src/shared/dailyQuote';
import { QUOTES, TIPS } from '../src/shared/dailyQuoteData';

const src = (...parts: string[]): string => readFileSync(resolve(process.cwd(), 'src', ...parts), 'utf8');

function memory(): QuoteStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('Quote of the day', () => {
  it('DQ-1: 366 quotes (a leap year) and 120 tips, none empty, none repeated, all short', () => {
    expect(QUOTES).toHaveLength(366);
    expect(TIPS).toHaveLength(120);
    expect(new Set(QUOTES).size).toBe(366);
    expect(new Set(TIPS).size).toBe(120);
    for (const q of QUOTES) {
      expect(q).toBe(q.trim());
      expect(q.length).toBeGreaterThan(10);
      expect(q.length).toBeLessThanOrEqual(110);
      expect(q).toMatch(/[.!?]$/);
    }
    for (const t of TIPS) {
      expect(t).toBe(t.trim());
      expect(t.length).toBeGreaterThan(20);
      expect(t.length).toBeLessThanOrEqual(160);
      expect(t).toMatch(/[.!?]$/);
    }
  });

  it('DQ-2: the lines are safe to print: no quotation marks inside, no web addresses, no attributions, nothing that cheers on gambling', () => {
    for (const line of [...QUOTES, ...TIPS]) {
      expect(line).not.toMatch(/["“”]/);
      expect(line).not.toMatch(/https?:|www\./i);
      expect(line).not.toMatch(/\s[-–—]\s*[A-Z][a-z]+\s+[A-Z][a-z]+$/); // "- Firstname Lastname"
      expect(line).not.toMatch(/\b(all[- ]in|yolo|to the moon|diamond hands|guaranteed profit)\b/i);
    }
  });

  it('DQ-3: the dates: a day number counts days from 1970, flips at the player\'s own midnight, and the key is padded', () => {
    expect(dayNumber(1970, 1, 1)).toBe(0);
    expect(dayNumber(2026, 10, 28)).toBe(20754);
    expect(dayNumber(2028, 2, 29)).toBe(21243);
    expect(dayNumber(2028, 3, 1)).toBe(dayNumber(2028, 2, 29) + 1);
    expect(dayNumberOf(new Date(2026, 9, 28, 0, 5))).toBe(20754);
    expect(dayNumberOf(new Date(2026, 9, 28, 23, 55))).toBe(20754);
    expect(dayNumberOf(new Date(2026, 9, 29, 0, 5))).toBe(20755);
    expect(dayKey(new Date(2026, 0, 5, 13, 0))).toBe('2026-01-05');
    expect(dayKey(new Date(2026, 9, 28, 23, 59))).toBe('2026-10-28');
    expect(dayKey(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
  });

  it('DQ-4: a day always gets the same pair; the next day gets a different one', () => {
    for (const d of [0, 1, 20754, 21243, 30000]) {
      expect(dailyPick(d)).toEqual(dailyPick(d));
      expect(dailyPick(d).quote).not.toBe(dailyPick(d + 1).quote);
      expect(dailyPick(d).tip).not.toBe(dailyPick(d + 1).tip);
      expect(QUOTES).toContain(dailyPick(d).quote);
      expect(TIPS).toContain(dailyPick(d).tip);
    }
    expect(dailyPick(-5).quote).toBeTruthy(); // a clock before 1970 still works
    expect(DAY_STEP).toBe(7);
    // Fixed dates keep their lines: changing the walk would quietly give every player a different quote than the one they know.
    const fixed = [
      { at: [1970, 1, 1], quote: 0, tip: 3 },
      { at: [2026, 10, 28], quote: 342, tip: 81 },
      { at: [2026, 10, 29], quote: 349, tip: 88 },
      { at: [2027, 1, 1], quote: 65, tip: 56 },
    ] as const;
    for (const f of fixed) {
      const p = dailyPick(dayNumber(f.at[0], f.at[1], f.at[2]));
      expect([p.quoteIndex, p.tipIndex]).toEqual([f.quote, f.tip]);
    }
  });

  it('DQ-5: no quote repeats in 366 days in a row (also across a leap year), and no tip repeats in 120 days in a row', () => {
    for (const start of [dayNumber(2026, 1, 1), dayNumber(2027, 7, 14), dayNumber(2028, 1, 1), dayNumber(2028, 2, 29)]) {
      const quotes = new Set<number>();
      for (let i = 0; i < 366; i += 1) quotes.add(dailyPick(start + i).quoteIndex);
      expect(quotes.size).toBe(366);
      const tips = new Set<number>();
      for (let i = 0; i < 120; i += 1) tips.add(dailyPick(start + i).tipIndex);
      expect(tips.size).toBe(120);
    }
    // 29 February 2028 and the days around it all have a pair.
    const leap = dayNumber(2028, 2, 29);
    expect(new Set([leap - 1, leap, leap + 1].map((d) => dailyPick(d).quote)).size).toBe(3);
  });

  it('DQ-6: Copy puts the quote, the tip and the game\'s name on the clipboard; without a tip, just the quote', () => {
    expect(copyText('Be calm.', 'Check the spread.')).toBe('"Be calm."\nTip of the day: Check the spread.\n- TradeQuest');
    expect(copyText('Be calm.', null)).toBe('"Be calm."\n- TradeQuest');
    const pick = dailyPick(20754);
    const text = copyText(pick.quote, pick.tip);
    expect(text).toContain(pick.quote);
    expect(text).toContain(pick.tip);
  });

  it('DQ-7: "hide until tomorrow" hides the card on that day only', () => {
    expect(hiddenToday(null, '2026-10-28')).toBe(false);
    expect(hiddenToday('2026-10-28', '2026-10-28')).toBe(true);
    expect(hiddenToday('2026-10-28', '2026-10-29')).toBe(false);
    expect(hiddenToday('', '2026-10-28')).toBe(false);
    const store = memory();
    expect(readHiddenDay(store)).toBeNull();
    writeHiddenDay('2026-10-28', store);
    expect(store.data.get(HIDE_KEY)).toBe('2026-10-28');
    expect(readHiddenDay(store)).toBe('2026-10-28');
    expect(hiddenToday(readHiddenDay(store), '2026-10-29')).toBe(false);
  });

  it('DQ-8: a browser that refuses to store anything never breaks the card', () => {
    const angry: QuoteStorage = {
      getItem: () => {
        throw new Error('no storage');
      },
      setItem: () => {
        throw new Error('no storage');
      },
    };
    expect(readHiddenDay(angry)).toBeNull();
    expect(() => writeHiddenDay('2026-10-28', angry)).not.toThrow();
    expect(readHiddenDay(null)).toBeNull();
    expect(() => writeHiddenDay('2026-10-28', null)).not.toThrow();
  });

  it('DQ-9: the card is wired to the Market tab only (not the memecoins, not a 1v1 match), and the words and styles exist', () => {
    const app = src('shared', 'SharedApp.tsx');
    expect(app).toMatch(/import \{ DailyQuoteCard \} from '\.\/DailyQuoteCard'/);
    expect(app).toMatch(/careerTab === 'market' && <DailyQuoteCard \/>/);
    expect(src('shared', 'MatchScreen.tsx')).not.toMatch(/DailyQuote/);
    expect(src('shared', 'MarketScreen.tsx')).not.toMatch(/DailyQuote/);
    const card = src('shared', 'DailyQuoteCard.tsx');
    for (const id of ['daily-quote', 'daily-quote-text', 'daily-quote-tip', 'daily-quote-copy', 'daily-quote-hide']) expect(card).toContain(`data-testid="${id}"`);
    expect(card).toMatch(/aria-label="Hide the quote until tomorrow"/);
    const css = src('styles.css');
    for (const rule of ['.daily-quote', '.dq-quote', '.dq-tip', '.dq-actions']) expect(css).toContain(rule);
  });

  it('DQ-10: the card needs no server and shows text, never markup', () => {
    const card = src('shared', 'DailyQuoteCard.tsx');
    expect(card).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    expect(card).not.toMatch(/\bfetch\(|api\./);
    expect(src('shared', 'dailyQuote.ts')).not.toMatch(/\bfetch\(|Math\.random/);
  });
});
