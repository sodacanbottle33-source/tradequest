// Black Monday: every year on October 19 (by Tokyo's calendar) the whole market crashes and then takes about a week to recover, like the
// real crash of October 19, 1987. It is two ordinary market-wide news stories, so the price engine, the news feed, a restart and the
// replay of the world treat them exactly like any other story (docs/world.md §7 and §41):
//
//   * the CRASH story: every company is hit at once, for 6½ hours (a trading day), strongest in the first hours;
//   * the RECOVERY story: the same companies are lifted again, slowly, over 7 days, strongest at the start.
//
// Both start on the same tick, so a company that lists after the crash began feels neither. A company's move is the story's number
// times its own beta (safe giants fall a little less, small risky shares and memecoins fall more). The hour of the crash is a
// surprise: it is drawn from the world seed and the year, somewhere between 00:00 and 17:30 Tokyo time, so the crash is over before
// the day ends. "October 19" is the day in Tokyo (UTC+9, no daylight saving), like the daily market event at 21:00 Tokyo time
// (docs/world.md §39). This file is pure arithmetic: no clock, no random numbers except the seeded stream.

import { deriveSeed, hashUniformAt } from '../engine/rng';
import { NEWS_CYCLE_TICKS, TICK_MS } from './params';
import type { NewsDraft } from './newsgen';

export const BLACK_MONDAY_MONTH = 10;
export const BLACK_MONDAY_DAY = 19;

/** The crash is spread over 6½ hours of the market (23 400 ticks of one second), strongest at the start ("front"). */
export const CRASH_TICKS = 23_400;
/** The recovery is spread over 7 days (604 800 ticks), strongest at the start. */
export const RECOVERY_TICKS = 604_800;

/**
 * The stories' numbers (the "realised" move before a company's beta). They were found by running the real price model with and without the
 * two stories on twelve companies in six different worlds, and are checked again by tests/server-blackmonday.test.ts. Averaged over those
 * worlds, a company with beta 1 is about 20 % lower after 6½ hours, 16 % after 1 day, 8 % after 3 days, 2–3 % after 5 days and about even
 * after 7 days. (The mood of the market on the day moves each of these by a few points, and the slow pull of every price toward its own
 * long-run level helps the recovery, which is why the second number is smaller than the first.)
 */
export const CRASH_TOTAL = -0.25;
export const RECOVERY_TOTAL = 0.23;

/** The crash starts at a surprise second inside this window of the day, so that its 6½ hours end before midnight (Tokyo time). */
export const START_WINDOW_SECONDS = 86_400 - CRASH_TICKS;

/** The slots of the two stories in their day (the generator's own stories use other numbers). */
export const CRASH_SLOT = 300;
export const RECOVERY_SLOT = 301;

const MS_DAY = 86_400_000;
/** The game's calendar is Tokyo's: its days begin 9 hours before the UTC ones. */
export const CALENDAR_UTC_OFFSET_MS = 9 * 3_600_000;
/** The stream of the surprise hour: one number per year, drawn from the world seed. */
const SURPRISE_STREAM = 0xb1ac;

/** Days since 1970-01-01 of a calendar date (proleptic Gregorian; month 1 … 12). Whole-number arithmetic only. */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12; // March is 0
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** The calendar year of a day number counted from 1970-01-01. */
export function yearOfDays(days: number): number {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const month = mp < 10 ? mp + 3 : mp - 9;
  return yoe + era * 400 + (month <= 2 ? 1 : 0);
}

/** The instant (ms since 1970, UTC) at which the crash of `year` begins: October 19 in Tokyo, at a surprise second between 00:00 and 17:30 there. */
export function blackMondayStartMs(worldSeed: number, year: number): number {
  const u = hashUniformAt(deriveSeed(worldSeed, SURPRISE_STREAM), year);
  const second = Math.floor(u * START_WINDOW_SECONDS);
  return daysFromCivil(year, BLACK_MONDAY_MONTH, BLACK_MONDAY_DAY) * MS_DAY - CALENDAR_UTC_OFFSET_MS + second * 1000;
}

