// Helpers for the persistent-world tests.
import { EffectBook, WorldSim, buildCatalog, effectsOf, type Company, type WorldEvent } from '../../src/world';

export function makeEvent(partial: Partial<WorldEvent> & { key: string }): WorldEvent {
  return {
    kind: 'ordinary',
    scope: 'company',
    companyId: 0,
    partnerId: null,
    sector: null,
    publishTick: 0,
    startTick: 10,
    durationTicks: 60,
    shape: 'front',
    realized: 0.05,
    permShare: 0.5,
    ...partial,
  };
}

export function bookOf(events: readonly WorldEvent[], companies: readonly Company[]): EffectBook {
  return new EffectBook(events.flatMap((e) => effectsOf(e, companies)));
}

/** A world of the first `count` catalog companies, stepped `ticks` ticks. */
export function runWorld(seed: number, count: number, ticks: number, events: readonly WorldEvent[] = []): { sim: WorldSim; companies: Company[] } {
  const companies = buildCatalog(count);
  const sim = new WorldSim(seed, companies);
  const book = bookOf(events, companies);
  for (let i = 0; i < ticks; i += 1) sim.step(book);
  return { sim, companies };
}

/** Price of every listed company at every tick 0 … ticks: result[i][t]. */
export function priceTable(seed: number, count: number, ticks: number, events: readonly WorldEvent[] = []): number[][] {
  const companies = buildCatalog(count);
  const sim = new WorldSim(seed, companies);
  const book = bookOf(events, companies);
  const table: number[][] = companies.map(() => []);
  const record = (): void => {
    for (let i = 0; i < companies.length; i += 1) (table[i] as number[]).push(sim.P[i] as number);
  };
  record();
  for (let t = 0; t < ticks; t += 1) {
    sim.step(book);
    record();
  }
  return table;
}
