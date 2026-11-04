// PayPal TEST payments for Shop looks (docs/world.md §43).
//
// A player can pay for a Shop look with PayPal instead of Career cash. This is PayPal's free SANDBOX only: the buyer is a made-up test account from PayPal's developer site, and no real
// money ever moves. It is OFF unless the owner sets TQ_PAYPAL_CLIENT_ID and TQ_PAYPAL_SECRET in the server's settings (on Render: Environment Variables); a site that does not set them (the
// real game) shows nothing about PayPal at all. The secret lives only in the server's memory: it is never written to the database, the log or any answer, and the browser never sees it
// (the client ID is public by design: the PayPal button needs it).
//
// Even with the two settings, PayPal stays hidden until the OWNER presses the PayPal ON/OFF button in the admin panel (docs/world.md §43): it starts OFF. While it is off the Shop shows
// nothing about PayPal and no new order can be started; an order a player had already started can still be finished (he may have paid in the PayPal window a moment before).
//
// How a payment goes (PayPal "Orders v2"; the server decides everything, the page only shows the PayPal button):
//   1. POST /api/paypal/orders {item}: the server checks the look can be bought (the same checks as the Shop's Career-cash buy), works out the price itself from the look's rarity
//      (src/shared/paypalCatalog.ts), asks PayPal to make an order for exactly that amount, and keeps a row in `paypal_orders` (PayPal's own order id is the key).
//   2. The buyer approves the payment in the PayPal window.
//   3. POST /api/paypal/capture {orderId}: only the player the order was made for may finish it. The server asks PayPal to take the payment, then checks PayPal's answer: the order AND the
//      payment are COMPLETED, the amount is exactly the price in the row, the currency is USD, and the order's custom_id names this player and this look. Only then is the look given
//      (the same `give` the daily goals use), and the row becomes `granted`. Finishing the same order again gives nothing more (`already: true`).
//   • Nothing the browser sends decides a price, a look or a player. A payment that is not confirmed gives nothing.
//   • The rows are kept (they are the record); unpaid ones older than three days are swept when the next order is made.

import { randomUUID } from 'node:crypto';
import { PAYPAL_CURRENCY, centsOfPaypalValue, paypalAmountValue, paypalMoneyText, paypalPriceOf } from '../src/shared/paypalCatalog';
import type { PaypalConfig, PaypalOrderStarted, PaypalPaid, ShopView } from '../src/shared/types';
import type { User } from './auth';
import { ShopError, type Shop } from './cosmetics';
import type { Logger } from './log';
import type { Db } from './sqlite';

/** PayPal's test servers. Nothing else is accepted (except this very computer, for the tests): there is deliberately no way to point TradeQuest at PayPal's real-money servers. */
export const PAYPAL_SANDBOX_API = 'https://api-m.sandbox.paypal.com';
export const PAYPAL_TIMEOUT_MS = 20_000;
/** The owner's switch is this row of `meta` (present and "1" = on). No row = off, which is what a new database has. */
export const SWITCH_KEY = 'paypal_on';
/** An order that was made but never paid is forgotten after this long. */
export const UNPAID_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

