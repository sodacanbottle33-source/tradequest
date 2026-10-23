// Keeps the game's data alive on a host whose disk is erased now and then (Render's free plan wipes it every time the server
// sleeps, restarts or is redeployed). The idea is small: every few minutes the server saves a consistent copy of its database
// (gzipped) into a PRIVATE GitHub repository, as a "release asset", and when it starts with no database file it loads the newest
// copy back. Nothing here runs unless TQ_BACKUP_REPO and TQ_BACKUP_TOKEN are set, so the game on your own computer is not affected.
//
// The rules that keep the data safe:
//  - A new world is started only when the store was reached and holds NO copy. If the store cannot be reached, or every copy is
//    damaged, the server refuses to start and says why: a fresh world would later be saved over the good copies.
//  - A copy is checked (it opens, it passes SQLite's check, it has the tables) before it is uploaded and before it is used.
//  - A copy carries no "a server is running" lock (job_leases); with one, a restored world could not start for 30 seconds.
//  - The newest KEEP_COPIES stay in the store; older ones are deleted after a successful upload.
//  - The token lives only in the environment (never in the code or in a copy), and the repository should be private: the copies
//    hold the accounts (as salted hashes, never plain passwords).

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib';
import { currentVersion } from './schema';
import { Db } from './sqlite';

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

export const KEEP_COPIES = 6;
export const DEFAULT_BACKUP_MINUTES = 10;
/** Even when nothing seems to have changed, a copy is refreshed this often while the server runs. */
export const DEFAULT_QUIET_MINUTES = 60;
const RELEASE_TAG = 'tradequest-data';
const NAME_PATTERN = /^tradequest-\d{8}T\d{9}Z\.sqlite\.gz$/;
const MAX_PACKED_BYTES = 150 * 1024 * 1024;
const MAX_RAW_BYTES = 450 * 1024 * 1024;

/** Where the messages go (the server's Logger fits, and so does a console wrapper). */
export interface BackupLog {
  info(area: string, message: string): void;
  warn(area: string, message: string): void;
  error(area: string, message: string): void;
}

/** Deletes a file or folder if it can; a leftover in a temporary place is harmless, so this never throws (Windows may need a retry). */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Left behind; overwritten or ignored next time.
  }
}

/** A problem with the store or with a copy, in words a person can act on. */
export class BackupError extends Error {}

export interface BackupItem {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

export interface StoreStatus {
  /** `owner/name` of the repository. */
  readonly repo: string;
  /** False means anybody on the internet could download the copies: the repository must be private. */
  readonly isPrivate: boolean;
  /** Newest first. */
  readonly copies: readonly BackupItem[];
}

/** A place that keeps copies. The real one is a GitHub repository; the tests use one in memory. */
export interface BackupStore {
  readonly describe: string;
  /** Looks at the settings without changing anything. Throws a BackupError if the store cannot be used. */
  check(): Promise<StoreStatus>;
  /** The copies, newest first. Throws if the store cannot be reached (an empty list means: reached, and there is none). */
  list(): Promise<BackupItem[]>;
  download(item: BackupItem): Promise<Buffer>;
  upload(name: string, data: Buffer): Promise<void>;
  remove(item: BackupItem): Promise<void>;
}

// ---- settings --------------------------------------------------------------------------------------------------------------

export interface BackupSettings {
  readonly repo: string;
  readonly token: string;
  readonly intervalMs: number;
  /** Only the tests change these two. */
  readonly apiBase: string;
  readonly uploadBase: string;
}

/** The backup settings from the environment, or null when the feature is off (neither TQ_BACKUP_REPO nor TQ_BACKUP_TOKEN is set). */
export function backupSettingsFromEnv(env: Record<string, string | undefined>): BackupSettings | null {
  const repo = (env.TQ_BACKUP_REPO ?? '').trim();
  const token = (env.TQ_BACKUP_TOKEN ?? '').trim();
  if (repo === '' && token === '') return null;
  if (repo === '' || token === '') throw new BackupError('Set both TQ_BACKUP_REPO and TQ_BACKUP_TOKEN, or neither of them.');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new BackupError(`TQ_BACKUP_REPO must look like owner/name, got "${repo}".`);
  const rawMinutes = (env.TQ_BACKUP_MINUTES ?? '').trim();
  const minutes = rawMinutes === '' ? DEFAULT_BACKUP_MINUTES : Number(rawMinutes);
  if (!Number.isFinite(minutes) || minutes < 0.1 || minutes > 1440) throw new BackupError(`TQ_BACKUP_MINUTES must be a number of minutes from 1 to 1440, got "${rawMinutes}".`);
  const base = (value: string | undefined, fallback: string): string => ((value ?? '').trim() === '' ? fallback : (value as string).trim().replace(/\/+$/, ''));
  return {
    repo,
    token,
    intervalMs: Math.round(minutes * 60_000),
    apiBase: base(env.TQ_BACKUP_API, 'https://api.github.com'),
    uploadBase: base(env.TQ_BACKUP_UPLOAD_API, 'https://uploads.github.com'),
  };
}

export function storeFromSettings(settings: BackupSettings): BackupStore {
  return new GithubReleaseStore({ repo: settings.repo, token: settings.token, apiBase: settings.apiBase, uploadBase: settings.uploadBase });
}

// ---- the GitHub store ------------------------------------------------------------------------------------------------------

interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  state: string;
}

