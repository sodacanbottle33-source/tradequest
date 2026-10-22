// The thirty memecoins of the world. Every coin, developer and project here is invented; none is a real token.
//
// A memecoin is a company like any other (it has a ticker, a price, a market cap, an order book, news and a chart), but it moves
// far more: a stock's typical 3-minute move is under 1 %, a coin's is 7 % … 45 %, so a position can win or lose a fortune in
// seconds. The coins come in four sizes: "blue" (the old, big, liquid ones), "mid", "small" and "micro" (tiny, thin, wild).
//
// The list is added to the world once (server/world/runtime.ts seeds it) and the numbers are then saved WITH each coin in the
// database, so editing this file never changes a coin that already exists. Prices are whole dollars-and-cents from $3.60 to
// $118.50: the market's lowest possible price is $1.00 (MIN_PRICE), so a coin that "rugs" ends up sitting at $1.00.

import type { CatalogEntry, MemeProfile } from './catalogData';
import { tierOfCap } from './params';

export type MemeSize = 'blue' | 'mid' | 'small' | 'micro';

/** What a size means: the numbers every coin of that size shares (a coin states the rest itself). */
const SIZE: Readonly<Record<MemeSize, Pick<MemeProfile, 'floatFrac' | 'turnover' | 'dailyVol' | 'newsImpact' | 'driftDay'>>> = {
  blue: { floatFrac: 0.8, turnover: 0.3, dailyVol: 0.12, newsImpact: 2.5, driftDay: 0.03 },
  mid: { floatFrac: 0.7, turnover: 0.6, dailyVol: 0.2, newsImpact: 3.5, driftDay: 0.05 },
  small: { floatFrac: 0.55, turnover: 1.0, dailyVol: 0.3, newsImpact: 5, driftDay: 0.08 },
  micro: { floatFrac: 0.4, turnover: 1.6, dailyVol: 0.5, newsImpact: 7, driftDay: 0.12 },
};

interface Seed {
  readonly size: MemeSize;
  readonly ticker: string;
  readonly name: string;
  /** Listing price in dollars. */
  readonly price: number;
  /** Market cap at listing in millions of dollars. */
  readonly capM: number;
  readonly liquidity: number;
  readonly vol3m: number;
  readonly dev: string;
  readonly p1: string;
  readonly p2: string;
  readonly about: string;
}

const s = (size: MemeSize, ticker: string, name: string, price: number, capM: number, liquidity: number, vol3m: number, dev: string, p1: string, p2: string, about: string): Seed => ({
  size,
  ticker,
  name,
  price,
  capM,
  liquidity,
  vol3m,
  dev,
  p1,
  p2,
  about,
});

