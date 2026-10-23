// Keeping the data on a host that erases its disk (server/cloudBackup.ts): copies of the database go to a private GitHub repository
// and come back when the server starts with nothing. The rules under test: never start a new world over a saved one, never upload
// a damaged copy, never carry "a server is running" locks along, never crash the game because a save failed.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { Auth } from '../server/auth';
import {
  BackupError,
  BackupRunner,
  GithubReleaseStore,
  KEEP_COPIES,
  backupSettingsFromEnv,
  checkAndClean,
  restoreIfMissing,
  saveCopy,
  snapshotName,
  type BackupItem,
  type BackupLog,
  type BackupStore,
  type StoreStatus,
} from '../server/cloudBackup';
import { Leases, SERVER_LEASE } from '../server/lease';
import { runCloud, whenOf, type CloudIo } from '../tools/cloud';
import { migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { startMockGithub, type MockGithub } from './helpers/mockGithub';

const dbs: Db[] = [];
const dirs: string[] = [];
const servers: MockGithub[] = [];
afterEach(async () => {
  while (dbs.length > 0) dbs.pop()?.close();
  while (servers.length > 0) await servers.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tq-cbk-'));
  dirs.push(dir);
  return dir;
}

function makeDb(file: string): Db {
  const db = new Db(file);
  dbs.push(db);
  migrate(db);
  return db;
}

async function populated(file: string): Promise<Db> {
  const db = makeDb(file);
  const auth = new Auth(db, () => Date.now(), '');
  await auth.register('alice', 'correct horse', '10.0.0.1');
  await auth.register('bob', 'battery staple', '10.0.0.2');
  return db;
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(5);
  }
}

function capture(): { log: BackupLog; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (a, m) => void lines.push(`info ${a}: ${m}`),
      warn: (a, m) => void lines.push(`warn ${a}: ${m}`),
      error: (a, m) => void lines.push(`error ${a}: ${m}`),
    },
  };
}

class FakeStore implements BackupStore {
  readonly describe = 'the fake store';
  readonly items: { item: BackupItem; data: Buffer }[] = [];
  readonly calls = { list: 0, download: 0, upload: 0, remove: 0 };
  failList: string | null = null;
  failUpload: string | null = null;
  hangUpload: Promise<void> | null = null;
  private nextId = 1;

  async check(): Promise<StoreStatus> {
    return { repo: 'fake/store', isPrivate: true, copies: await this.list() };
  }
  async list(): Promise<BackupItem[]> {
    this.calls.list++;
    if (this.failList) throw new BackupError(this.failList);
    return this.items.map((i) => i.item).sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  }
  async download(item: BackupItem): Promise<Buffer> {
    this.calls.download++;
    const found = this.items.find((i) => i.item.id === item.id);
    if (!found) throw new BackupError('no such copy');
    return found.data;
  }
  async upload(name: string, data: Buffer): Promise<void> {
    this.calls.upload++;
    if (this.hangUpload) await this.hangUpload;
    if (this.failUpload) throw new BackupError(this.failUpload);
    this.items.push({ item: { id: String(this.nextId++), name, size: data.length }, data });
  }
  async remove(item: BackupItem): Promise<void> {
    this.calls.remove++;
    const at = this.items.findIndex((i) => i.item.id === item.id);
    if (at >= 0) this.items.splice(at, 1);
  }
  put(ms: number, data: Buffer): void {
    this.items.push({ item: { id: String(this.nextId++), name: snapshotName(ms), size: data.length }, data });
  }
}

function accountsIn(file: string): string[] {
  const db = new Db(file);
  try {
    return db.all<{ username: string }>('SELECT username FROM users ORDER BY id').map((r) => r.username);
  } finally {
    db.close();
  }
}

