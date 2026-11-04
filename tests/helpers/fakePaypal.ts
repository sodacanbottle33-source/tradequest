// A pretend PayPal for the tests (server/paypal.ts). It is a real little web server on this computer that answers the three things TradeQuest asks of PayPal's test servers
// (sign in, make an order, take the payment / look an order up) with the same shapes PayPal documents, so the REAL client code runs against it. A test chooses how it behaves
// (`behave`) and says when the pretend buyer approves an order (`approve`). Nothing here talks to the internet.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_CLIENT_ID = 'AcLientIdForTestsOnly0123456789abcdefABCDEF';
export const FAKE_SECRET = 'SECRET-for-tests-ONLY-9f3a7c21d5';

export interface FakeOrder {
  readonly id: string;
  readonly amount: string;
  readonly currency: string;
  readonly customId: string;
  approved: boolean;
  captured: boolean;
  readonly captureId: string;
}

export interface Behave {
  /** The sign-in is refused. */
  refuseToken: boolean;
  /** Every order call answers 500. */
  down: boolean;
  /** Taking the payment is declined by the buyer's bank. */
  decline: boolean;
  /** PayPal writes this amount for the payment instead of the real one. */
  amountOverride: string | null;
  /** PayPal writes this currency for the payment. */
  currencyOverride: string | null;
  /** PayPal writes this custom_id for the payment. */
  customIdOverride: string | null;
  /** The payment's own status (default COMPLETED). */
  captureStatus: string;
  /** The ORDER's status as PayPal writes it, instead of the real one (null = the real one). */
  orderStatus: string | null;
  /** PayPal gives this id for a new order instead of a normal one. */
  orderIdOverride: string | null;
  /** Wait this many milliseconds before answering a capture (to let two clicks overlap). */
  captureDelayMs: number;
}

export interface FakePaypal {
  readonly base: string;
  readonly orders: Map<string, FakeOrder>;
  /** "METHOD path" of every call, in order. */
  readonly calls: string[];
  readonly behave: Behave;
  tokenCalls(): number;
  captureCalls(): number;
  approve(orderId: string): void;
  close(): Promise<void>;
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakePaypal(): Promise<FakePaypal> {
  const orders = new Map<string, FakeOrder>();
  const calls: string[] = [];
  const behave: Behave = { refuseToken: false, down: false, decline: false, amountOverride: null, currencyOverride: null, customIdOverride: null, captureStatus: 'COMPLETED', orderStatus: null, orderIdOverride: null, captureDelayMs: 0 };
  let counter = 0;
  const basic = Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_SECRET}`).toString('base64');

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const path = url.pathname;
      calls.push(`${req.method} ${path}`);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const raw = await bodyOf(req);
      if (path === '/v1/oauth2/token') {
        if (behave.refuseToken || req.headers.authorization !== `Basic ${basic}` || raw !== 'grant_type=client_credentials') return send(401, { error: 'invalid_client' });
        return send(200, { access_token: 'tok-1', token_type: 'Bearer', expires_in: 32400 });
      }
      if (req.headers.authorization !== 'Bearer tok-1') return send(401, { name: 'AUTHENTICATION_FAILURE' });
      if (behave.down) return send(500, { name: 'INTERNAL_SERVER_ERROR' });

      if (req.method === 'POST' && path === '/v2/checkout/orders') {
        const body = JSON.parse(raw) as { intent?: string; purchase_units?: { amount?: { currency_code?: string; value?: string }; custom_id?: string }[] };
        const unit = body.purchase_units?.[0];
        if (body.intent !== 'CAPTURE' || !unit?.amount?.value || !unit.custom_id) return send(400, { name: 'INVALID_REQUEST' });
        counter += 1;
        const id = behave.orderIdOverride ?? `ORDER${String(counter).padStart(6, '0')}X`;
        orders.set(id, { id, amount: unit.amount.value, currency: unit.amount.currency_code ?? '', customId: unit.custom_id, approved: false, captured: false, captureId: `CAPTURE${String(counter).padStart(6, '0')}` });
        return send(201, { id, status: 'CREATED', links: [] });
      }

      const m = /^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/.exec(path);
      if (!m) return send(404, { name: 'NOT_FOUND' });
      const order = orders.get(decodeURIComponent(m[1] as string));
      if (!order) return send(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
      const shape = () => ({
        id: order.id,
        status: behave.orderStatus ?? (order.captured ? 'COMPLETED' : order.approved ? 'APPROVED' : 'CREATED'),
        purchase_units: [
          {
            reference_id: 'tradequest-look',
            ...(order.captured
              ? {
                  payments: {
                    captures: [
                      {
                        id: order.captureId,
                        status: behave.captureStatus,
                        amount: { currency_code: behave.currencyOverride ?? order.currency, value: behave.amountOverride ?? order.amount },
                        custom_id: behave.customIdOverride ?? order.customId,
                      },
                    ],
                  },
                }
              : { custom_id: order.customId, amount: { currency_code: order.currency, value: order.amount } }),
          },
        ],
      });
      if (req.method === 'GET' && !m[2]) return send(200, shape());
      if (req.method === 'POST' && m[2]) {
        if (behave.captureDelayMs > 0) await new Promise((done) => setTimeout(done, behave.captureDelayMs));
        if (order.captured) return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
        if (!order.approved) return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
        if (behave.decline) return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] });
        order.captured = true;
        return send(201, shape());
      }
      return send(405, { name: 'METHOD_NOT_ALLOWED' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    orders,
    calls,
    behave,
    tokenCalls: () => calls.filter((c) => c === 'POST /v1/oauth2/token').length,
    captureCalls: () => calls.filter((c) => c.endsWith('/capture')).length,
    approve(orderId) {
      const o = orders.get(orderId);
      if (!o) throw new Error(`the fake PayPal has no order ${orderId}`);
      o.approved = true;
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
