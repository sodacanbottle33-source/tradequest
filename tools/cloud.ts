// Works with the online copies of the game's data (see server/cloudBackup.ts). Used from your own computer.
//   npm run cloud -- check     is the private repository reachable, is it private, which copies does it hold?
//   npm run cloud -- list      the copies, newest first
//   npm run cloud -- push      sends a copy of THIS computer's game (data/tradequest.sqlite) to the repository as the newest copy
//   npm run cloud -- pull      downloads the newest good copy to data/online-copy.sqlite (your own game is never touched)
// It reads TQ_BACKUP_REPO (owner/name) and TQ_BACKUP_TOKEN from the environment, the same two settings the online server uses.
// Nothing here changes your game: `push` only reads it. Use `--yes` to skip the question `push` asks when copies already exist.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import {
  BackupError,
  KEEP_COPIES,
  backupSettingsFromEnv,
  pruneCopies,
  restoreIfMissing,
  saveCopy,
  storeFromSettings,
  type BackupItem,
  type BackupLog,
  type BackupStore,
} from '../server/cloudBackup';
import { dataDirOf } from '../server/config';
import { currentVersion } from '../server/schema';
import { Db } from '../server/sqlite';

export interface CloudIo {
  out(line: string): void;
  /** Asks a yes/no question. */
  confirm(question: string): Promise<boolean>;
}

const USAGE = [
  'Usage:  npm run cloud -- <command>',
  '  check   look at the online store (is it reachable, is it private, which copies it holds)',
  '  list    list the copies, newest first',
  '  push    send a copy of this computer\'s game to the store as its newest copy  (add --yes to skip the question)',
  '  pull    download the newest good copy to data/online-copy.sqlite',
  'It needs TQ_BACKUP_REPO (owner/name) and TQ_BACKUP_TOKEN set in this window first.',
];

const SETUP_HELP = [
  'The two settings are missing. In this PowerShell window type (with your own repository and token):',
  '  $env:TQ_BACKUP_REPO = "your-github-name/tradequest-data"',
  '  $env:TQ_BACKUP_TOKEN = "github_pat_..."',
  'They last only as long as this window is open. Then run the command again.',
];

/** "tradequest-20261023T120000123Z.sqlite.gz" → a readable time; unknown names are shown as they are. */
export function whenOf(name: string): string {
  const m = /^tradequest-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\d{3}Z\.sqlite\.gz$/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC` : name;
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function describeCopies(copies: readonly BackupItem[], out: (line: string) => void): void {
  if (copies.length === 0) {
    out('  (no copies yet)');
    return;
  }
  copies.forEach((c, i) => out(`  ${i === 0 ? 'newest' : '      '}  ${whenOf(c.name)}   ${mb(c.size)}`));
}

export async function runCloud(args: readonly string[], env: Record<string, string | undefined>, io: CloudIo, cwd: string = process.cwd()): Promise<number> {
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  const command = args.find((a) => !a.startsWith('-'));
  if (command === undefined || !['check', 'list', 'push', 'pull'].includes(command)) {
    USAGE.forEach(io.out);
    return command === undefined ? 0 : 1;
  }
  const settings = backupSettingsFromEnv(env);
  if (!settings) {
    SETUP_HELP.forEach(io.out);
    return 1;
  }
  const store: BackupStore = storeFromSettings(settings);
  const log: BackupLog = {
    info: (_area, message) => io.out(message),
    warn: (_area, message) => io.out(`Warning: ${message}`),
    error: (_area, message) => io.out(`Problem: ${message}`),
  };
  const dataDir = dataDirOf({ ...env, TQ_DATA_DIR: env.TQ_DATA_DIR ?? join(cwd, 'data') });

  // The first thing every command does is open the repository: a wrong name or token is reported before anything else.
  const status = await store.check();
  io.out(`Store: ${store.describe}`);

  if (command === 'check' || command === 'list') {
    io.out(status.isPrivate ? 'The repository is private. Good.' : 'WARNING: the repository is PUBLIC. Anybody can download your database from it. Make it private (GitHub → the repository → Settings → Danger Zone → Change visibility).');
    io.out(`${status.copies.length} cop${status.copies.length === 1 ? 'y' : 'ies'} (the newest ${KEEP_COPIES} are kept):`);
    describeCopies(status.copies, io.out);
    return status.isPrivate ? 0 : 1;
  }

  if (command === 'pull') {
    const target = join(dataDir, 'online-copy.sqlite');
    if (existsSync(target)) {
      io.out(`${target} already exists. Move or delete it first; nothing was downloaded.`);
      return 1;
    }
    const outcome = await restoreIfMissing(store, target, log);
    if (outcome.outcome !== 'restored') {
      io.out('There is nothing to download: the store holds no copy.');
      return 1;
    }
    io.out(`Saved to ${target} (${outcome.accounts} accounts). Your own game was not touched.`);
    return 0;
  }

  // push
  if (!status.isPrivate) {
    io.out('Refusing to upload: the repository is PUBLIC, so anybody could download the accounts. Make it private first, then run this again.');
    return 1;
  }
  const file = join(dataDir, 'tradequest.sqlite');
  if (!existsSync(file)) {
    io.out(`There is no game at ${file}. Run this in the TradeQuest folder (the one that holds the "data" folder), or set TQ_DATA_DIR.`);
    return 1;
  }
  const db = new Db(file);
  try {
    if (currentVersion(db) < 1 || !db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'")) {
      io.out(`${file} is not a TradeQuest database.`);
      return 1;
    }
    const names = db.all<{ username: string }>('SELECT username FROM users ORDER BY id LIMIT 30').map((r) => r.username);
    const total = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0);
    io.out(`This computer's game has ${total} account${total === 1 ? '' : 's'}: ${names.join(', ')}${total > names.length ? ', ...' : ''}`);
    if (status.copies.length > 0 && !flags.has('--yes')) {
      io.out(`The store already holds ${status.copies.length} cop${status.copies.length === 1 ? 'y' : 'ies'}:`);
      describeCopies(status.copies, io.out);
      io.out('A copy sent now becomes the newest one. The online server loads the newest copy whenever it starts with an empty disk,');
      io.out('so your online world would be replaced by this computer\'s world. (If the online server is running with these settings it');
      io.out('saves its own copy every few minutes and when it stops, which would come after this one: push BEFORE turning the settings on there.)');
      if (!(await io.confirm('Send this computer\'s game as the newest copy? (yes/no) '))) {
        io.out('Nothing was sent.');
        return 1;
      }
    }
    io.out('Sending a copy (this takes a few seconds)...');
    const saved = await saveCopy({ store, db });
    io.out(`Sent ${saved.name}: ${mb(saved.packedBytes)} packed (${mb(saved.rawBytes)}), ${saved.accounts} account${saved.accounts === 1 ? '' : 's'}.`);
    const removed = await pruneCopies(store, KEEP_COPIES, log);
    if (removed > 0) io.out(`Deleted ${removed} older cop${removed === 1 ? 'y' : 'ies'} (the newest ${KEEP_COPIES} are kept).`);
    io.out('Your game on this computer was not changed.');
    return 0;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io: CloudIo = {
    out: (line) => console.log(line),
    confirm: async (question) => /^y(es)?$/i.test((await rl.question(question)).trim()),
  };
  try {
    process.exitCode = await runCloud(process.argv.slice(2), process.env, io);
  } catch (error) {
    console.error(error instanceof BackupError || error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
