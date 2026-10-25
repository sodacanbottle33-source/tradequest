// The catalog: every company of the world, derived deterministically from the hand-written entries (catalogData.ts) and a
// procedural generator for any number beyond them. The catalog does NOT depend on the world seed: company number 17 is
// the same company in every world. Nothing here changes after a company has been created — that is what keeps the market
// reproducible while the catalog grows. See docs/world.md §4.

import { deriveSeed, uniformAt } from '../engine/rng';
import { CATALOG_VERSION, CURATED, type CatalogEntry, type MemeProfile } from './catalogData';
import {
  ERA_TICKS,
  MAX_COMPANIES,
  PERSONALITIES,
  STOCK_SECTOR_IDS,
  SIGMA_FROM_DAILY,
  SIGMA_MARKET_FAST,
  SIGMA_SECTOR_FAST,
  SIGMA_FROM_VOL3M,
  TIER_INFO,
  sectorInfo,
  type Personality,
  type SectorId,
  type Tier,
} from './params';
import type { Company } from './types';

export { CATALOG_VERSION, CURATED };
export type { CatalogEntry };

/** The industries and product words the generator uses for a sector (the owner's own companies reuse them for their defaults). */
export function sectorVocabulary(sector: SectorId): { readonly industries: readonly string[]; readonly nouns: readonly string[] } {
  const v = VOCAB[sector];
  return { industries: v.industries, nouns: v.nouns };
}

/** Fixed seed for company traits. Changing it changes every company, so it is part of CATALOG_VERSION. */
const CATALOG_SEED = 20_261_015;