export const MEME_SEEDS: readonly Seed[] = [
  // ---- blue: the old, big, liquid coins ----
  s('blue', 'WOOF', 'MoonWoof', 42.0, 3200, 0.74, 0.07, 'BigBarkBaron', 'WoofSwap', 'Moon Kibble NFTs', 'A cartoon puppy who is sure he is flying to the moon. The oldest and biggest dog coin on the market, held by a very loyal pack.'),
  s('blue', 'HOPP', 'HoppityFrog', 118.5, 2100, 0.7, 0.08, 'LilypadLarry', 'Hop Wallet', 'Lilypad Launchpad', 'A frog on a lily pad with a fanatical community and a rare habit of keeping its promises.'),
  s('blue', 'MEOW', 'CosmicMeow', 9.4, 1500, 0.66, 0.09, 'WhiskerWizard', 'Meow Bridge', 'Laser Pointer DAO', 'A space-travelling cat coin. Its fans say it always lands on its feet; its charts say otherwise.'),
  // ---- mid ----
  s('mid', 'BEEF', 'BeefBoy', 15.2, 640, 0.55, 0.11, 'GrillMasterGus', 'Beef Vault', 'Medium Rare Rewards', 'A muscular cow with strong opinions about barbecue and a treasury that pays holders in imaginary steak.'),
  s('mid', 'TOST', 'ToastCoin', 6.75, 420, 0.5, 0.12, 'ButteredBandit', 'Toast Terminal', 'Jam Pool', 'Everyone says it is just bread. Everyone also keeps buying it. Crunchy when it rises.'),
  s('mid', 'YOLO', 'YoloYeti', 27.8, 880, 0.52, 0.12, 'SnowboundSam', 'Yeti Leverage Lab', 'Avalanche Alerts', 'A mountain monster whose whole strategy is putting everything in at once. The community calls this a feature.'),
  s('mid', 'HODL', 'HodlHippo', 33.1, 310, 0.48, 0.1, 'SteadyGrip', 'Hippo Staking', 'Mud Bath Rewards', 'A large, patient hippo that never sells. Its holders wear that as a badge of honour, and sometimes as a bruise.'),
  s('mid', 'DEGN', 'DegenDuck', 4.9, 270, 0.45, 0.14, 'QuackAttack', 'Duck Casino', 'Pond Perps', 'A duck that treats every trade as a coin flip. Loved by people who read charts upside down.'),
  s('mid', 'PMPY', 'PumpPenguin', 12.6, 190, 0.42, 0.15, 'IcebergIggy', 'Penguin Pump Room', 'Floe Finance', 'A penguin who slides in on every rally. Famously quick to run when the ice cracks.'),
  s('mid', 'LMBO', 'LamboLlama', 58.0, 450, 0.46, 0.13, 'WheelsWillie', 'Llama Garage', 'Wen Lambo Tracker', 'A llama obsessed with sports cars. Holders keep promising to buy one with the profit.'),
  s('mid', 'BANA', 'BananaBoss', 8.25, 150, 0.4, 0.16, 'PeelPatrol', 'Banana Bank', 'Split Swap', 'A monkey mob boss of the banana trade. Slips easily, usually on his own peel.'),
  // ---- small ----
  s('small', 'SOCK', 'SockPuppet', 3.6, 55, 0.3, 0.18, 'LeftSideLou', 'Sock Mixer', 'Drawer Vault', 'A coin run by what looks like one person with many accounts. Cheerful, shameless and surprisingly popular.'),
  s('small', 'GIGA', 'GigaGoose', 21.4, 88, 0.32, 0.17, 'HonkHodler', 'Goose Gateway', 'Honk Index', 'A very loud goose. Makes a lot of noise, and every so often a lot of money.'),
  s('small', 'PIZZ', 'PizzaPanda', 7.3, 41, 0.28, 0.2, 'SliceSensei', 'Panda Pizza Pool', 'Extra Cheese Staking', 'A panda who accepts only pizza as payment. Strongest on Friday nights.'),
  s('small', 'NOOB', 'NoobNarwhal', 5.15, 26, 0.24, 0.22, 'FreshPlayerOne', 'Narwhal Noob Lab', 'First Trade Faucet', 'A beginner-friendly whale-ish creature. Beginners buy it at the top so you do not have to.'),
  s('small', 'SIGM', 'SigmaSloth', 14.0, 72, 0.3, 0.19, 'GrindsetGreg', 'Sloth Grindset', 'Slow Money Vault', 'A sloth that wakes up once a day to say it is working. Moves slowly until it does not.'),
  s('small', 'GOBL', 'GoblinGold', 9.9, 33, 0.26, 0.23, 'HoardHerald', 'Goblin Hoard', 'Shiny Rock Swap', 'A cave goblin who hoards shiny things. If you see him sell, check your pockets.'),
  s('small', 'DRIP', 'DripDragon', 18.75, 64, 0.29, 0.2, 'FashionFlame', 'Drip Drops', 'Scale Couture', 'A dragon with excellent taste in jackets. Sets trends, then burns them.'),
  s('small', 'BOOP', 'BoopBunny', 4.4, 19, 0.22, 0.25, 'NoseNinja', 'Boop Button', 'Carrot Cache', 'A bunny that boops the buy button for you. Cute, bouncy and not to be trusted with stop-losses.'),
  s('small', 'ZOOM', 'ZoomZebra', 11.2, 47, 0.27, 0.24, 'StripeSprinter', 'Zebra Express', 'Stripe Scanner', 'A zebra that runs everywhere at once. Often crosses the finish line a lap early.'),
  s('small', 'MNCH', 'MunchMonkey', 6.1, 28, 0.23, 0.26, 'SnackScout', 'Munch Mine', 'Crunch Rewards', 'A monkey that eats anything left on the table, including other coins\' liquidity.'),
  s('small', 'VIBE', 'VibeVulture', 16.5, 81, 0.31, 0.19, 'ThermalTed', 'Vibe Radar', 'Carrion Calls', 'A vulture who senses mood before the market does. Circles every rally and every crash.'),
  s('small', 'TACO', 'TacoTiger', 10.7, 15, 0.2, 0.27, 'SalsaStripe', 'Taco Truck Pool', 'Tuesday Treasury', 'A tiger with a food truck and a very short attention span. Hot on Tuesdays.'),
  // ---- micro: tiny, thin and wild ----
  s('micro', 'FOMO', 'FomoFox', 8.8, 7.9, 0.12, 0.3, 'LastToArrive', 'Fox Alert Bot', 'Chase Chart', 'A fox that always arrives just after the pump. Its fans buy high on principle.'),
  s('micro', 'GMGM', 'GoodMorningGorilla', 5.6, 4.2, 0.1, 0.33, 'SunriseApe', 'GM Greeter', 'Banana Alarm', 'A gorilla who posts good morning to nobody in particular. A community of eight thousand and one bot.'),
  s('micro', 'OOGA', 'OogaOwl', 12.3, 6.1, 0.09, 0.35, 'NightShiftNed', 'Owl Oracle', 'Hoot Index', 'A wise-sounding owl that only says one word. Traders read deep meaning into it.'),
  s('micro', 'SUSY', 'SusSquid', 7.45, 2.8, 0.07, 0.38, 'InkyIvan', 'Squid Ink Mixer', 'Tentacle Treasury', 'Suspiciously cheap, suspiciously quiet, suspiciously easy to buy. Nobody knows who runs it.'),
  s('micro', 'BLEP', 'BlepBat', 9.05, 1.9, 0.06, 0.4, 'TongueOutTim', 'Blep Bot', 'Cave Pool', 'A bat with its tongue permanently out. Flies erratically and roosts at the bottom.'),
  s('micro', 'SNAX', 'SnaxSnail', 6.2, 3.3, 0.08, 0.36, 'SlimeTrailSue', 'Snax Slider', 'Shell Vault', 'A snail that sells snacks. Very slow to confirm trades and very fast to disappear.'),
  s('micro', 'RUGZ', 'RugRaccoon', 14.9, 1.2, 0.04, 0.45, 'TrashPandaPete', 'Rug Roulette', 'Bin Diver', 'A raccoon who pulled a rug once and says he will not do it again. His liquidity is mostly in the trash.'),
];

/** Rounded cap class for the size column (display and the news use the tier names of the stocks). */
function tierFor(capM: number): CatalogEntry['tier'] {
  return tierOfCap(capM * 1e6);
}

/** The catalog entries of the thirty coins, in their fixed order. */
export function memeEntries(): CatalogEntry[] {
  return MEME_SEEDS.map((seed) => {
    const base = SIZE[seed.size];
    const priceCents = Math.round(seed.price * 100);
    const supply = Math.max(1, Math.round((seed.capM * 1e6) / seed.price));
    const meme: MemeProfile = {
      supply,
      floatFrac: base.floatFrac,
      turnover: base.turnover,
      liquidity: seed.liquidity,
      vol3m: seed.vol3m,
      dailyVol: base.dailyVol,
      newsImpact: base.newsImpact,
      driftDay: base.driftDay,
      dev: seed.dev,
    };
    return {
      ticker: seed.ticker,
      name: seed.name,
      sector: 'meme',
      industry: 'Memecoin',
      tier: tierFor(seed.capM),
      price: priceCents,
      personality: 'volatile',
      products: [seed.p1, seed.p2],
      description: seed.about,
      meme,
    } satisfies CatalogEntry;
  });
}
