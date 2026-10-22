// Measures how fast the persistent world is on THIS computer: catching up after downtime, writing news, and one live second.
//   npx tsx tools/bench-world.ts            (66, 300 and 1000 companies)
//   npx tsx tools/bench-world.ts 500        (a number you choose)
// It uses a temporary folder and deletes it afterwards. Nothing in your real data folder is touched.

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { TICKS_PER_DAY } from '../src/world';
import { Logger } from '../server/log';
import { NewsService } from '../server/news/service';
import { migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { WorldRuntime } from '../server/world/runtime';

function bench(count: number): void {
  const dir = mkdtempSync(join(tmpdir(), 'tq-bench-'));
  try {
    let ms = Date.UTC(2026, 9, 1, 12, 0, 0);
    const now = (): number => ms;
    const db = new Db(join(dir, 'world.sqlite'));
    migrate(db);
    const log = new Logger({ sink: null, now });
    const news = new NewsService({ db, log, now });
    const world = new WorldRuntime({ db, log, now, companyCount: count, warmupDays: 1, worldSeed: 4242, news });

    let t0 = performance.now();
    world.init(); // simulates 1 day of history and writes its news
    const initMs = performance.now() - t0;

    // Three days with the server off: catch up in one go.
    ms += 3 * 86_400_000;
    t0 = performance.now();
    world.advanceTo(world.currentTick(), Infinity);
    const catchMs = performance.now() - t0;
    const catchTicks = 3 * TICKS_PER_DAY;

    // A normal live second.
    const samples: number[] = [];
    for (let i = 0; i < 120; i += 1) {
      ms += 1000;
      const a = performance.now();
      world.pump();
      samples.push(performance.now() - a);
    }
    samples.sort((x, y) => x - y);

    // Writing a fresh day of news for every company.
    t0 = performance.now();
    news.ensureThrough(world.currentTick() + 10 * TICKS_PER_DAY);
    const newsMs = performance.now() - t0;
    const items = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_items')?.n ?? 0;
    const days = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM news_cycles')?.n ?? 1;

    const size = statSync(join(dir, 'world.sqlite')).size + (() => { try { return statSync(join(dir, 'world.sqlite-wal')).size; } catch { return 0; } })();
    console.log(
      [
        `${String(count).padStart(5)} companies:`,
        `1 day of history ${(initMs / 1000).toFixed(1)} s (${Math.round((TICKS_PER_DAY * count) / initMs)}k company-ticks/s),`,
        `3 days of downtime caught up in ${(catchMs / 1000).toFixed(1)} s (${(catchTicks / (catchMs / 1000)).toFixed(0)} ticks/s),`,
        `one live second ${samples[Math.floor(samples.length / 2)]?.toFixed(2)} ms (worst of 120: ${samples[samples.length - 1]?.toFixed(2)} ms),`,
        `10 days of news ${(newsMs / 1000).toFixed(2)} s (${items} items, ${(items / days).toFixed(0)} per day),`,
        `database ${(size / 1_048_576).toFixed(1)} MB after ${days} days`,
      ].join(' '),
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const requested = process.argv[2] ? [Number(process.argv[2])] : [66, 300, 1000];
for (const n of requested) bench(n);
