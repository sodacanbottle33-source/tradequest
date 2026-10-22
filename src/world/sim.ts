// The simulation of the whole world, one tick at a time. A stock's price is the product of two parts:
//   • a slowly moving FUNDAMENTAL value F (trend regimes, company news that lasts, the market and sector mood), and
//   • a fast DEVIATION D around it (noise, momentum, order-flow pressure, short-lived news reactions) that always relaxes
//     back toward zero.
//   price = round(F · (1 + D)).
// Every random number is read from a seeded stream by position, so the same (seed, catalog, events) always gives the same
// prices — on any machine, after any restart. See docs/world.md §5 for the equations and the reasons for each term.

import { deriveSeed, hashUniformAt, normal6At } from '../engine/rng';
import * as params from './params';
import { SECTOR_IDS, sectorIndex } from './params';
import type { EffectBook } from './effects';
import type { Company, StockState, WorldSnapshot } from './types';

// The loop in step() runs hundreds of millions of times when a stopped server catches up. Reading module-level constants
// through an import namespace is slow in some loaders, so the numbers it needs are copied into plain locals once.
const {
  ANCHOR_DRIFT_DAY,
  ANCHOR_PULL,
  DAILY_DRAW_BASE,
  DEVIATION_CAP,
  DRAWS_PER_TICK,
  ERA_TICKS,
  FLOW_NOISE,
  FLOW_PRESSURE,
  MARKET_DRAWS_PER_TICK,
  MARKET_STREAM_INDEX,
  MAX_PRICE,
  MIN_PRICE,
  SECTOR_STREAM_BASE,
  SHOCK_V,
  SIGMA_MARKET_FAST,
  SIGMA_MARKET_SLOW,
  SIGMA_SECTOR_FAST,
  SIGMA_SECTOR_SLOW,
  THETA_D,
  THETA_M,
  THETA_MARKET,
  THETA_Q,
  THETA_SECTOR,
  THETA_V,
  TICKS_PER_DAY,
  V_MAX,
  V_MIN,
  WORLD_ENGINE_VERSION,
} = params;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export class WorldSim {
  readonly worldSeed: number;
  readonly companies: readonly Company[];
  readonly n: number;
  /** The last tick that has been simulated. Tick 0 is the first price of every company that is listed at genesis. */
  tick = 0;

  // ---- per-stock state (struct of arrays, indexed by company id) ----
  readonly F: Float64Array;
  readonly D: Float64Array;
  readonly M: Float64Array;
  readonly V: Float64Array;
  readonly Q: Float64Array;
  readonly A: Float64Array;
  /** Last traded (mid) price in cents; 0 while the company is not listed yet. */
  readonly P: Float64Array;
  readonly regime: Int8Array;
  readonly listed: Uint8Array;
  /** Shares traded during the most recent tick. */
  readonly volume: Float64Array;
  /** Size of the most recent tick's move, |P_t / P_(t−1) − 1| (feeds the volatility regime). */
  readonly R: Float64Array;

  // ---- market-wide state ----
  S = 0;
  readonly sectorS: Float64Array;

  private readonly stockSeed: Uint32Array;
  private readonly daySeed: Uint32Array;
  private readonly marketSeed: number;
  private marketDaySeed = 0;
  private readonly sectorSeed: Uint32Array;
  private readonly sectorDaySeed: Uint32Array;
  private readonly sectorOf: Int16Array;
  private seedDay = -1;

  // scratch arrays (reused every tick)
  private readonly secFast = new Float64Array(SECTOR_IDS.length);
  private readonly transient: Float64Array;
  private readonly permanent: Float64Array;

  constructor(worldSeed: number, companies: readonly Company[]) {
    if (!Number.isInteger(worldSeed) || worldSeed < 0 || worldSeed > 0xffffffff) throw new Error(`Bad world seed ${worldSeed}`);
    this.worldSeed = worldSeed;
    this.companies = companies;
    this.n = companies.length;
    const n = this.n;
    this.F = new Float64Array(n);
    this.D = new Float64Array(n);
    this.M = new Float64Array(n);
    this.V = new Float64Array(n).fill(1);
    this.Q = new Float64Array(n);
    this.A = new Float64Array(n);
    this.P = new Float64Array(n);
    this.R = new Float64Array(n);
    this.regime = new Int8Array(n);
    this.listed = new Uint8Array(n);
    this.volume = new Float64Array(n);
    this.transient = new Float64Array(n);
    this.permanent = new Float64Array(n);
    this.sectorS = new Float64Array(SECTOR_IDS.length);
    this.stockSeed = new Uint32Array(n);
    this.daySeed = new Uint32Array(n);
    this.sectorOf = new Int16Array(n);
    this.marketSeed = deriveSeed(worldSeed, MARKET_STREAM_INDEX);
    this.sectorSeed = new Uint32Array(SECTOR_IDS.length);
    this.sectorDaySeed = new Uint32Array(SECTOR_IDS.length);
    for (let s = 0; s < SECTOR_IDS.length; s += 1) this.sectorSeed[s] = deriveSeed(worldSeed, SECTOR_STREAM_BASE + s);
    companies.forEach((c, i) => {
      if (c.id !== i) throw new Error(`Company ${c.ticker} has id ${c.id} at position ${i}`);
      this.stockSeed[i] = deriveSeed(worldSeed, i);
      this.sectorOf[i] = sectorIndex(c.sector);
    });
    // Everything listed at genesis starts at tick 0.
    for (const c of companies) if (c.listingTick === 0) this.list(c.id, 0);
  }

  // ---- listing ---------------------------------------------------------------------------------------------------

  private list(i: number, tick: number): void {
    const c = this.companies[i] as Company;
    this.refreshDaySeeds(Math.floor(tick / TICKS_PER_DAY));
    const price = c.basePriceCents;
    this.F[i] = price;
    this.A[i] = price;
    this.P[i] = price;
    this.R[i] = 0;
    this.D[i] = 0;
    this.M[i] = 0;
    this.V[i] = 1;
    this.Q[i] = 0;
    this.volume[i] = 0;
    this.regime[i] = this.pickRegime(i, DAILY_DRAW_BASE + 3);
    this.listed[i] = 1;
  }

  /** A trend regime for company i from the personality's up / flat / down probabilities (one uniform draw). */
  private pickRegime(i: number, drawNumber: number): number {
    const c = this.companies[i] as Company;
    const v = hashUniformAt(this.daySeed[i] as number, drawNumber);
    const x = v * (c.pUp + c.pFlat + c.pDown);
    return x < c.pUp ? 1 : x < c.pUp + c.pFlat ? 0 : -1;
  }

  /** At the end of an era the regime continues with probability `stickiness`, otherwise a new one is drawn. */
  private nextRegime(i: number, current: number): number {
    const c = this.companies[i] as Company;
    const u = hashUniformAt(this.daySeed[i] as number, DAILY_DRAW_BASE);
    return u < c.stickiness ? current : this.pickRegime(i, DAILY_DRAW_BASE + 1);
  }

  private refreshDaySeeds(day: number): void {
    if (day === this.seedDay) return;
    this.seedDay = day;
    this.marketDaySeed = deriveSeed(this.marketSeed, day);
    for (let s = 0; s < SECTOR_IDS.length; s += 1) this.sectorDaySeed[s] = deriveSeed(this.sectorSeed[s] as number, day);
    for (let i = 0; i < this.n; i += 1) this.daySeed[i] = deriveSeed(this.stockSeed[i] as number, day);
  }

  // ---- one tick ---------------------------------------------------------------------------------------------------

  /** Advances the whole world by exactly one tick. */
  step(effects: EffectBook): void {
    const t = this.tick + 1;
    const day = Math.floor(t / TICKS_PER_DAY);
    this.refreshDaySeeds(day);
    const idx = t - day * TICKS_PER_DAY; // 0 … 86399

    // Companies that begin trading exactly now.
    for (let i = 0; i < this.n; i += 1) {
      if (this.listed[i] === 0 && (this.companies[i] as Company).listingTick === t) this.list(i, t);
    }

    // Market-wide and sector-wide factors.
    const mBase = 1 + idx * MARKET_DRAWS_PER_TICK;
    this.S = this.S * (1 - THETA_MARKET) + SIGMA_MARKET_SLOW * normal6At(this.marketDaySeed, mBase);
    const mkFast = SIGMA_MARKET_FAST * normal6At(this.marketDaySeed, mBase + 6);
    const secFast = this.secFast;
    for (let s = 0; s < SECTOR_IDS.length; s += 1) {
      const sBase = 1 + idx * MARKET_DRAWS_PER_TICK;
      const seed = this.sectorDaySeed[s] as number;
      this.sectorS[s] = (this.sectorS[s] as number) * (1 - THETA_SECTOR) + SIGMA_SECTOR_SLOW * normal6At(seed, sBase);
      secFast[s] = SIGMA_SECTOR_FAST * normal6At(seed, sBase + 6);
    }

    // News effects for this tick.
    this.transient.fill(0);
    this.permanent.fill(0);
    effects.apply(t, this.S, this.V, this.transient, this.permanent);

    const base = 1 + idx * DRAWS_PER_TICK;
    for (let i = 0; i < this.n; i += 1) {
      if (this.listed[i] === 0) continue;
      const c = this.companies[i] as Company;
      if (c.listingTick === t) continue; // first trading tick: the price is the listing price
      const seed = this.daySeed[i] as number;
      const sec = this.sectorOf[i] as number;

      // New trend regime at the start of each era.
      if ((t + c.eraOffset) % ERA_TICKS === 0 && t > c.listingTick) {
        this.regime[i] = this.nextRegime(i, this.regime[i] as number);
      }

      const zD = normal6At(seed, base);
      const zF = normal6At(seed, base + 6);
      const zM = normal6At(seed, base + 12);
      const zQ = normal6At(seed, base + 18);
      const uV = hashUniformAt(seed, base + 24);

      const trans = this.transient[i] as number;
      const perm = this.permanent[i] as number;

      // Fundamental value.
      let F = this.F[i] as number;
      let A = this.A[i] as number;
      A *= 1 + (c.anchorDir * ANCHOR_DRIFT_DAY) / TICKS_PER_DAY;
      const drift = ((this.regime[i] as number) * c.driftDay) / TICKS_PER_DAY;
      const pull = clamp(ANCHOR_PULL * (A / F - 1), -0.0005, 0.0005);
      F *= 1 + drift + c.sigmaF * zF + pull + c.beta * this.S + c.sectorBeta * (this.sectorS[sec] as number) + perm;
      F = clamp(F, MIN_PRICE, MAX_PRICE);

      // Volatility regime: big moves make the next ones bigger; it relaxes toward 1.
      const prevP = this.P[i] as number;
      const shock = Math.min((this.R[i] as number) / c.sigmaTick, 3);
      const V = clamp((this.V[i] as number) + THETA_V * (1 - (this.V[i] as number)) + SHOCK_V * (shock - 0.8), V_MIN, V_MAX);

      // Short-term price: momentum, order flow, market and sector noise, the transient part of news.
      const M = (this.M[i] as number) * (1 - THETA_M) + c.sigmaM * V * zM;
      const Q = clamp((this.Q[i] as number) * (1 - THETA_Q) + FLOW_NOISE * zQ, -4, 4);
      let D = (this.D[i] as number) * (1 - THETA_D) + c.sigmaD * V * zD + M + FLOW_PRESSURE * c.sigmaD * Q;
      D += c.beta * mkFast + c.sectorBeta * (secFast[sec] as number) + trans;
      D = clamp(D, -DEVIATION_CAP, DEVIATION_CAP);

      const price = clamp(Math.floor(F * (1 + D) + 0.5), MIN_PRICE, MAX_PRICE);

      // Volume: the usual daily rhythm, busier when volatile or when news is moving the price.
      const activity = 0.5 + 0.5 * V;
      const news = Math.abs(trans) + Math.abs(perm);
      const newsBoost = 1 + 0.5 * Math.min(6, news / c.sigmaTick);
      const volume = (c.avgDailyVolume / TICKS_PER_DAY) * activity * (0.5 + uV) * newsBoost;

      this.F[i] = F;
      this.A[i] = A;
      this.V[i] = V;
      this.M[i] = M;
      this.Q[i] = Q;
      this.D[i] = D;
      this.R[i] = Math.abs(price / prevP - 1);
      this.P[i] = price;
      this.volume[i] = volume;
    }
    this.tick = t;
  }

  // ---- reading -----------------------------------------------------------------------------------------------------

  /** Price of company i now (0 if it is not listed). */
  price(i: number): number {
    return this.P[i] as number;
  }

  isListed(i: number): boolean {
    return this.listed[i] === 1;
  }

  /** Volatility-regime multiplier of company i (1 = normal). */
  activity(i: number): number {
    return this.V[i] as number;
  }

  // ---- persistence -------------------------------------------------------------------------------------------------

  snapshot(): WorldSnapshot {
    const stocks: (StockState | null)[] = [];
    for (let i = 0; i < this.n; i += 1) {
      stocks.push(
        this.listed[i] === 1
          ? {
              F: this.F[i] as number,
              D: this.D[i] as number,
              M: this.M[i] as number,
              V: this.V[i] as number,
              Q: this.Q[i] as number,
              regime: this.regime[i] as number,
              A: this.A[i] as number,
              P: this.P[i] as number,
              R: this.R[i] as number,
            }
          : null,
      );
    }
    return {
      version: WORLD_ENGINE_VERSION,
      tick: this.tick,
      market: { S: this.S, sector: Array.from(this.sectorS) },
      stocks,
    };
  }

  static restore(worldSeed: number, companies: readonly Company[], snap: WorldSnapshot): WorldSim {
    if (snap.version !== WORLD_ENGINE_VERSION) throw new Error(`Snapshot is from engine version ${snap.version}, this is ${WORLD_ENGINE_VERSION}`);
    const sim = new WorldSim(worldSeed, companies);
    sim.tick = snap.tick;
    sim.S = snap.market.S;
    snap.market.sector.forEach((v, s) => {
      sim.sectorS[s] = v;
    });
    for (let i = 0; i < sim.n; i += 1) {
      const c = companies[i] as Company;
      const st = snap.stocks[i] ?? null;
      if (st === null) {
        // Not listed at the snapshot: legal only if it lists later.
        sim.listed[i] = 0;
        sim.P[i] = 0;
        sim.R[i] = 0;
        if (c.listingTick <= snap.tick) throw new Error(`${c.ticker} should already be listed at tick ${snap.tick} but has no stored state`);
        continue;
      }
      sim.F[i] = st.F;
      sim.D[i] = st.D;
      sim.M[i] = st.M;
      sim.V[i] = st.V;
      sim.Q[i] = st.Q;
      sim.regime[i] = st.regime;
      sim.A[i] = st.A;
      sim.P[i] = st.P;
      sim.R[i] = st.R;
      sim.listed[i] = 1;
    }
    return sim;
  }
}
