// Starts the TradeQuest server: the persistent market, accounts and the live stream.
//   npm run server            (or: npx tsx server/main.ts)
// Settings come from environment variables (see server/config.ts). The market state lives in data/tradequest.sqlite.

import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp } from './app';
import { loadConfig } from './config';

function main(): void {
  const config = loadConfig();
  const app = createApp({ config, memecoins: config.memecoins, bots: config.bots, marketBots: config.marketBots, staticDir: join(process.cwd(), 'dist') });
  const server = createServer(app.handler);
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Is another TradeQuest server running? Set TQ_PORT to use a different port.`);
    else console.error(error);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    app.start();
    console.log(`TradeQuest server is running at http://${config.host}:${config.port}  (market at tick ${app.services.world.sim.tick}; data in ${config.dataDir})`);
  });
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: stopping. The market keeps its place and catches up when you start again.`);
    server.close();
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