/**
 * Copies kept as the assets of one release (tag "tradequest-data") of a private repository. Needs a fine-grained token with
 * "Contents: Read and write" on that one repository, and the repository must have at least one commit (tick "Add a README").
 */
export class GithubReleaseStore implements BackupStore {
  readonly describe: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly apiBase: string;
  private readonly uploadBase: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: { repo: string; token: string; apiBase?: string; uploadBase?: string; fetchFn?: typeof fetch }) {
    this.repo = options.repo;
    this.token = options.token;
    this.apiBase = options.apiBase ?? 'https://api.github.com';
    this.uploadBase = options.uploadBase ?? 'https://uploads.github.com';
    this.fetchFn = options.fetchFn ?? fetch;
    this.describe = `the GitHub repository ${options.repo}`;
  }

  private async call(method: string, url: string, init: { body?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'User-Agent': 'tradequest-backup',
          'X-GitHub-Api-Version': '2022-11-28',
          ...init.headers,
        },
        body: init.body as BodyInit | undefined, // (a Buffer is a valid body; the DOM typings just do not know it)
        redirect: 'follow',
      });
    } catch (error) {
      throw new BackupError(`Could not reach GitHub (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  private async fail(res: Response, what: string): Promise<never> {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      // No readable body: the status alone has to do.
    }
    const hint =
      res.status === 401
        ? ' The token is wrong or has expired.'
        : res.status === 403
          ? ' The token may not do this (it needs "Contents: Read and write" on that repository), or GitHub is limiting requests for a while.'
          : res.status === 404
            ? ' GitHub cannot find it: check the repository name, and that the token was made for that repository.'
            : '';
    throw new BackupError(`GitHub: ${what} failed (HTTP ${res.status}${detail ? `: ${detail}` : ''}).${hint}`);
  }

  private async repoInfo(): Promise<{ isPrivate: boolean }> {
    const res = await this.call('GET', `${this.apiBase}/repos/${this.repo}`);
    if (!res.ok) return this.fail(res, `opening ${this.repo}`);
    const body = (await res.json()) as { private?: boolean };
    return { isPrivate: body.private !== false };
  }

  private async findRelease(): Promise<{ id: number } | null> {
    const res = await this.call('GET', `${this.apiBase}/repos/${this.repo}/releases/tags/${RELEASE_TAG}`);
    if (res.status === 404) return null;
    if (!res.ok) return this.fail(res, 'looking for the data release');
    return { id: ((await res.json()) as { id: number }).id };
  }

  private async ensureRelease(): Promise<{ id: number }> {
    const found = await this.findRelease();
    if (found) return found;
    const res = await this.call('POST', `${this.apiBase}/repos/${this.repo}/releases`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: RELEASE_TAG,
        name: 'TradeQuest data (automatic)',
        body: 'Automatic copies of the TradeQuest database. Do not edit or delete this release.',
        draft: false,
        prerelease: true,
      }),
    });
    if (res.status === 422) {
      // Somebody created it a moment ago.
      const again = await this.findRelease();
      if (again) return again;
    }
    if (!res.ok) return this.fail(res, 'creating the data release (does the repository have at least one commit? tick "Add a README" when you create it)');
    return { id: ((await res.json()) as { id: number }).id };
  }

  private async assetsOf(releaseId: number): Promise<ReleaseAsset[]> {
    const all: ReleaseAsset[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.call('GET', `${this.apiBase}/repos/${this.repo}/releases/${releaseId}/assets?per_page=100&page=${page}`);
      if (!res.ok) return this.fail(res, 'listing the copies');
      const batch = (await res.json()) as ReleaseAsset[];
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  private static newestFirst(assets: ReleaseAsset[]): BackupItem[] {
    return assets
      .filter((a) => a.state === 'uploaded' && NAME_PATTERN.test(a.name))
      .map((a) => ({ id: String(a.id), name: a.name, size: a.size }))
      .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  }

  async check(): Promise<StoreStatus> {
    const info = await this.repoInfo();
    const release = await this.findRelease();
    const copies = release ? GithubReleaseStore.newestFirst(await this.assetsOf(release.id)) : [];
    return { repo: this.repo, isPrivate: info.isPrivate, copies };
  }

  async list(): Promise<BackupItem[]> {
    await this.repoInfo(); // a repository we cannot open must never look like "no copies"
    const release = await this.findRelease();
    return release ? GithubReleaseStore.newestFirst(await this.assetsOf(release.id)) : [];
  }

  async download(item: BackupItem): Promise<Buffer> {
    if (item.size > MAX_PACKED_BYTES) throw new BackupError(`${item.name} is ${Math.round(item.size / 1048576)} MB packed, more than the ${MAX_PACKED_BYTES / 1048576} MB this program loads.`);
    const res = await this.call('GET', `${this.apiBase}/repos/${this.repo}/releases/assets/${item.id}`, { headers: { Accept: 'application/octet-stream' } });
    if (!res.ok) return this.fail(res, `downloading ${item.name}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async upload(name: string, data: Buffer): Promise<void> {
    const release = await this.ensureRelease();
    const res = await this.call('POST', `${this.uploadBase}/repos/${this.repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      headers: { 'Content-Type': 'application/gzip' },
      body: data,
    });
    if (res.status === 200 || res.status === 201) return;
    // A broken upload can leave an unfinished asset behind; clear those so they do not pile up.
    try {
      for (const a of await this.assetsOf(release.id)) if (a.state !== 'uploaded') await this.remove({ id: String(a.id), name: a.name, size: a.size });
    } catch {
      // The upload's own failure is the one to report.
    }
    return this.fail(res, `uploading ${name}`);
  }

  async remove(item: BackupItem): Promise<void> {
    const res = await this.call('DELETE', `${this.apiBase}/repos/${this.repo}/releases/assets/${item.id}`);
    if (res.status === 204 || res.status === 404) return;
    return this.fail(res, `deleting ${item.name}`);
  }
}

// ---- copies ----------------------------------------------------------------------------------------------------------------

/** The name of a copy made at `ms`: it sorts by time (UTC), so the newest is the last in alphabetical order. */
export function snapshotName(ms: number): string {
  return `tradequest-${new Date(ms).toISOString().replace(/[-:.]/g, '')}.sqlite.gz`;
}

export interface CopyInfo {
  readonly version: number;
  readonly accounts: number;
}

/** Opens a database file, checks that it is a healthy TradeQuest database, and clears the "a server is running" locks in it. */
export function checkAndClean(file: string): CopyInfo {
  const db = new Db(file);
  try {
    const quick = db.get<{ quick_check: string }>('PRAGMA quick_check');
    if (quick?.quick_check !== 'ok') throw new BackupError(`the copy is damaged (${quick?.quick_check ?? 'no answer'})`);
    const version = currentVersion(db);
    if (version < 1 || !db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'")) throw new BackupError('the file is not a TradeQuest database');
    if (db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'job_leases'")) db.run('DELETE FROM job_leases');
    const accounts = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { version, accounts };
  } finally {
    db.close();
  }
}

export interface SavedCopy {
  readonly name: string;
  readonly packedBytes: number;
  readonly rawBytes: number;
  readonly accounts: number;
  /** The clock reading the copy was named with. */
  readonly atMs: number;
}

export interface SaveOptions {
  readonly store: BackupStore;
  readonly db: Db;
  readonly now?: () => number;
  /** gzip level 1–9 (default 3: a fast one, because the free host has a very slow processor). */
  readonly level?: number;
  readonly tmpRoot?: string;
}

/** Makes a checked, packed copy of the database and uploads it. Throws a BackupError (or the store's error) if anything fails. */
export async function saveCopy(options: SaveOptions): Promise<SavedCopy> {
  const dir = mkdtempSync(join(options.tmpRoot ?? tmpdir(), 'tq-backup-'));
  try {
    const file = join(dir, 'copy.sqlite');
    await options.db.snapshotTo(file);
    const info = checkAndClean(file);
    const rawBytes = statSync(file).size;
    const packed = await gzip(readFileSync(file), { level: options.level ?? 3 });
    if (packed.length > MAX_PACKED_BYTES) throw new BackupError(`The database is ${Math.round(packed.length / 1048576)} MB packed, more than the ${MAX_PACKED_BYTES / 1048576} MB limit for the free copies.`);
    const atMs = (options.now ?? Date.now)();
    const name = snapshotName(atMs);
    await options.store.upload(name, packed);
    return { name, packedBytes: packed.length, rawBytes, accounts: info.accounts, atMs };
  } finally {
    removeQuietly(dir);
  }
}

/** Deletes all but the newest `keep` copies. Returns how many were deleted. Never throws: old copies are only clutter. */
export async function pruneCopies(store: BackupStore, keep: number, log: BackupLog): Promise<number> {
  let removed = 0;
  try {
    for (const item of (await store.list()).slice(keep)) {
      await store.remove(item);
      removed++;
    }
  } catch (error) {
    log.warn('backup', `Could not delete old copies (${error instanceof Error ? error.message : String(error)}). They are harmless; it will try again next time.`);
  }
  return removed;
}

// ---- starting up -----------------------------------------------------------------------------------------------------------

export type RestoreOutcome =
  | { readonly outcome: 'kept' }
  | { readonly outcome: 'fresh' }
  | { readonly outcome: 'restored'; readonly name: string; readonly accounts: number };

/**
 * Call before the database is opened. If there is no database file here (a freshly wiped host), loads the newest good copy from
 * the store. Returns what happened. THROWS when the store cannot be reached or every copy is unusable: starting a new world then
 * would put an empty game over the saved one.
 */
export async function restoreIfMissing(store: BackupStore, dbFile: string, log: BackupLog): Promise<RestoreOutcome> {
  if (existsFile(dbFile)) {
    log.info('backup', 'This computer already has a database, so nothing is loaded from the store.');
    return { outcome: 'kept' };
  }
  const copies = await store.list();
  if (copies.length === 0) {
    log.info('backup', `${store.describe} holds no copy yet, so this starts a new world (the first copy is saved a few minutes from now).`);
    return { outcome: 'fresh' };
  }
  mkdirSync(dirname(dbFile), { recursive: true });
  const partial = `${dbFile}.restoring`;
  for (const item of copies) {
    try {
      const packed = await store.download(item);
      const raw = await gunzip(packed, { maxOutputLength: MAX_RAW_BYTES });
      writeFileSync(partial, raw);
      const info = checkAndClean(partial);
      renameSync(partial, dbFile);
      log.info('backup', `Loaded ${item.name} from ${store.describe}: ${info.accounts} accounts, ${(raw.length / 1048576).toFixed(1)} MB.`);
      return { outcome: 'restored', name: item.name, accounts: info.accounts };
    } catch (error) {
      log.warn('backup', `Could not use ${item.name} (${error instanceof Error ? error.message : String(error)}); trying the one before it.`);
      for (const suffix of ['', '-wal', '-shm']) removeQuietly(partial + suffix);
    }
  }
  throw new BackupError(
    `${store.describe} holds ${copies.length} copies but none could be loaded. The server will NOT start a new world, so the saved data stays untouched. Check the messages above and try again.`,
  );
}

function existsFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// ---- while running ---------------------------------------------------------------------------------------------------------

export interface RunnerOptions {
  readonly store: BackupStore;
  readonly db: Db;
  readonly log: BackupLog;
  readonly intervalMs: number;
  readonly keep?: number;
  readonly now?: () => number;
  readonly level?: number;
  readonly tmpRoot?: string;
  /**
   * False when the store already holds exactly the world this server just loaded. Then nothing is saved until something changes
   * (see markDirty) or `maxQuietMs` has passed. Default true: a new copy is due at the first timer tick.
   */
  readonly startDirty?: boolean;
  /** Longest time (ms) without a save while the server runs, even if nothing was reported as changed. Default 60 minutes. */
  readonly maxQuietMs?: number;
}

/**
 * Saves a copy now and then while the server runs, and once more when it is told to stop. A failed save is logged, never fatal.
 *
 * To spare the host's upload allowance, the timer only saves when something may have changed: markDirty() is called for every
 * request that can change data (anything but GET/HEAD/OPTIONS). The market itself needs no copy of its own progress: it is
 * deterministic, so a copy plus the catch-up at the next start gives the same world. A copy is still refreshed every `maxQuietMs`
 * as a safety net (and so the catch-up after a long sleep stays short).
 */
export class BackupRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<boolean> | null = null;
  private failures = 0;
  private dirty: boolean;
  private lastSuccessAt = Date.now();
  lastSavedMs: number | null = null;
  skipped = 0;

  constructor(private readonly options: RunnerOptions) {
    this.dirty = options.startDirty ?? true;
  }

  /** Something that can change saved data just happened (a sign-in, a trade, an admin action...). The next timer tick saves. */
  markDirty(): void {
    this.dirty = true;
  }

  get hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.options.intervalMs);
    this.timer.unref?.();
  }

  private tick(): void {
    const quiet = this.options.maxQuietMs ?? DEFAULT_QUIET_MINUTES * 60_000;
    if (this.dirty || Date.now() - this.lastSuccessAt >= quiet) void this.runOnce();
    else this.skipped++;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One save. If one is already running, waits for that one instead of starting a second. Resolves true if a copy was stored. */
  runOnce(): Promise<boolean> {
    if (this.running) return this.running;
    const job = this.save().finally(() => {
      this.running = null;
    });
    this.running = job;
    return job;
  }

  /** Stops the timer and saves the latest state one last time, giving up after `timeoutMs` (the host kills a program that is slow to stop). */
  async final(timeoutMs: number): Promise<boolean> {
    this.stop();
    const { log } = this.options;
    const work = (async (): Promise<boolean> => {
      if (this.running) await this.running; // one in progress is older than now: let it finish, then take a fresh one
      if (!this.dirty) {
        log.info('backup', 'Nothing has changed since the last copy, so no new one is needed.');
        return true;
      }
      return this.runOnce();
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        log.warn('backup', `The last save did not finish within ${Math.round(timeoutMs / 1000)} seconds; the copy from ${this.lastSavedMs === null ? 'earlier' : new Date(this.lastSavedMs).toISOString()} stays the newest.`);
        resolve(false);
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async save(): Promise<boolean> {
    const { store, db, log, keep, now, level, tmpRoot } = this.options;
    const started = Date.now();
    // Cleared BEFORE the copy is taken: a change that lands while it is being made marks the next round.
    this.dirty = false;
    try {
      const saved = await saveCopy({ store, db, now, level, tmpRoot });
      this.failures = 0;
      this.lastSavedMs = saved.atMs;
      this.lastSuccessAt = Date.now();
      log.info('backup', `Saved ${saved.name} to ${store.describe}: ${(saved.packedBytes / 1048576).toFixed(1)} MB packed (${(saved.rawBytes / 1048576).toFixed(1)} MB), ${saved.accounts} accounts, ${((Date.now() - started) / 1000).toFixed(1)} s.`);
      await pruneCopies(store, keep ?? KEEP_COPIES, log);
      return true;
    } catch (error) {
      this.dirty = true; // the store does not have these changes yet
      this.failures++;
      const why = error instanceof Error ? error.message : String(error);
      if (this.failures >= 3) log.error('backup', `Saving the database failed ${this.failures} times in a row (${why}). The data is NOT being kept safe until this is fixed.`);
      else log.warn('backup', `Saving the database to ${store.describe} failed (${why}). It will try again.`);
      return false;
    }
  }
}
