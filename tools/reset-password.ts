// Sets a new password for one account, for when somebody (usually the owner) has forgotten theirs. Only the person who runs the
// server can do this: it works on the database file directly, and there is no way to reach it from the web.
//   1. Stop the server (Ctrl+C in its window).
//   2. npm run reset-password -- <username>     it asks for the new password twice and hides what you type
//   3. Start the server again (npm run server) and sign in with the new password.
// The role, the cash and everything else of the account stay as they are; the account is signed out everywhere.
// (For scripts: a second argument is taken as the new password, e.g. `npm run reset-password -- alice NewPassword1`.)
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AuthError, resetPassword } from '../server/auth';
import { dataDirOf } from '../server/config';
import { Leases, SERVER_LEASE } from '../server/lease';
import { currentVersion } from '../server/schema';
import { Db } from '../server/sqlite';

class Stop extends Error {}

function fail(message: string): never {
  throw new Stop(message);
}

/** Everything typed into a pipe (when the input is not a keyboard), split into lines. */
async function readLines(): Promise<string[]> {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text.split(/\r?\n/);
}

/** Reads a line from the keyboard without showing it. */
function readHidden(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let text = '';
    const finish = (value: string | null): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      if (value === null) process.exit(130);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return finish(text);
        if (ch === '\u0003') return finish(null); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else if (ch >= ' ') text += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const username = process.argv[2];
  if (username === undefined || username.startsWith('-')) {
    console.log('Usage:  npm run reset-password -- <username>');
    console.log('Stop the server first (Ctrl+C), then run it. It asks for the new password (8–72 characters).');
    return;
  }
  const file = join(dataDirOf(), 'tradequest.sqlite');
  if (!existsSync(file)) fail(`There is no database at ${file}. Run this in the TradeQuest folder (the one that holds the "data" folder), or set TQ_DATA_DIR.`);

  const db = new Db(file);
  try {
    if (currentVersion(db) < 1 || !db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'")) fail(`${file} is not a TradeQuest database.`);

    // The server must not be running: it holds a lease on this database for as long as it is. (A server that crashed does not count.)
    const leases = db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_leases'") ? new Leases({ db, now: Date.now }) : null;
    if (leases && !leases.acquire(SERVER_LEASE, 60_000)) fail('The server is still running. Stop it first (Ctrl+C in its window), then run this again. Nothing was changed.');
    try {
      const lines = process.stdin.isTTY ? null : await readLines();
      const ask = async (question: string): Promise<string> => {
        process.stdout.write(question);
        if (lines === null) return readHidden();
        process.stdout.write('\n');
        return lines.shift() ?? '';
      };

      let password = process.argv[3];
      if (password === undefined) {
        password = await ask('New password (8–72 characters; what you type is hidden): ');
        if ((await ask('Type it again: ')) !== password) fail('The two passwords are different. Nothing was changed.');
      }

      let result;
      try {
        result = await resetPassword(db, username, password);
      } catch (error) {
        if (error instanceof AuthError) fail(`${error.message} Nothing was changed.`);
        throw error;
      }
      if (!result) {
        const names = db.all<{ username: string }>('SELECT username FROM users ORDER BY id LIMIT 40').map((r) => r.username);
        fail(`There is no account called "${username}". Nothing was changed.` + (names.length > 0 ? `\nAccounts in this database: ${names.join(', ')}` : ''));
      }
      console.log(`Done. "${result.username}" has a new password and was signed out everywhere (${result.sessionsEnded} sign-in${result.sessionsEnded === 1 ? '' : 's'} ended).`);
      console.log('Start the server again (npm run server) and sign in with the new password.');
    } finally {
      leases?.release(SERVER_LEASE);
    }
  } finally {
    db.close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Stop || error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