/** The first tick at or after `ms` (the world's tick 0 is `genesisMs`). */
function tickOfMs(ms: number, genesisMs: number): number {
  return Math.ceil((ms - genesisMs) / TICK_MS);
}

/** The headline and text of the two stories. Plain words, no real company, person or market index. */
export const CRASH_HEADLINE = 'BLACK MONDAY: shares plunge across the whole market as panic selling spreads';
export const CRASH_BODY =
  'Every October 19 is remembered as Black Monday, the day in 1987 when markets around the world fell by about a fifth in a single session. It looks like it is happening again: sellers far outnumber buyers in almost every company. Big, steady companies are falling the least; small risky shares and memecoins are falling the hardest. Traders using borrowed money are being forced out of their positions.';
export const RECOVERY_HEADLINE = 'Black Monday: exchanges stay open, officials promise support, analysts expect about a week to recover';
export const RECOVERY_BODY =
  'Exchanges say trading will go on as normal and officials promise to keep cash flowing. After crashes like this, analysts say prices usually climb back in steps over roughly a week, with a few more scary days on the way. Risky shares and memecoins tend to recover last and can swing wildly in between.';

/** The two stories of one Black Monday that begins at `startTick`. `keyBase` makes the keys unique ("bm:2027" for the yearly one). */
export function blackMondayPair(options: { keyBase: string; cycle: number; startTick: number }): NewsDraft[] {
  const { keyBase, cycle, startTick } = options;
  const common = {
    kind: 'macro',
    category: 'macro',
    scope: 'market',
    companyId: null,
    partnerId: null,
    sector: null,
    cycle,
    publishTick: startTick,
    startTick,
    permShare: 1,
    credibility: null,
  } as const;
  return [
    {
      ...common,
      key: `${keyBase}:crash`,
      slot: CRASH_SLOT,
      durationTicks: CRASH_TICKS,
      shape: 'front',
      immediacy: 'immediate',
      direction: 'negative',
      strength: 'extreme',
      realized: CRASH_TOTAL,
      headline: CRASH_HEADLINE,
      body: CRASH_BODY,
      breaking: true,
    },
    {
      ...common,
      key: `${keyBase}:recovery`,
      slot: RECOVERY_SLOT,
      durationTicks: RECOVERY_TICKS,
      shape: 'front',
      immediacy: 'gradual',
      direction: 'positive',
      strength: 'major',
      realized: RECOVERY_TOTAL,
      headline: RECOVERY_HEADLINE,
      body: RECOVERY_BODY,
      breaking: false,
    },
  ];
}

/**
 * The Black Monday stories that belong to news cycle `cycle` (a 24-hour stretch counted from genesis): those whose crash begins inside it.
 * Usually none; one pair on the day October 19 falls in. A pure function of (world seed, genesis, cycle).
 */
export function blackMondayDrafts(worldSeed: number, genesisMs: number, cycle: number): NewsDraft[] {
  const firstTick = cycle * NEWS_CYCLE_TICKS;
  const endTick = firstTick + NEWS_CYCLE_TICKS; // exclusive
  const fromYear = yearOfDays(Math.floor((genesisMs + firstTick * TICK_MS + CALENDAR_UTC_OFFSET_MS) / MS_DAY));
  const toYear = yearOfDays(Math.floor((genesisMs + (endTick - 1) * TICK_MS + CALENDAR_UTC_OFFSET_MS) / MS_DAY));
  const out: NewsDraft[] = [];
  for (let year = fromYear; year <= toYear; year += 1) {
    const startTick = tickOfMs(blackMondayStartMs(worldSeed, year), genesisMs);
    if (startTick >= 1 && startTick >= firstTick && startTick < endTick) out.push(...blackMondayPair({ keyBase: `bm:${year}`, cycle, startTick }));
  }
  return out;
}