export interface PaypalSettings {
  /** Public by design: the PayPal button needs it. */
  readonly clientId: string;
  /** Never enumerable, so it cannot end up in a JSON dump or a log line by accident. */
  readonly secret: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

/** The address of PayPal's TEST servers (or, for the tests only, this very computer). Anything else, in particular PayPal's real-money servers, is an error. */
export function safePaypalBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('TQ_PAYPAL_BASE_URL is not an address.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  const sandbox = url.protocol === 'https:' && url.hostname === 'api-m.sandbox.paypal.com' && url.port === '';
  if (!sandbox && !(url.protocol === 'http:' && local)) throw new Error(`TQ_PAYPAL_BASE_URL must be ${PAYPAL_SANDBOX_API} (PayPal test mode). TradeQuest does not take real-money PayPal payments.`);
  if (url.username !== '' || url.password !== '') throw new Error('TQ_PAYPAL_BASE_URL must not contain a name or a password.');
  return raw.replace(/\/+$/, '');
}

/** The PayPal settings from the environment, or null when PayPal is off (no TQ_PAYPAL_CLIENT_ID and no TQ_PAYPAL_SECRET). A wrong setting is an error with a plain explanation that never repeats the values. */
export function loadPaypalSettings(env: NodeJS.ProcessEnv = process.env): PaypalSettings | null {
  const clientId = (env.TQ_PAYPAL_CLIENT_ID ?? '').trim();
  const secret = (env.TQ_PAYPAL_SECRET ?? '').trim();
  if (clientId === '' && secret === '') return null;
  if (clientId === '' || secret === '') throw new Error('PayPal test mode needs both TQ_PAYPAL_CLIENT_ID and TQ_PAYPAL_SECRET.');
  const mode = (env.TQ_PAYPAL_ENV ?? 'sandbox').trim().toLowerCase();
  if (mode !== 'sandbox') throw new Error('TQ_PAYPAL_ENV must be sandbox. TradeQuest only takes PayPal TEST payments; real money is not supported.');
  if (!/^[A-Za-z0-9_-]{20,255}$/.test(clientId)) throw new Error('TQ_PAYPAL_CLIENT_ID does not look like a PayPal client ID (it has letters, numbers, - and _ only, and is long).');
  if (!/^[\x21-\x7e]{10,255}$/.test(secret)) throw new Error('TQ_PAYPAL_SECRET does not look like a PayPal secret (10 to 255 visible characters, no spaces).');
  const baseUrl = safePaypalBase((env.TQ_PAYPAL_BASE_URL ?? '').trim() || PAYPAL_SANDBOX_API);
  const settings = { clientId, baseUrl, timeoutMs: PAYPAL_TIMEOUT_MS };
  Object.defineProperty(settings, 'secret', { value: secret, enumerable: false });
  return settings as PaypalSettings;
}

// ---- talking to PayPal

export type PaypalApiErrorKind = 'timeout' | 'network' | 'http' | 'bad_response';

export class PaypalApiError extends Error {
  constructor(
    readonly kind: PaypalApiErrorKind,
    message: string,
    readonly status?: number,
    /** PayPal's short name for what went wrong, for example INSTRUMENT_DECLINED or ORDER_ALREADY_CAPTURED. */
    readonly issue?: string,
  ) {
    super(message);
  }
}

/** What PayPal says about an order (and the payment taken for it, if any). */
export interface PaypalOrderInfo {
  readonly id: string | null;
  readonly status: string | null;
  readonly customId: string | null;
  readonly captureId: string | null;
  readonly captureStatus: string | null;
  readonly amountCents: number | null;
  readonly currency: string | null;
}

export interface PaypalClient {
  /** Makes an order for exactly this amount (USD). */
  createOrder(input: { amountCents: number; description: string; customId: string; requestId: string }): Promise<{ id: string }>;
  /** Takes the payment of an approved order. */
  captureOrder(orderId: string): Promise<PaypalOrderInfo>;
  /** Asks what PayPal knows about an order. */
  getOrder(orderId: string): Promise<PaypalOrderInfo>;
}

interface ClientOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function firstOf(v: unknown): Json | null {
  return Array.isArray(v) ? asObject(v[0]) : null;
}

function textOf(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Reads PayPal's order answer. Anything missing stays null, and a null can never pass the checks in `capture`. */
export function orderInfoOf(json: unknown): PaypalOrderInfo {
  const o = asObject(json) ?? {};
  const unit = firstOf(o.purchase_units);
  const capture = firstOf(asObject(unit?.payments)?.captures);
  const amount = asObject(capture?.amount);
  return {
    id: textOf(o.id),
    status: textOf(o.status),
    customId: textOf(capture?.custom_id) ?? textOf(unit?.custom_id),
    captureId: textOf(capture?.id),
    captureStatus: textOf(capture?.status),
    amountCents: centsOfPaypalValue(amount?.value),
    currency: textOf(amount?.currency_code),
  };
}

export function createPaypalClient(settings: PaypalSettings, options: ClientOptions = {}): PaypalClient {
  const doFetch = options.fetch ?? fetch;
  const clock = options.now ?? Date.now;
  let cached: { readonly token: string; readonly expiresAt: number } | null = null;

  async function call(method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
      const res = await doFetch(`${settings.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body } : {}), signal: controller.signal });
      const text = (await res.text()).slice(0, 200_000);
      let json: unknown = null;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch (error) {
      if (controller.signal.aborted) throw new PaypalApiError('timeout', 'PayPal took too long to answer.');
      throw new PaypalApiError('network', error instanceof Error && error.name === 'AbortError' ? 'The PayPal request was stopped.' : 'PayPal could not be reached.');
    } finally {
      clearTimeout(timer);
    }
  }

  function failure(status: number, json: unknown): PaypalApiError {
    const o = asObject(json);
    const issue = textOf(firstOf(o?.details)?.issue) ?? textOf(o?.name) ?? undefined;
    return new PaypalApiError('http', `PayPal answered ${status}${issue ? ` (${issue})` : ''}.`, status, issue);
  }

  async function token(): Promise<string> {
    if (cached !== null && cached.expiresAt > clock() + 60_000) return cached.token;
    const basic = Buffer.from(`${settings.clientId}:${settings.secret}`).toString('base64');
    const out = await call('POST', '/v1/oauth2/token', { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, 'grant_type=client_credentials');
    if (out.status !== 200) throw new PaypalApiError('http', `PayPal refused the sign-in (${out.status}). Check the client ID and the secret in the server's settings.`, out.status);
    const o = asObject(out.json);
    const access = textOf(o?.access_token);
    const seconds = typeof o?.expires_in === 'number' && o.expires_in > 0 ? o.expires_in : 300;
    if (access === null) throw new PaypalApiError('bad_response', 'PayPal did not give an access token.');
    cached = { token: access, expiresAt: clock() + seconds * 1000 };
    return access;
  }

  async function authed(method: 'GET' | 'POST', path: string, extra: Record<string, string>, body?: string): Promise<{ status: number; json: unknown }> {
    const out = await call(method, path, { Authorization: `Bearer ${await token()}`, Accept: 'application/json', ...extra }, body);
    if (out.status === 401) cached = null; // the next call asks for a fresh token
    return out;
  }

  return {
    async createOrder(input) {
      const body = {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: 'tradequest-look', custom_id: input.customId, description: input.description.slice(0, 120), amount: { currency_code: PAYPAL_CURRENCY, value: paypalAmountValue(input.amountCents) } }],
        application_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', brand_name: 'TradeQuest (test)' },
      };
      const out = await authed('POST', '/v2/checkout/orders', { 'Content-Type': 'application/json', 'PayPal-Request-Id': input.requestId }, JSON.stringify(body));
      if (out.status < 200 || out.status >= 300) throw failure(out.status, out.json);
      const id = textOf(asObject(out.json)?.id);
      if (id === null) throw new PaypalApiError('bad_response', 'PayPal did not give an order id.');
      return { id };
    },
    async captureOrder(orderId) {
      const out = await authed('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { 'Content-Type': 'application/json', 'PayPal-Request-Id': `tq-capture-${orderId}`, Prefer: 'return=representation' }, '{}');
      if (out.status < 200 || out.status >= 300) throw failure(out.status, out.json);
      return orderInfoOf(out.json);
    },
    async getOrder(orderId) {
      const out = await authed('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`, {});
      if (out.status < 200 || out.status >= 300) throw failure(out.status, out.json);
      return orderInfoOf(out.json);
    },
  };
}

// ---- the service

export class PaypalError extends Error {
  constructor(
    readonly code: 'paypal_off' | 'bad_request' | 'no_such_order' | 'busy' | 'not_paid' | 'payment_declined' | 'paypal_unavailable',
    message: string,
    readonly status: number,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface PaypalDeps {
  readonly db: Db;
  readonly now: () => number;
  readonly log: Logger;
  readonly shop: Shop;
  /** Null = PayPal is off. */
  readonly client: PaypalClient | null;
  /** The public client ID the page's PayPal button needs. */
  readonly clientId: string;
}

interface OrderRow {
  id: string;
  user_id: number;
  item: string;
  amount_cents: number;
  status: 'created' | 'granting' | 'granted' | 'paid_not_granted';
}

/** PayPal's order ids are short upper-case words and numbers; anything else is never even sent to PayPal. */
const ORDER_ID = /^[A-Za-z0-9_-]{5,64}$/;

/** What PayPal gets back to us as `custom_id`: it names the player and the look this order was made for. */
export function customIdOf(userId: number, item: string): string {
  return `tq:${userId}:${item}`;
}

export class Paypal {
  /** Orders being finished right now in this process, so two clicks at once cannot both take the payment. */
  private readonly busy = new Set<string>();

  constructor(private readonly d: PaypalDeps) {}

  /** Whether the server has the two PayPal settings (a client is made). Without them there is nothing the owner's switch could turn on. */
  configured(): boolean {
    return this.d.client !== null;
  }

  /** The owner's ON/OFF button. A new database says off. */
  switchedOn(): boolean {
    return this.d.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', SWITCH_KEY)?.value === '1';
  }

  setSwitch(on: boolean): void {
    if (on) this.d.db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', SWITCH_KEY, '1');
    else this.d.db.run('DELETE FROM meta WHERE key = ?', SWITCH_KEY);
  }

  /** PayPal is showing to players: the settings are there AND the owner switched it on. */
  enabled(): boolean {
    return this.configured() && this.switchedOn();
  }

  /** What the page needs to know. When PayPal is off it is only `{enabled: false}`. */
  publicConfig(): PaypalConfig {
    if (!this.enabled()) return { enabled: false };
    return { enabled: true, env: 'sandbox', clientId: this.d.clientId, currency: PAYPAL_CURRENCY };
  }

  /** What the owner's panel shows. */
  adminView(): { configured: boolean; on: boolean; showing: boolean; env: 'sandbox'; orders: Record<string, number> } {
    return { configured: this.configured(), on: this.switchedOn(), showing: this.enabled(), env: 'sandbox', orders: this.counts() };
  }

  private client(): PaypalClient {
    if (this.d.client === null) throw new PaypalError('paypal_off', 'PayPal test payments are not switched on here.', 404);
    return this.d.client;
  }

  /** Runs one PayPal call and turns a PayPal problem into a plain answer. Nothing PayPal says is passed on word for word. */
  private async ask<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof PaypalApiError) {
        this.d.log.warn('account', `PayPal (${what}) failed: ${error.message}`);
        if (error.issue === 'INSTRUMENT_DECLINED') throw new PaypalError('payment_declined', 'PayPal declined that payment. Nothing was taken. Pick another way to pay in the PayPal window.', 402);
        throw new PaypalError('paypal_unavailable', 'PayPal could not finish that just now. Nothing was given. Try again in a moment.', 502);
      }
      throw error;
    }
  }

  /** Step 1: makes the PayPal order for one look and remembers it for this player. */
  async createOrder(me: User, rawItem: unknown): Promise<PaypalOrderStarted> {
    // A new order starts only while PayPal is showing (the owner's switch is on).
    if (!this.enabled()) throw new PaypalError('paypal_off', 'PayPal test payments are not switched on here.', 404);
    const client = this.client();
    const def = this.d.shop.checkBuyable(me, rawItem);
    const amountCents = paypalPriceOf(def);
    const made = await this.ask('create', () => client.createOrder({ amountCents, description: `TradeQuest look: ${def.name} (test)`, customId: customIdOf(me.id, def.id), requestId: randomUUID() }));
    if (!ORDER_ID.test(made.id)) throw new PaypalError('paypal_unavailable', 'PayPal could not finish that just now. Nothing was given. Try again in a moment.', 502);
    const now = this.d.now();
    this.d.db.run("DELETE FROM paypal_orders WHERE status = 'created' AND created_ms < ?", now - UNPAID_KEEP_MS);
    this.d.db.run("INSERT INTO paypal_orders(id, user_id, item, amount_cents, status, capture_id, created_ms, updated_ms) VALUES (?, ?, ?, ?, 'created', NULL, ?, ?)", made.id, me.id, def.id, amountCents, now, now);
    return { orderId: made.id, item: def.id, amountCents };
  }

  /**
   * Step 3: takes the payment, checks PayPal's answer, and gives the look. Only the player the order was made for may finish it. It works whenever the settings are there, even if the owner
   * switched PayPal off after the order was started (the buyer may have approved a moment before): switching off stops NEW orders, it never strands a paid one.
   */
  async capture(me: User, rawOrderId: unknown): Promise<PaypalPaid> {
    const client = this.client();
    if (typeof rawOrderId !== 'string' || !ORDER_ID.test(rawOrderId)) throw new PaypalError('bad_request', 'orderId must be the id of a PayPal order made for you.', 400);
    const row = this.d.db.get<OrderRow>('SELECT id, user_id, item, amount_cents, status FROM paypal_orders WHERE id = ? AND user_id = ?', rawOrderId, me.id);
    // Somebody else's order looks exactly like an order that does not exist.
    if (!row) throw new PaypalError('no_such_order', 'There is no PayPal order like that for you.', 404);
    if (row.status === 'granted' || row.status === 'paid_not_granted') return { ...this.d.shop.view(me), item: row.item, orderId: row.id, amountCents: row.amount_cents, already: true };
    if (this.busy.has(row.id)) throw new PaypalError('busy', 'That payment is being finished already. Wait a moment.', 409);
    this.busy.add(row.id);
    try {
      // Before any money is taken: he must still be allowed to have the look (not bought another way in the meantime).
      if (row.status === 'created') this.d.shop.checkBuyable(me, row.item);
      let info: PaypalOrderInfo;
      if (row.status === 'created') {
        try {
          info = await this.ask('capture', () => client.captureOrder(row.id));
        } catch (error) {
          // A second try (a reload, a slow answer) finds the payment already taken: ask what PayPal knows instead of failing.
          const again = error instanceof PaypalError && error.code === 'paypal_unavailable';
          if (!again) throw error;
          info = await this.ask('look up', () => client.getOrder(row.id));
        }
      } else {
        info = await this.ask('look up', () => client.getOrder(row.id));
      }
      const paid =
        info.status === 'COMPLETED' &&
        info.captureStatus === 'COMPLETED' &&
        info.amountCents === row.amount_cents &&
        info.currency === PAYPAL_CURRENCY &&
        info.customId === customIdOf(me.id, row.item);
      if (!paid) {
        this.d.log.warn('account', `PayPal order ${row.id} of ${me.username} is not a finished payment for "${row.item}" (status ${info.status ?? '?'}, payment ${info.captureStatus ?? '?'}); nothing was given.`);
        throw new PaypalError('not_paid', 'PayPal did not confirm a finished payment for this look, so nothing was given.', 409);
      }
      const claimed = this.d.db.run("UPDATE paypal_orders SET status = 'granting', capture_id = ?, updated_ms = ? WHERE id = ? AND status IN ('created', 'granting')", info.captureId, this.d.now(), row.id);
      if (claimed.changes !== 1) throw new PaypalError('busy', 'That payment is being finished already. Wait a moment.', 409);
      let view: ShopView;
      let final: 'granted' | 'paid_not_granted' = 'granted';
      try {
        view = this.d.shop.give(me, row.item, `PayPal test payment ${row.id}`);
      } catch (error) {
        if (!(error instanceof ShopError) || error.code !== 'already_owned') throw error; // anything else leaves the row on `granting`: finishing it again completes it
        // A retry of an order that was already being given (the first try died before it could write `granted`) finds the look already his: that is a success, not a surplus.
        final = row.status === 'granting' ? 'granted' : 'paid_not_granted';
        view = this.d.shop.view(me);
        this.d.log.warn('account', `${me.username} paid PayPal order ${row.id} for "${row.item}" but already owned it; nothing more was given.`);
      }
      this.d.db.run('UPDATE paypal_orders SET status = ?, updated_ms = ? WHERE id = ?', final, this.d.now(), row.id);
      this.d.log.info('account', `${me.username} paid ${paypalMoneyText(row.amount_cents)} in PayPal TEST mode for "${row.item}" (order ${row.id}).`);
      return { ...view, item: row.item, orderId: row.id, amountCents: row.amount_cents, already: false };
    } finally {
      this.busy.delete(row.id);
    }
  }

  /** How many orders are in each state (for the owner's checks and the tests). */
  counts(): Record<string, number> {
    const rows = this.d.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM paypal_orders GROUP BY status');
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}