const FIRST_NAMES = ['Imogen', 'Marcus', 'Priya', 'Tobias', 'Lena', 'Hiro', 'Amara', 'Gideon', 'Sofia', 'Rafael', 'Nadia', 'Callum', 'Yuki', 'Ingrid', 'Tomas', 'Zara', 'Elias', 'Mei', 'Oskar', 'Leila', 'Dmitri', 'Hana', 'Felix', 'Rosa', 'Kwame', 'Astrid', 'Mateo', 'Noor', 'Jasper', 'Freya', 'Idris', 'Clara', 'Anders', 'Soraya', 'Henrik', 'Bianca', 'Kenji', 'Maren', 'Paolo', 'Thea', 'Rowan', 'Anika', 'Luca', 'Greta', 'Omar', 'Linnea', 'Ezra', 'Carmen', 'Viktor', 'Odette'];
const LAST_NAMES = ['Hartley', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Brandt', 'Castellano', 'Whitfield', 'Novak', 'Adeyemi', 'Sorensen', 'Ferreira', 'Kowalski', 'Abara', 'Delacroix', 'Hoshino', 'McAllister', 'Petrov', 'Ibarra', 'Vasquez', 'Thornton', 'Nakamura', 'Eriksen', 'Bellamy', 'Qureshi', 'Ashworth', 'Duarte', 'Lindgren', 'Rahman', 'Holloway', 'Varga', 'Montrose', 'Tsukamoto', 'Galvin', 'Obuya', 'Fairbanks', 'Rinaldi', 'Sato', 'Kessler', 'Pemberton', 'Aronson', 'Yilmaz', 'Prescott', 'Hale', 'Navarro', 'Ostrander', 'Vickers', 'Zielinski', 'Marlowe', 'Bishara'];
const CITIES = ['Portland', 'Denver', 'Austin', 'Rotterdam', 'Osaka', 'Leeds', 'Calgary', 'Dublin', 'Singapore', 'Zurich', 'Lisbon', 'Toronto', 'Seattle', 'Nagoya', 'Helsinki', 'Bristol', 'Perth', 'Boston', 'Oslo', 'Lyon', 'Phoenix', 'Gothenburg', 'Busan', 'Manchester', 'Raleigh', 'Antwerp', 'Hamburg', 'Minneapolis', 'Cork', 'Brisbane'];

interface SectorVocab {
  readonly industries: readonly string[];
  readonly suffixes: readonly string[];
  readonly nouns: readonly string[];
}

const VOCAB: Readonly<Record<SectorId, SectorVocab>> = {
  tech: { industries: ['Software', 'Cloud services', 'Semiconductors', 'IT services'], suffixes: ['Systems', 'Software', 'Networks', 'Micro', 'Digital', 'Data'], nouns: ['Cloud', 'Core', 'Edge', 'Stack', 'Suite', 'Link'] },
  ai: { industries: ['AI software', 'Machine-learning tools', 'AI hardware'], suffixes: ['AI', 'Intelligence', 'Cognition', 'Labs', 'Neural', 'Analytics'], nouns: ['Mind', 'Agent', 'Vision', 'Model', 'Copilot', 'Insight'] },
  robotics: { industries: ['Robotics', 'Factory automation', 'Autonomous machines'], suffixes: ['Robotics', 'Automation', 'Dynamics', 'Machines', 'Motion', 'Mechatronics'], nouns: ['Arm', 'Walker', 'Picker', 'Rover', 'Actuator', 'Fleet'] },
  energy: { industries: ['Oil and gas', 'Solar and wind', 'Energy storage', 'Fuel distribution'], suffixes: ['Energy', 'Power', 'Resources', 'Petroleum', 'Renewables', 'Fuels'], nouns: ['Field', 'Grid', 'Array', 'Pipeline', 'Cell', 'Reactor'] },
  health: { industries: ['Biotechnology', 'Medical devices', 'Diagnostics', 'Healthcare services'], suffixes: ['Therapeutics', 'Biosciences', 'Health', 'Medical', 'Diagnostics', 'Pharma'], nouns: ['Assay', 'Implant', 'Scan', 'Therapy', 'Panel', 'Care'] },
  finance: { industries: ['Regional banking', 'Insurance', 'Asset management', 'Financial technology'], suffixes: ['Bancorp', 'Capital', 'Financial', 'Mutual', 'Trust', 'Credit'], nouns: ['Card', 'Cover', 'Fund', 'Pay', 'Loan', 'Vault'] },
  transport: { industries: ['Shipping', 'Airlines', 'Trucking', 'Rail and logistics'], suffixes: ['Logistics', 'Freight', 'Airways', 'Shipping', 'Transit', 'Mobility'], nouns: ['Express', 'Line', 'Cargo', 'Route', 'Hub', 'Fleet'] },
  consumer: { industries: ['Packaged goods', 'Retail', 'Beverages', 'Household products'], suffixes: ['Brands', 'Goods', 'Foods', 'Retail', 'Provisions', 'Home'], nouns: ['Fresh', 'Select', 'Original', 'Classic', 'Basics', 'Pure'] },
  media: { industries: ['Video games', 'Streaming', 'Music', 'Publishing'], suffixes: ['Entertainment', 'Media', 'Studios', 'Interactive', 'Pictures', 'Audio'], nouns: ['Play', 'Stream', 'Studio', 'Live', 'Arcade', 'Channel'] },
  industrial: { industries: ['Chemicals', 'Steel and metals', 'Construction', 'Machinery'], suffixes: ['Industries', 'Materials', 'Works', 'Metals', 'Chemicals', 'Construction'], nouns: ['Alloy', 'Coat', 'Beam', 'Form', 'Grade', 'Cast'] },
  aero: { industries: ['Aircraft components', 'Satellites', 'Defense electronics'], suffixes: ['Aerospace', 'Aviation', 'Orbital', 'Defense', 'Aeronautics', 'Dynamics'], nouns: ['Wing', 'Orbit', 'Radar', 'Thrust', 'Link', 'Sentry'] },
  utilities: { industries: ['Electric power', 'Water services', 'Telecom networks', 'Gas distribution'], suffixes: ['Utilities', 'Electric', 'Water', 'Telecom', 'Infrastructure', 'Grid'], nouns: ['Grid', 'Line', 'Main', 'Tower', 'Meter', 'Station'] },
  emerging: { industries: ['Quantum technology', 'Synthetic biology', 'Advanced materials', 'Space technology'], suffixes: ['Labs', 'Frontier', 'Ventures', 'Technologies', 'Works', 'Futures'], nouns: ['Lab', 'Prototype', 'Core', 'Bio', 'Quantum', 'Orbit'] },
  // Never used by the generator (it skips the memecoin sector); the coins of memecoins.ts have their own products.
  meme: { industries: ['Memecoin'], suffixes: ['Coin'], nouns: ['Swap', 'Vault'] },
};

/** Where a memecoin's "headquarters" is (it has none: the line only fills the company page). */
const MEME_HOMES = ['the blockchain', 'a Discord server', 'a group chat', 'a forum thread', 'a mobile wallet', 'an anonymous server'];

const ONSETS = ['b', 'br', 'c', 'cl', 'd', 'dr', 'f', 'fl', 'g', 'gr', 'h', 'j', 'k', 'kr', 'l', 'm', 'n', 'p', 'pl', 'r', 's', 'st', 't', 'tr', 'v', 'z'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ea', 'ia', 'ou'];
const CODAS = ['lan', 'mir', 'vex', 'dyne', 'tron', 'pha', 'gen', 'lux', 'ora', 'nex', 'vio', 'rix', 'dal', 'zen', 'tera', 'mont', 'vara', 'nis', 'cor', 'lyn'];
const DESC_TEMPLATES = [
  '{name} is a {tier} {industry} company whose main product, {p1}, is sold mostly to business customers.',
  '{industry} specialist: its {p1} and {p2} lines account for most of {name}\'s sales.',
  '{name} is a {tier} {industry} company known for {p1}, expanding gradually into {p2}.',
  '{name} supplies {industry} customers with {p1} and {p2}.',
];

/** Deterministic random number for company `id`, stream position `k` (k ≥ 1). */
function rnd(id: number, k: number): number {
  return uniformAt(deriveSeed(CATALOG_SEED, id), k);
}

function lerp(range: readonly [number, number], u: number): number {
  return range[0] + (range[1] - range[0]) * u;
}

function pick<T>(list: readonly T[], u: number): T {
  const item = list[Math.min(list.length - 1, Math.floor(u * list.length))];
  if (item === undefined) throw new Error('Empty list');
  return item;
}

/** Square root by Newton's method with a fixed number of steps (pure arithmetic, identical on every machine). */
export function sqrtN(x: number): number {
  if (!(x >= 0)) throw new Error(`sqrtN needs x ≥ 0, got ${x}`);
  if (x === 0) return 0;
  let g = x >= 1 ? x : 1;
  for (let i = 0; i < 60; i += 1) g = 0.5 * (g + x / g);
  return g;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function lowerFirst(s: string): string {
  // Keep acronyms such as "IT services" and "AI software" as they are.
  if (s.length > 1 && s.charAt(1) === s.charAt(1).toUpperCase() && /[A-Z]/.test(s.charAt(1))) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Ticker for a coined name: first letter plus following consonants. */
function tickerFor(core: string, taken: ReadonlySet<string>): string {
  const letters = core.toUpperCase().replace(/[^A-Z]/g, '');
  const consonants = letters.slice(1).replace(/[AEIOU]/g, '');
  let base = (letters.charAt(0) + consonants).slice(0, 4);
  let pad = 1;
  while (base.length < 4) {
    base += letters.charAt(pad) || 'X';
    pad += 1;
  }
  let candidate = base;
  let step = 0;
  while (taken.has(candidate)) {
    step += 1;
    const swap = String.fromCharCode(65 + ((candidate.charCodeAt(3) - 65 + step) % 26));
    candidate = base.slice(0, 3) + swap;
    if (step > 26) candidate = base.slice(0, 2) + String.fromCharCode(65 + (step % 26)) + swap;
  }
  return candidate;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Entry for procedural company `id` (≥ number of curated entries). Pure function of (id, names already taken). */
function proceduralEntry(id: number, takenNames: ReadonlySet<string>, takenTickers: ReadonlySet<string>): CatalogEntry {
  const sector = STOCK_SECTOR_IDS[(id - CURATED.length) % STOCK_SECTOR_IDS.length] as SectorId;
  const vocab = VOCAB[sector];
  let attempt = 0;
  let name = '';
  let core = '';
  do {
    const k = 20 + attempt * 3;
    core = capitalise(pick(ONSETS, rnd(id, k)) + pick(VOWELS, rnd(id, k + 1)) + pick(CODAS, rnd(id, k + 2)));
    name = `${core} ${pick(vocab.suffixes, rnd(id, 3))}`;
    attempt += 1;
  } while (takenNames.has(name) && attempt < 200);
  if (takenNames.has(name)) throw new Error(`Could not find a free company name for id ${id}`);
  const tu = rnd(id, 4);
  const tier: Tier = tu < 0.25 ? 'micro' : tu < 0.55 ? 'small' : tu < 0.8 ? 'mid' : tu < 0.97 ? 'large' : 'mega';
  const pu = rnd(id, 5);
  const personality: Personality = pu < 0.22 ? 'steady' : pu < 0.4 ? 'growth' : pu < 0.58 ? 'cyclical' : pu < 0.74 ? 'volatile' : pu < 0.84 ? 'turnaround' : pu < 0.92 ? 'declining' : 'income';
  const range: Record<Tier, readonly [number, number]> = { micro: [300, 1500], small: [800, 4000], mid: [2000, 9000], large: [4000, 25000], mega: [15000, 60000] };
  const priceU = rnd(id, 6);
  const price = Math.round(lerp(range[tier], priceU * priceU) / 5) * 5;
  const industry = pick(vocab.industries, rnd(id, 7));
  const n1 = pick(vocab.nouns, rnd(id, 8));
  const n2 = pick(vocab.nouns.filter((n) => n !== n1), rnd(id, 9));
  const p1 = `${core} ${n1}`;
  const p2 = `${core} ${n2}`;
  const desc = pick(DESC_TEMPLATES, rnd(id, 10))
    .replace('{name}', name)
    .replace('{name}', name)
    .replace('{tier}', TIER_INFO[tier].label.toLowerCase())
    .replace('{industry}', lowerFirst(industry))
    .replace('{p1}', p1)
    .replace('{p2}', p2);
  return {
    ticker: tickerFor(core, takenTickers),
    name,
    sector,
    industry,
    tier,
    price,
    personality,
    products: [p1, p2],
    description: desc.charAt(0).toUpperCase() + desc.slice(1),
  };
}

/** The shares a memecoin trades per day (never fewer than 10,000): the number its order book is built from. */
export function memeAdv(m: Pick<MemeProfile, 'supply' | 'turnover'>): number {
  return Math.max(10_000, Math.round((m.supply * m.turnover) / 100) * 100);
}

/**
 * A memecoin: the same kind of company as a stock, but it states its own numbers (supply, liquidity, how wildly it moves) instead of
 * taking them from a size class. A coin's 3-minute move is typically 7 % … 45 %, against 0.7 % … 7.5 % for a stock.
 */
function deriveMemeCompany(id: number, entry: CatalogEntry, m: MemeProfile, listingTick: number, peerId: number): Company {
  if (entry.sector !== 'meme') throw new Error(`${entry.ticker} has a memecoin profile but is not in the memecoin sector`);
  const sector = sectorInfo(entry.sector);
  const liquidity = m.liquidity;
  const lowLiq = 1 - liquidity;
  const spreadBps = round1(8 + 150 * lowLiq * lowLiq);
  const shares = m.supply;
  const floatShares = Math.min(shares, Math.max(1, Math.round(shares * m.floatFrac)));
  const adv = memeAdv(m);
  const sigmaD = m.vol3m * SIGMA_FROM_VOL3M;
  const beta = 1.6;
  const mk = beta * SIGMA_MARKET_FAST;
  const sc = sector.sectorBeta * SIGMA_SECTOR_FAST;
  const sigmaTick = sqrtN(sigmaD * sigmaD + mk * mk + sc * sc);
  return {
    id,
    ticker: entry.ticker,
    name: entry.name,
    sector: entry.sector,
    industry: entry.industry,
    description: entry.description,
    personality: entry.personality,
    tier: entry.tier,
    listingTick,
    basePriceCents: entry.price,
    ...(m.priceScale !== undefined && m.priceScale !== 1 ? { priceScale: m.priceScale } : {}),
    sharesOutstanding: shares,
    floatShares,
    avgDailyVolume: adv,
    liquidity,
    spreadBps,
    beta,
    sectorBeta: sector.sectorBeta,
    vol3m: m.vol3m,
    sigmaD,
    sigmaTick,
    sigmaM: sigmaD * 0.00035,
    sigmaF: m.dailyVol * SIGMA_FROM_DAILY,
    driftDay: m.driftDay * (0.7 + 0.6 * rnd(id, 18)),
    pUp: 0.42,
    pFlat: 0.16,
    pDown: 0.42,
    stickiness: 0.3,
    anchorDir: 0,
    eraOffset: Math.floor(rnd(id, 19) * ERA_TICKS),
    newsSensitivity: m.newsImpact,
    products: entry.products,
    ceo: m.dev,
    cfo: 'the community treasury',
    hq: pick(MEME_HOMES, rnd(id, 34)),
    peerId,
  };
}

/** Turns an entry into a full company with all derived traits. */
function deriveCompany(id: number, entry: CatalogEntry, listingTick: number, peerId: number): Company {
  if (entry.meme) return deriveMemeCompany(id, entry, entry.meme, listingTick, peerId);
  if (entry.sector === 'meme') throw new Error(`${entry.ticker} is in the memecoin sector but has no memecoin numbers`);
  const tier = TIER_INFO[entry.tier];
  const personality = PERSONALITIES[entry.personality];
  const sector = sectorInfo(entry.sector);
  const capU = rnd(id, 11);
  const capDollars = tier.capLo + (tier.capHi - tier.capLo) * capU * capU;
  const priceDollars = entry.price / 100;
  const shares = Math.max(1_000_000, Math.round(capDollars / priceDollars / 1000) * 1000);
  const floatShares = Math.min(shares, Math.round((shares * tier.floatFrac * (0.9 + 0.2 * rnd(id, 12))) / 100) * 100);
  const adv = Math.max(10_000, Math.round((shares * tier.turnover * (0.7 + 0.7 * rnd(id, 13))) / 100) * 100);
  const liquidity = Math.round(lerp(tier.liquidity, rnd(id, 14)) * 1000) / 1000;
  const lowLiq = 1 - liquidity;
  const spreadBps = round1(3 + 90 * lowLiq * lowLiq);
  const volMult = sector.volMult * personality.volMult;
  const vol3m = Math.min(0.085, Math.max(0.005, lerp(tier.vol3m, rnd(id, 15)) * volMult));
  const dailyVol = Math.min(0.12, Math.max(0.006, lerp(tier.dailyVol, rnd(id, 16)) * (0.5 + 0.5 * volMult)));
  const sigmaD = vol3m * SIGMA_FROM_VOL3M;
  const beta = Math.round(tier.beta * (0.8 + 0.4 * rnd(id, 17)) * 100) / 100;
  const mk = beta * SIGMA_MARKET_FAST;
  const sc = sector.sectorBeta * SIGMA_SECTOR_FAST;
  const sigmaTick = sqrtN(sigmaD * sigmaD + mk * mk + sc * sc);
  return {
    id,
    ticker: entry.ticker,
    name: entry.name,
    sector: entry.sector,
    industry: entry.industry,
    description: entry.description,
    personality: entry.personality,
    tier: entry.tier,
    listingTick,
    basePriceCents: entry.price,
    sharesOutstanding: shares,
    floatShares,
    avgDailyVolume: adv,
    liquidity,
    spreadBps,
    beta,
    sectorBeta: sector.sectorBeta,
    vol3m,
    sigmaD,
    sigmaTick,
    sigmaM: sigmaD * 0.00035,
    sigmaF: dailyVol * SIGMA_FROM_DAILY,
    driftDay: tier.drift * (0.7 + 0.6 * rnd(id, 18)),
    pUp: personality.pUp,
    pFlat: personality.pFlat,
    pDown: personality.pDown,
    stickiness: personality.stickiness,
    anchorDir: personality.anchorDir,
    eraOffset: Math.floor(rnd(id, 19) * ERA_TICKS),
    newsSensitivity: Math.round(tier.impact * (0.8 + 0.4 * rnd(id, 2)) * 100) / 100,
    products: entry.products,
    ceo: `${pick(FIRST_NAMES, rnd(id, 30))} ${pick(LAST_NAMES, rnd(id, 31))}`,
    cfo: `${pick(FIRST_NAMES, rnd(id, 32))} ${pick(LAST_NAMES, rnd(id, 33))}`,
    hq: pick(CITIES, rnd(id, 34)),
    peerId,
  };
}

/**
 * The first `count` companies of the catalog. `listingTickOf` says when each company started trading (default 0 for all).
 * The result for company i never depends on `count`, so the catalog can grow without changing existing companies.
 *
 * `own` holds companies the owner made by hand: id → entry. An id in `own` takes that entry instead of the generated one (it can
 * never be a hand-written id). Such a company always gets the id that was next when it was made, so every company that existed
 * before it is unchanged, and companies generated after it simply avoid its name and ticker. The server keeps the entries in the
 * database, which is why they are part of "the catalog" that prices are a function of.
 */
export function buildCatalog(count: number, listingTickOf: (id: number) => number = () => 0, own: ReadonlyMap<number, CatalogEntry> = new Map()): Company[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_COMPANIES) throw new Error(`Bad company count ${count}`);
  for (const id of own.keys()) if (!Number.isInteger(id) || id < CURATED.length) throw new Error(`An own company cannot take id ${id}: ids below ${CURATED.length} belong to the hand-written companies`);
  const entries: CatalogEntry[] = [];
  const names = new Set<string>();
  const tickers = new Set<string>();
  for (let id = 0; id < count; id += 1) {
    const entry = own.get(id) ?? (id < CURATED.length ? (CURATED[id] as CatalogEntry) : proceduralEntry(id, names, tickers));
    names.add(entry.name);
    tickers.add(entry.ticker);
    entries.push(entry);
  }
  // Procedural names may not collide with curated ones that come later in the list: curated entries are all registered
  // first so that the procedural generator never picks one of them.
  // (Curated entries occupy ids 0 … 65; procedural ids start after them, so they are already in `names`.)
  const lastInSector = new Map<SectorId, number>();
  const peers: number[] = [];
  entries.forEach((entry, id) => {
    const previous = lastInSector.get(entry.sector);
    if (previous !== undefined) peers[id] = previous;
    lastInSector.set(entry.sector, id);
  });
  // The first company of a sector looks forward to the next curated company of the same sector (fixed forever).
  entries.forEach((entry, id) => {
    if (peers[id] !== undefined) return;
    let next = -1;
    for (let j = id + 1; j < CURATED.length; j += 1) {
      if ((CURATED[j] as CatalogEntry).sector === entry.sector) {
        next = j;
        break;
      }
    }
    peers[id] = next >= 0 ? next : id;
  });
  return entries.map((entry, id) => deriveCompany(id, entry, listingTickOf(id), peers[id] as number));
}

/**
 * Market capitalisation in cents: price × shares outstanding.
 *
 * Below 2^53 cents (about $90 trillion) the result is an exact whole number. A giant company pushed to the highest allowed
 * price ($1,000,000, see MAX_PRICE) can pass that; the product is then only approximate (a number within about one part in 10^16
 * of the true value, up to quintillions of dollars for a 30-billion-share giant), which is plenty for a size on a screen. It must never throw: one company with a huge
 * price would otherwise break the whole market list for every player.
 */
export function marketCapCents(priceCents: number, company: Pick<Company, 'sharesOutstanding'> & { readonly priceScale?: number }): number {
  if (!Number.isFinite(priceCents) || priceCents < 0) throw new Error(`Bad price ${priceCents}`);
  // A fine-priced coin's price is in units of 1/priceScale cent: divide first so the product stays a sensible size (the result is approximate then, which is plenty for a size on a screen).
  const scale = company.priceScale ?? 1;
  return scale === 1 ? priceCents * company.sharesOutstanding : Math.round((priceCents / scale) * company.sharesOutstanding);
}