describe('keeping the data on a host that erases its disk', () => {
  it('CBK-1: the feature is off unless both settings are given, and bad settings are refused in plain words', () => {
    expect(backupSettingsFromEnv({})).toBeNull();
    expect(backupSettingsFromEnv({ TQ_BACKUP_REPO: '  ', TQ_BACKUP_TOKEN: '' })).toBeNull();
    expect(() => backupSettingsFromEnv({ TQ_BACKUP_REPO: 'me/data' })).toThrow(/both TQ_BACKUP_REPO and TQ_BACKUP_TOKEN/);
    expect(() => backupSettingsFromEnv({ TQ_BACKUP_TOKEN: 'x' })).toThrow(/both TQ_BACKUP_REPO and TQ_BACKUP_TOKEN/);
    expect(() => backupSettingsFromEnv({ TQ_BACKUP_REPO: 'just-a-name', TQ_BACKUP_TOKEN: 'x' })).toThrow(/owner\/name/);
    expect(() => backupSettingsFromEnv({ TQ_BACKUP_REPO: 'me/data', TQ_BACKUP_TOKEN: 'x', TQ_BACKUP_MINUTES: 'soon' })).toThrow(/TQ_BACKUP_MINUTES/);
    expect(() => backupSettingsFromEnv({ TQ_BACKUP_REPO: 'me/data', TQ_BACKUP_TOKEN: 'x', TQ_BACKUP_MINUTES: '5000' })).toThrow(/TQ_BACKUP_MINUTES/);
    const ok = backupSettingsFromEnv({ TQ_BACKUP_REPO: ' me/data ', TQ_BACKUP_TOKEN: ' tok ' });
    expect(ok).toEqual({ repo: 'me/data', token: 'tok', intervalMs: 600_000, apiBase: 'https://api.github.com', uploadBase: 'https://uploads.github.com' });
    expect(backupSettingsFromEnv({ TQ_BACKUP_REPO: 'me/data', TQ_BACKUP_TOKEN: 'x', TQ_BACKUP_MINUTES: '2', TQ_BACKUP_API: 'http://127.0.0.1:9/' })?.intervalMs).toBe(120_000);
  });

  it('CBK-2: copy names sort by time, and only those names are taken as copies', () => {
    const a = snapshotName(Date.UTC(2026, 9, 23, 4, 15, 33, 123));
    const b = snapshotName(Date.UTC(2026, 9, 23, 4, 15, 33, 124));
    const c = snapshotName(Date.UTC(2026, 10, 1, 0, 0, 0, 0));
    expect(a).toBe('tradequest-20261023T041533123Z.sqlite.gz');
    expect([c, b, a].sort()).toEqual([a, b, c]);
  });

  it('CBK-3: a saved copy brings the whole game back on an empty disk, without the old server\'s locks, and leaves the live database alone', async () => {
    const dir = tmp();
    const src = await populated(join(dir, 'src.sqlite'));
    expect(new Leases({ db: src, now: () => Date.now() }).acquire(SERVER_LEASE, 30_000)).toBe(true);

    const store = new FakeStore();
    const saved = await saveCopy({ store, db: src, now: () => 1_000 });
    expect(saved.accounts).toBe(2);
    expect(store.items).toHaveLength(1);
    expect(src.get<{ n: number }>('SELECT COUNT(*) AS n FROM job_leases')?.n).toBe(1); // the running server keeps its own lock

    const dest = join(dir, 'fresh-host', 'data', 'tradequest.sqlite');
    const { log, lines } = capture();
    const result = await restoreIfMissing(store, dest, log);
    expect(result).toMatchObject({ outcome: 'restored', accounts: 2 });
    expect(accountsIn(dest)).toEqual(['alice', 'bob']);
    const back = new Db(dest);
    dbs.push(back);
    expect(back.get<{ n: number }>('SELECT COUNT(*) AS n FROM job_leases')?.n).toBe(0); // nobody is "running" in the copy
    expect((await new Auth(back, () => Date.now(), '').login('alice', 'correct horse', '10.9.9.9')).user.username).toBe('alice'); // same passwords
    expect(lines.join('\n')).toContain('Loaded');
    expect(readdirSync(join(dir, 'fresh-host', 'data'))).not.toContain('tradequest.sqlite.restoring');
  });

  it('CBK-4: with a database already on the disk nothing is loaded; with an empty store a new world starts; neither touches the store\'s copies', async () => {
    const dir = tmp();
    const here = await populated(join(dir, 'here.sqlite'));
    here.close();
    dbs.splice(dbs.indexOf(here), 1);

    const store = new FakeStore();
    store.put(1_000, gzipSync(Buffer.from('this must never be read')));
    expect((await restoreIfMissing(store, join(dir, 'here.sqlite'), capture().log)).outcome).toBe('kept');
    expect(store.calls.list).toBe(0);
    expect(store.calls.download).toBe(0);

    const empty = new FakeStore();
    const dest = join(dir, 'new', 'tradequest.sqlite');
    expect((await restoreIfMissing(empty, dest, capture().log)).outcome).toBe('fresh');
    expect(existsSync(dest)).toBe(false);
  });

  it('CBK-5: if the store cannot be reached, or every copy is damaged, the server refuses to start a new world', async () => {
    const dir = tmp();
    const dest = join(dir, 'host', 'tradequest.sqlite');

    const down = new FakeStore();
    down.failList = 'GitHub is not answering';
    await expect(restoreIfMissing(down, dest, capture().log)).rejects.toThrow(/GitHub is not answering/);
    expect(existsSync(dest)).toBe(false);

    const good = await populated(join(dir, 'good.sqlite'));
    const source = new FakeStore();
    await saveCopy({ store: source, db: good, now: () => 5 });
    const goodGz = source.items[0]!.data;
    const whole = gunzipSync(goodGz);
    const truncated = gzipSync(whole.subarray(0, Math.floor(whole.length / 2)));

    const broken = new FakeStore();
    broken.put(3_000, gzipSync(Buffer.from('not a database at all')));
    broken.put(2_000, truncated);
    const { log, lines } = capture();
    await expect(restoreIfMissing(broken, dest, log)).rejects.toThrow(/none could be loaded.*NOT start a new world/s);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.restoring`)).toBe(false);
    expect(lines.filter((l) => l.startsWith('warn')).length).toBe(2);

    // A damaged NEWEST copy is skipped and the next good one is used.
    broken.put(1_000, goodGz);
    const result = await restoreIfMissing(broken, dest, capture().log);
    expect(result).toMatchObject({ outcome: 'restored', accounts: 2 });
    expect(accountsIn(dest)).toEqual(['alice', 'bob']);
  });

  it('CBK-6: a copy taken while the game keeps writing is whole (no half-done changes), by Node\'s incremental backup and by the older VACUUM way', async () => {
    const dir = tmp();
    const db = await populated(join(dir, 'busy.sqlite'));
    db.exec('CREATE TABLE scratch (id INTEGER PRIMARY KEY, pad TEXT NOT NULL)');
    const pad = 'x'.repeat(300);
    const batch = (): void =>
      db.tx(() => {
        for (let j = 0; j < 100; j++) db.run('INSERT INTO scratch(pad) VALUES (?)', pad);
      });
    for (let i = 0; i < 60; i++) batch();

    const checkCopy = (file: string, atLeast: number): void => {
      const copy = new Db(file);
      try {
        expect(copy.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check).toBe('ok');
        const row = copy.get<{ n: number; top: number }>('SELECT COUNT(*) AS n, MAX(id) AS top FROM scratch');
        expect(row?.n).toBe(row?.top); // every change up to one moment, none missing in the middle
        expect(row?.n ?? 0).toBeGreaterThanOrEqual(atLeast);
        expect(copy.all('SELECT username FROM users')).toHaveLength(2);
      } finally {
        copy.close();
      }
    };

    // Writes go on while the copy is being made.
    const incremental = join(dir, 'incremental.sqlite');
    const copying = db.snapshotTo(incremental);
    copying.catch(() => undefined); // judged below; keeps a failure from being reported as 'unhandled' while the loop runs
    for (let i = 0; i < 200; i++) {
      batch();
      await new Promise((r) => setImmediate(r));
    }
    await copying;
    checkCopy(incremental, 6000);

    // The same with Node's backup function hidden, as on an older Node.
    const sqliteModule = createRequire(import.meta.url)('node:sqlite') as { backup?: unknown };
    const original = sqliteModule.backup;
    let hidden = true;
    try {
      sqliteModule.backup = undefined;
    } catch {
      hidden = false; // the module cannot be changed here: the incremental path is the one that was tested
    }
    try {
      const vacuum = join(dir, 'vacuum.sqlite');
      await db.snapshotTo(vacuum);
      checkCopy(vacuum, 26_000);
    } finally {
      if (hidden) sqliteModule.backup = original;
    }
  });

  it('CBK-7: the runner saves on its timer, shares one save between callers, keeps only the newest copies, and a failed save is a message, not a crash', async () => {
    const dir = tmp();
    const db = await populated(join(dir, 'game.sqlite'));
    const store = new FakeStore();
    const { log, lines } = capture();
    let clock = Date.UTC(2026, 9, 23, 12, 0, 0);
    const runner = new BackupRunner({ store, db, log, intervalMs: 25, now: () => (clock += 1000) });

    // Two callers at once → one upload.
    const [a, b] = await Promise.all([runner.runOnce(), runner.runOnce()]);
    expect([a, b]).toEqual([true, true]);
    expect(store.calls.upload).toBe(1);

    // Many saves → only the newest KEEP_COPIES remain, and they are the newest by name.
    for (let i = 0; i < KEEP_COPIES + 3; i++) await runner.runOnce();
    expect(store.items).toHaveLength(KEEP_COPIES);
    const names = store.items.map((i) => i.item.name).sort();
    expect(names[names.length - 1]).toBe(snapshotName(clock));

    // The timer saves by itself once something has changed (and only once for it), and stop() ends it.
    const before = store.calls.upload;
    runner.markDirty();
    runner.start();
    await until(() => store.calls.upload === before + 1, 'the timer save');
    await pause(120);
    expect(store.calls.upload).toBe(before + 1);
    runner.stop();
    runner.markDirty();
    await pause(120);
    expect(store.calls.upload).toBe(before + 1); // stopped: no more timer saves

    // A failing store: false, a warning (an error from the third in a row), and the next try can succeed.
    store.failUpload = 'quota exceeded';
    lines.length = 0;
    expect(await runner.runOnce()).toBe(false);
    expect(lines[0]).toMatch(/^warn backup: Saving the database .* failed \(quota exceeded\)/);
    await runner.runOnce();
    await runner.runOnce();
    expect(lines.some((l) => l.startsWith('error backup:') && l.includes('3 times in a row'))).toBe(true);
    store.failUpload = null;
    expect(await runner.runOnce()).toBe(true);
  });

  it('CBK-8: stopping saves one last copy and does not wait for ever for a slow store', async () => {
    const dir = tmp();
    const db = await populated(join(dir, 'game.sqlite'));
    const store = new FakeStore();
    const { log, lines } = capture();
    const runner = new BackupRunner({ store, db, log, intervalMs: 60_000 });
    runner.start();
    expect(await runner.final(5_000)).toBe(true);
    expect(store.items).toHaveLength(1);

    runner.markDirty(); // something changed again, and the store is now slow
    let release!: () => void;
    store.hangUpload = new Promise<void>((r) => {
      release = r;
    });
    const started = Date.now();
    expect(await runner.final(80)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(lines.some((l) => l.includes('did not finish within'))).toBe(true);
    release();
  });

  it('CBK-9: the GitHub store works through the release assets: create once, upload, list newest first, download without sending the token on, delete', async () => {
    const gh = await startMockGithub({ repo: 'owner/data', token: 'tok' });
    servers.push(gh);
    const store = new GithubReleaseStore({ repo: 'owner/data', token: 'tok', apiBase: gh.url, uploadBase: gh.url });

    const empty = await store.check();
    expect(empty).toEqual({ repo: 'owner/data', isPrivate: true, copies: [] });
    expect(gh.requests.some((r) => r.method === 'POST')).toBe(false); // looking changes nothing
    expect(await store.list()).toEqual([]);

    const one = Buffer.from('first copy');
    const two = Buffer.from('second copy, a little longer');
    await store.upload(snapshotName(1_000), one);
    await store.upload(snapshotName(2_000), two);
    expect(gh.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/releases'))).toHaveLength(1);

    const listed = await store.list();
    expect(listed.map((i) => i.name)).toEqual([snapshotName(2_000), snapshotName(1_000)]);
    expect(listed[0]?.size).toBe(two.length);
    expect((await store.download(listed[0] as BackupItem)).equals(two)).toBe(true);
    const apiCall = gh.requests.find((r) => r.method === 'GET' && r.path.includes('/releases/assets/'));
    expect(apiCall?.auth).toBe('Bearer tok');
    expect(gh.requests.find((r) => r.path.startsWith('/download/'))?.auth).toBeUndefined();

    // Things that are not finished copies, or not ours, are not copies.
    gh.assets.push({ id: 900, name: snapshotName(3_000), data: Buffer.alloc(0), state: 'starter' });
    gh.assets.push({ id: 901, name: 'notes.txt', data: Buffer.from('hi'), state: 'uploaded' });
    expect((await store.list()).map((i) => i.name)).toEqual([snapshotName(2_000), snapshotName(1_000)]);

    await store.remove(listed[1] as BackupItem);
    expect((await store.list()).map((i) => i.name)).toEqual([snapshotName(2_000)]);
    await store.remove(listed[1] as BackupItem); // already gone: fine
  });

  it('CBK-10: GitHub problems are explained, a repository that cannot be opened never looks like "no copies", and a broken upload leaves nothing behind', async () => {
    const gh = await startMockGithub({ repo: 'owner/data', token: 'tok' });
    servers.push(gh);

    const wrong = new GithubReleaseStore({ repo: 'owner/data', token: 'nope', apiBase: gh.url, uploadBase: gh.url });
    await expect(wrong.check()).rejects.toThrow(/HTTP 401.*token is wrong or has expired/s);

    const store = new GithubReleaseStore({ repo: 'owner/data', token: 'tok', apiBase: gh.url, uploadBase: gh.url });
    gh.flags.isPublic = true;
    expect((await store.check()).isPrivate).toBe(false);
    gh.flags.isPublic = false;

    gh.flags.failNextUpload = true;
    await expect(store.upload(snapshotName(1_000), Buffer.from('x'))).rejects.toThrow(/uploading .* failed \(HTTP 502/);
    expect(gh.assets.filter((a) => a.state === 'starter')).toHaveLength(0);
    await store.upload(snapshotName(1_000), Buffer.from('x')); // the retry works

    gh.flags.hideRepo = true;
    await expect(store.list()).rejects.toThrow(/HTTP 404.*cannot find it/s);
    const dest = join(tmp(), 'host', 'tradequest.sqlite');
    await expect(restoreIfMissing(store, dest, capture().log)).rejects.toThrow(/HTTP 404/);
    expect(existsSync(dest)).toBe(false);

    const gone = new GithubReleaseStore({ repo: 'owner/data', token: 'tok', apiBase: 'http://127.0.0.1:9', uploadBase: 'http://127.0.0.1:9' });
    await expect(gone.list()).rejects.toThrow(/Could not reach GitHub/);
  });

  it('CBK-11: a world saved to the (pretend) GitHub on stop comes back on an empty disk, complete', async () => {
    const gh = await startMockGithub({ repo: 'owner/data', token: 'tok' });
    servers.push(gh);
    const store = new GithubReleaseStore({ repo: 'owner/data', token: 'tok', apiBase: gh.url, uploadBase: gh.url });
    const dir = tmp();
    const db = await populated(join(dir, 'game.sqlite'));
    const runner = new BackupRunner({ store, db, log: capture().log, intervalMs: 60_000 });
    expect(await runner.final(10_000)).toBe(true);
    expect(gh.assets).toHaveLength(1);
    expect(gh.assets[0]?.name).toMatch(/^tradequest-\d{8}T\d{9}Z\.sqlite\.gz$/);

    const dest = join(tmp(), 'wiped-host', 'tradequest.sqlite');
    expect((await restoreIfMissing(store, dest, capture().log)).outcome).toBe('restored');
    expect(accountsIn(dest)).toEqual(['alice', 'bob']);
    expect(checkAndClean(dest)).toMatchObject({ accounts: 2 });
  });

  it('CBK-14: the timer saves only when something may have changed (or the quiet limit passes), a failed save stays due, and stopping saves only if something changed', async () => {
    const dir = tmp();
    const db = await populated(join(dir, 'game.sqlite'));
    const store = new FakeStore();
    const { log, lines } = capture();
    // A world just loaded from the store: nothing to save yet.
    const runner = new BackupRunner({ store, db, log, intervalMs: 20, startDirty: false, maxQuietMs: 600_000 });
    runner.start();
    await pause(150);
    expect(store.calls.upload).toBe(0);
    expect(runner.skipped).toBeGreaterThan(2);
    expect(runner.hasUnsavedChanges).toBe(false);

    // One change → exactly one copy, however many timer ticks follow.
    runner.markDirty();
    await until(() => store.calls.upload === 1, 'the first copy');
    await pause(120);
    expect(store.calls.upload).toBe(1);
    expect(runner.hasUnsavedChanges).toBe(false);

    // A failed save leaves the change due: it is tried again on the next ticks and succeeds once the store is back.
    store.failUpload = 'GitHub is down';
    runner.markDirty();
    await until(() => store.calls.upload >= 3, 'retries');
    expect(runner.hasUnsavedChanges).toBe(true);
    store.failUpload = null;
    await until(() => store.items.length === 2, 'the copy after the outage');
    await pause(100);
    const uploads = store.calls.upload;
    expect(runner.hasUnsavedChanges).toBe(false);
    expect(lines.some((l) => l.startsWith('warn backup: Saving the database'))).toBe(true);

    // Stopping with nothing new does not make another copy; stopping after a change does.
    expect(await runner.final(5000)).toBe(true);
    expect(store.calls.upload).toBe(uploads);
    expect(lines.some((l) => l.includes('Nothing has changed since the last copy'))).toBe(true);
    runner.markDirty();
    expect(await runner.final(5000)).toBe(true);
    expect(store.calls.upload).toBe(uploads + 1);
  });

  it('CBK-15: with nothing reported, a copy is still refreshed when the quiet limit passes; a fresh world (the default) is saved at the first tick', async () => {
    const dir = tmp();
    const db = await populated(join(dir, 'game.sqlite'));
    const quiet = new FakeStore();
    const runner = new BackupRunner({ store: quiet, db, log: capture().log, intervalMs: 15, startDirty: false, maxQuietMs: 120 });
    runner.start();
    await pause(60);
    expect(quiet.calls.upload).toBe(0);
    await until(() => quiet.calls.upload >= 1, 'the safety-net copy');
    runner.stop();

    const fresh = new FakeStore();
    const second = new BackupRunner({ store: fresh, db, log: capture().log, intervalMs: 15 });
    second.start();
    await until(() => fresh.calls.upload === 1, 'the first copy of a new world');
    second.stop();
  });

  it('CBK-16: opening a file that is not a database fails cleanly and lets go of the file (Windows cannot delete a file that is still open)', () => {
    const dir = tmp();
    const bad = join(dir, 'not-a-database.sqlite');
    writeFileSync(bad, Buffer.from('this is not a database '.repeat(500)));
    expect(() => new Db(bad)).toThrow();
    expect(() => checkAndClean(bad)).toThrow();
    // On Linux the open handles of this program can be listed: none may point at the file.
    if (existsSync('/proc/self/fd')) {
      const held = readdirSync('/proc/self/fd').filter((fd) => {
        try {
          return readlinkSync(join('/proc/self/fd', fd)).includes('not-a-database');
        } catch {
          return false;
        }
      });
      expect(held).toEqual([]);
    }
    rmSync(bad); // what failed on Windows
    expect(existsSync(bad)).toBe(false);
  });

  it('CBK-12: the server uses it only when the settings are there, loads before it opens the database, and saves once more when told to stop', () => {
    const code = (file: string): string =>
      readFileSync(resolve(process.cwd(), 'server', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const main = code('main.ts');
    expect(main).toContain('backupSettingsFromEnv(process.env)');
    expect(main.indexOf('restoreIfMissing(')).toBeGreaterThan(-1);
    expect(main.indexOf('restoreIfMissing(')).toBeLessThan(main.indexOf('createApp('));
    expect(main).toMatch(/if \(store && backup\) \{\s*runner = new BackupRunner/);
    expect(main).toMatch(/runner!\.final\(\d/);
    // Only requests that can change data make the next save due; reads never do.
    expect(main).toMatch(/req\.method !== 'GET' && req\.method !== 'HEAD' && req\.method !== 'OPTIONS'/);
    expect(main).toContain('runner?.markDirty()');
    expect(main).toContain('startDirty: !restored');
    // Without settings the stop is the plain one: close and exit, nothing awaited.
    expect(main).toMatch(/if \(!runner\) finish\(\);/);
    // No token or key is written into the code.
    for (const file of ['main.ts', 'cloudBackup.ts']) expect(code(file)).not.toMatch(/github_pat_|ghp_[A-Za-z0-9]/);
  });

  it('CBK-13: `npm run cloud` checks, lists, pushes (asking first when copies exist, never to a public repository) and pulls, and never changes the local game', async () => {
    const gh = await startMockGithub({ repo: 'owner/data', token: 'tok' });
    servers.push(gh);
    const root = tmp();
    const dataDir = join(root, 'data');
    mkdirSync(dataDir);
    const game = await populated(join(dataDir, 'tradequest.sqlite'));
    const before = game.all('SELECT * FROM users ORDER BY id');
    const env = { TQ_BACKUP_REPO: 'owner/data', TQ_BACKUP_TOKEN: 'tok', TQ_BACKUP_API: gh.url, TQ_BACKUP_UPLOAD_API: gh.url };
    const run = async (args: string[], answers: boolean[] = [], overrides: Record<string, string | undefined> = {}) => {
      const lines: string[] = [];
      const asked: string[] = [];
      const io: CloudIo = {
        out: (l) => void lines.push(l),
        confirm: async (q) => {
          asked.push(q);
          return answers.shift() ?? false;
        },
      };
      const code = await runCloud(args, { ...env, ...overrides }, io, root);
      return { code, text: lines.join('\n'), asked };
    };

    // No command, or no settings: help, and nothing is contacted.
    expect((await run([])).text).toContain('Usage:');
    const noSettings = await run(['check'], [], { TQ_BACKUP_REPO: undefined, TQ_BACKUP_TOKEN: undefined });
    expect(noSettings.code).toBe(1);
    expect(noSettings.text).toContain('$env:TQ_BACKUP_REPO');
    expect(gh.requests).toHaveLength(0);
    expect((await run(['frobnicate'])).code).toBe(1);

    // First push: the store is empty, so there is no question. The game is only read.
    const first = await run(['push']);
    expect(first.code).toBe(0);
    expect(first.asked).toEqual([]);
    expect(first.text).toContain('alice, bob');
    expect(first.text).toContain('2 accounts');
    expect(gh.assets).toHaveLength(1);
    expect(game.all('SELECT * FROM users ORDER BY id')).toEqual(before);

    // A second push asks, because the new copy would become the one the online server loads.
    const declined = await run(['push'], [false]);
    expect(declined.code).toBe(1);
    expect(declined.asked).toHaveLength(1);
    expect(declined.text).toContain('Nothing was sent.');
    expect(gh.assets).toHaveLength(1);
    const accepted = await run(['push'], [true]);
    expect(accepted.code).toBe(0);
    expect(gh.assets).toHaveLength(2);
    const forced = await run(['push', '--yes']);
    expect(forced.code).toBe(0);
    expect(forced.asked).toEqual([]);
    expect(gh.assets).toHaveLength(3);

    // check / list show the copies, newest first, and say so when the repository is public.
    const listing = await run(['list']);
    expect(listing.code).toBe(0);
    expect(listing.text).toContain('3 copies');
    expect(listing.text).toContain('private');
    gh.flags.isPublic = true;
    const pub = await run(['check']);
    expect(pub.code).toBe(1);
    expect(pub.text).toContain('PUBLIC');
    const refused = await run(['push', '--yes']);
    expect(refused.code).toBe(1);
    expect(refused.text).toContain('Refusing to upload');
    expect(gh.assets).toHaveLength(3);
    gh.flags.isPublic = false;

    // A wrong token or an unreachable repository is an error that explains itself, never a silent "nothing there".
    await expect(run(['check'], [], { TQ_BACKUP_TOKEN: 'wrong' })).rejects.toThrow(BackupError);
    gh.flags.hideRepo = true;
    await expect(run(['list'])).rejects.toThrow(BackupError);
    gh.flags.hideRepo = false;

    // pull: downloads the newest good copy next to the game, never over it, and not twice.
    const pulled = await run(['pull']);
    expect(pulled.code).toBe(0);
    expect(accountsIn(join(dataDir, 'online-copy.sqlite'))).toEqual(['alice', 'bob']);
    expect(game.all('SELECT * FROM users ORDER BY id')).toEqual(before);
    const again = await run(['pull']);
    expect(again.code).toBe(1);
    expect(again.text).toContain('already exists');

    // Nothing to push when there is no game here; the time in a copy's name reads well.
    const empty = tmp();
    const lines: string[] = [];
    expect(await runCloud(['push', '--yes'], env, { out: (l) => void lines.push(l), confirm: async () => true }, empty)).toBe(1);
    expect(lines.join('\n')).toContain('There is no game at');
    expect(whenOf('tradequest-20261023T041533123Z.sqlite.gz')).toBe('2026-10-23 04:15:33 UTC');
  });
});
