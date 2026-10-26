// Settings come from environment variables, with safe defaults for running on your own computer.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAiSettings, type AiSettings } from './aiClient';

/** A file in the data folder holding the owner's username (written by `npm run owner -- <username>`). */
export const OWNER_FILE = 'owner.txt';
const OWNER_NAME = /^[A-Za-z0-9_]{3,20}$/;

/** One server a browser may use to find a way to connect two players directly (WebRTC): a free STUN server, or a TURN relay. */
export interface IceServer {
  readonly urls: readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

/** Free public STUN servers: they only tell a browser its own public address. Most home networks connect directly with just these. */
export const DEFAULT_ICE_SERVERS: readonly IceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly dataDir: string;
  readonly dbFile: string;
  /** How many companies the world has (the hand-written ones first). Existing companies are never removed. */
  readonly companies: number;
  /** On the very first start the world is simulated this many days into the past, so it already has a history. */
  readonly warmupDays: number;
  /** Whether the world has the thirty memecoins (TQ_MEMECOINS=0 keeps them out of a world that does not have them yet). */
  readonly memecoins: boolean;
  /** Computer opponents in the 1v1 lobby (TQ_BOTS=0 switches them off). */
  readonly bots: boolean;
  /** The same bots trading in the main market with their own money (on with the bots; TQ_MARKET_BOTS=0 switches only this off). */
  readonly marketBots: boolean;
  /** The one username that is the owner (admin): TQ_OWNER, or else the first line of data/owner.txt. Empty = nobody. */
  readonly ownerUsername: string;
  /** The servers voice calls use to connect two players (TQ_ICE_SERVERS: a JSON list; the default is free public STUN). */
  readonly iceServers: readonly IceServer[];
  /** The AI teacher of the Learn lessons (TQ_AI_KEY and friends, server/aiClient.ts). Null = off, which is the default. */
  readonly ai: AiSettings | null;
  /** Why the AI teacher is off although a setting for it was given (a wrong value), or null. A wrong AI setting never stops the game from starting. */
  readonly aiProblem: string | null;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  return n;
}

/** TQ_ICE_SERVERS: a JSON list like [{"urls":["stun:example.org:3478"]},{"urls":"turn:example.org:3478","username":"u","credential":"p"}]. */
export function iceServersOf(raw: string | undefined): readonly IceServer[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ICE_SERVERS;
  const bad = (why: string): never => {
    throw new Error(`TQ_ICE_SERVERS ${why}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bad('must be a JSON list, for example [{"urls":["stun:stun.example.org:3478"]}].');
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) return bad('must be a list of 1 to 8 servers.');
  return parsed.map((item: unknown): IceServer => {
    const o = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const urls = typeof o.urls === 'string' ? [o.urls] : o.urls;
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > 4 || urls.some((u) => typeof u !== 'string' || !/^(stun|turn|turns):[^\s]{1,200}$/.test(u))) {
      return bad('needs "urls" for every server: one or more addresses that start with stun:, turn: or turns:.');
    }
    for (const key of ['username', 'credential'] as const) {
      const v = o[key];
      if (v !== undefined && (typeof v !== 'string' || v.length > 512)) return bad(`has a "${key}" that is not text of at most 512 characters.`);
    }
    return { urls: urls as string[], ...(typeof o.username === 'string' ? { username: o.username } : {}), ...(typeof o.credential === 'string' ? { credential: o.credential } : {}) };
  });
}

/** The owner's username from TQ_OWNER or from data/owner.txt. A file that cannot be read is an error, not "no owner". */
function ownerOf(env: NodeJS.ProcessEnv, dataDir: string): string {
  const fromEnv = (env.TQ_OWNER ?? '').trim();
  if (fromEnv !== '') return fromEnv;
  const file = join(dataDir, OWNER_FILE);
  if (!existsSync(file)) return '';
  const first = (readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0] ?? '').trim();
  if (first === '') return '';
  if (!OWNER_NAME.test(first)) throw new Error(`${file} must contain one username (3–20 letters, numbers or underscores), got "${first}".`);
  return first;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.TQ_DATA_DIR && env.TQ_DATA_DIR !== '' ? env.TQ_DATA_DIR : join(process.cwd(), 'data');
  const level = (env.TQ_LOG_LEVEL ?? 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new Error(`TQ_LOG_LEVEL must be debug, info, warn or error, got "${level}"`);
  // The AI teacher is optional: a wrong value in its settings turns it off and says why (the game still starts), it never stops the server.
  const ai: { settings: AiSettings | null; problem: string | null } = { settings: null, problem: null };
  try {
    ai.settings = loadAiSettings(env);
  } catch (error) {
    ai.problem = error instanceof Error ? error.message : String(error);
  }
  return {
    port: int(env, 'TQ_PORT', 8787, 1, 65535),
    host: env.TQ_HOST && env.TQ_HOST !== '' ? env.TQ_HOST : '127.0.0.1',
    dataDir,
    dbFile: join(dataDir, 'tradequest.sqlite'),
    companies: int(env, 'TQ_COMPANIES', 66, 1, 5000),
    warmupDays: int(env, 'TQ_WARMUP_DAYS', 7, 0, 60),
    memecoins: (env.TQ_MEMECOINS ?? '1') !== '0',
    bots: (env.TQ_BOTS ?? '1') !== '0',
    marketBots: (env.TQ_BOTS ?? '1') !== '0' && (env.TQ_MARKET_BOTS ?? '1') !== '0',
    ownerUsername: ownerOf(env, dataDir),
    iceServers: iceServersOf(env.TQ_ICE_SERVERS),
    ai: ai.settings,
    aiProblem: ai.problem,
    logLevel: level as Config['logLevel'],
  };
}

/** The folder where this computer keeps its TradeQuest data (the same rule the server uses). */
export function dataDirOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.TQ_DATA_DIR && env.TQ_DATA_DIR !== '' ? env.TQ_DATA_DIR : join(process.cwd(), 'data');
}

/** Makes `username` the owner from the next server start on (written to data/owner.txt). Returns the file's path. */
export function writeOwnerFile(dataDir: string, username: string): string {
  const name = username.trim();
  if (!OWNER_NAME.test(name)) throw new Error('The owner must be one username: 3–20 letters, numbers or underscores.');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, OWNER_FILE);
  writeFileSync(file, `${name}\n`, 'utf8');
  return file;
}

/** Removes the owner file, so (without TQ_OWNER) nobody is the owner from the next start on. Returns true if there was one. */
export function clearOwnerFile(dataDir: string): boolean {
  const file = join(dataDir, OWNER_FILE);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
