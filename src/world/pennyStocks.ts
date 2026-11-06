// Six penny stocks. Every company here is invented; none is a real firm.
//
// A penny stock is a share that costs less than one dollar. Real ones are tiny companies: their prices jump around, a few traders can
// move them, and one cent is a big step when the price is only 12 cents. They are ordinary micro-cap stocks of the game (the same kind of
// entry the hand-written stocks are, with the news, the order book and the chart every stock has); only the price is under a dollar.
//
// Like the thirty memecoins, the list is added to a world ONCE (server/world/runtime.ts seeds it when the owner's switch TQ_PENNY_STOCKS is
// on, which is the default) and the numbers are then saved WITH each company in the database, so editing this file later never changes a
// company that already exists. The lowest price any share can have is one cent (MIN_PRICE in params.ts); before the penny stocks the lowest
// was $1.00.
//
// This file only holds data: no randomness and no arithmetic beyond rounding a price to whole cents.

import type { CatalogEntry } from './catalogData';
import type { Personality, SectorId } from './params';

interface Seed {
  readonly ticker: string;
  readonly name: string;
  readonly sector: SectorId;
  readonly industry: string;
  /** Listing price in cents (always below $1.00). */
  readonly cents: number;
  readonly personality: Personality;
  readonly p1: string;
  readonly p2: string;
  readonly about: string;
}

export const PENNY_SEEDS: readonly Seed[] = [
  {
    ticker: 'DRFT',
    name: 'Driftwater Mobile',
    sector: 'tech',
    industry: 'Budget phone apps',
    cents: 42,
    personality: 'turnaround',
    p1: 'Drift Dialer',
    p2: 'Water Wallet Lite',
    about: 'A penny stock. A small phone-app maker that lost most of its users and says a big update will win them back. Its price is 42 cents, so one cent is a move of more than 2 %.',
  },
  {
    ticker: 'PWHS',
    name: 'Pennywhistle Foods',
    sector: 'consumer',
    industry: 'Snack foods',
    cents: 18,
    personality: 'declining',
    p1: 'Whistle Chips',
    p2: 'Penny Pretzels',
    about: 'A penny stock. An old snack brand that sells fewer bags every year. Cheap shares look like a bargain until you check why they are cheap.',
  },
  {
    ticker: 'DBGM',
    name: 'Dustbowl Gold Mining',
    sector: 'industrial',
    industry: 'Gold exploration',
    cents: 67,
    personality: 'volatile',
    p1: 'Dustbowl Drill Surveys',
    p2: 'Nugget Assay Lab',
    about: 'A penny stock. It owns the rights to dig in a dry valley and has not found much yet. One lucky sample can double the price; one empty hole can halve it.',
  },
  {
    ticker: 'SPRK',
    name: 'Sparkloop Energy',
    sector: 'energy',
    industry: 'Small solar kits',
    cents: 89,
    personality: 'growth',
    p1: 'Sparkloop Roof Kit',
    p2: 'Loop Battery Box',
    about: 'A penny stock that is growing. A tiny solar-kit maker with a few big orders. Its price is close to a dollar, and a good quarter could carry it over.',
  },
  {
    ticker: 'LNTR',
    name: 'Lanternroot Biosciences',
    sector: 'health',
    industry: 'Early drug testing',
    cents: 31,
    personality: 'volatile',
    p1: 'Lantern Trial Kit',
    p2: 'Rootline Screening',
    about: 'A penny stock. A lab with one drug in early tests and not much cash. Good test news can send it up a lot in a day, and bad news can do the opposite.',
  },
  {
    ticker: 'BRKN',
    name: 'Brokenbrook Media',
    sector: 'media',
    industry: 'Streaming reruns',
    cents: 12,
    personality: 'turnaround',
    p1: 'Brook Replay',
    p2: 'Broken Record Radio',
    about: 'A penny stock. A tiny streaming company that shows old reruns and is trying to start over. At 12 cents, a one-cent step is a move of more than 8 %.',
  },
];

/** The catalog entries of the six penny stocks, in their fixed order. */
export function pennyEntries(): CatalogEntry[] {
  return PENNY_SEEDS.map(
    (seed) =>
      ({
        ticker: seed.ticker,
        name: seed.name,
        sector: seed.sector,
        industry: seed.industry,
        tier: 'micro',
        price: seed.cents,
        personality: seed.personality,
        products: [seed.p1, seed.p2],
        description: seed.about,
      }) satisfies CatalogEntry,
  );
}
