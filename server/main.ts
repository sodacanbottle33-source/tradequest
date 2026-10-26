// Starts the TradeQuest server: the persistent market, accounts and the live stream.
//   npm run server            (or: npx tsx server/main.ts)
// Settings come from environment variables (see server/config.ts). The market state lives in data/tradequest.sqlite.
// On a host that erases its disk (Render's free plan) set TQ_BACKUP_REPO and TQ_BACKUP_TOKEN: the database is then saved to a private
// GitHub repository every few minutes and loaded back when the server starts with no database (server/cloudBackup.ts).

import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp } from './app';
import { BackupRunner, backupSettingsFromEnv, restoreIfMissing, storeFromSettings } from './cloudBackup';
import { loadConfig } from './config';
import { STOCK_FEE_BPS } from './fees';
import { Logger } from './log';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = new Logger({ level: config.logLevel });
  if (config.ai) log.info('learn', `The AI teacher is on (${config.ai.provider}, model ${config.ai.model}): at most ${config.ai.perUserDaily} comments per player and ${config.ai.globalDaily} in total per day.`);
  else if (config.aiProblem) log.warn('learn', `The AI teacher is OFF because its settings are wrong: ${config.aiProblem} The lessons still work with the built-in teacher.`);
  const backup = backupSettingsFromEnv(process.env);
  const store = backup ? storeFromSettings(backup) : null;
  let restored = false; // the store already holds exactly the world that was just loaded from it
  let runner: BackupRunner | null = null;
  if (store && backup) {
    log.info('backup', `Online data is on: copies are kept in ${store.describe}, one every ${Math.round((backup.intervalMs / 60_000) * 10) / 10} minutes.`);
    const status = await store.check();
    if (!status.isPrivate) log.warn('backup', `${status.repo} is a PUBLIC repository: anybody can download your database from it. Make it private.`);
    restored = (await restoreIfMissing(store, config.dbFile, log)).outcome === 'restored';
  }
  const app = createApp({ config, log, memecoins: config.memecoins, bots: config.bots, marketBots: config.marketBots, stockFeeBps: STOCK_FEE_BPS, staticDir: join(process.cwd(), 'dist') });
  const server = createServer((req, res) => {
    // Anything but a read may change saved data: the next scheduled save is then due (reads never change it).
    if (runner && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') res.once('close', () => runner?.markDirty());
    app.handler(req, res);
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Is another TradeQuest server running? Set TQ_PORT to use a different port.`);
    else console.error(error);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    app.start();
    if (store && backup) {
      runner = new BackupRunner({ store, db: app.services.db, log, intervalMs: backup.intervalMs, startDirty: !restored });
      runner.start();
    }
    console.log(`TradeQuest server is running at http://${config.host}:${config.port}  (market at tick ${app.services.world.sim.tick}; data in ${config.dataDir})`);
  });
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: stopping. The market keeps its place and catches up when you start again.`);
    server.close();
    const finish = (): never => {
      app.close();
      process.exit(0);
    };
    if (!runner) finish();
    // One last copy of the data before the host takes the disk away (it allows about 30 seconds).
    void runner!.final(20_000).then(finish, finish);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
