// The PayPal TEST button for one Shop look (docs/world.md §43). It only shows PayPal's own button and hands the order the server made to it; the server decides the price, the look and the
// player (server/paypal.ts), and checks with PayPal that the payment really happened before it gives anything. This is PayPal's free sandbox: the buyer is a made-up test account and no
// real money moves. The PayPal script is loaded only when a player opens this button, and only from paypal.com.
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { CosmeticDef } from './cosmeticCatalog';
import { PAYPAL_CURRENCY, paypalMoneyText, paypalPriceOf } from './paypalCatalog';
import { problemText } from './playersUtil';
import type { PaypalConfig, PaypalPaid } from './types';

/** The few parts of PayPal's browser script this page uses. */
interface PaypalButtons {
  render(container: HTMLElement): Promise<void>;
  close(): Promise<void>;
}
interface PaypalNamespace {
  Buttons(options: {
    style?: Record<string, unknown>;
    createOrder: () => Promise<string>;
    onApprove: (data: { orderID: string }) => Promise<void>;
    onCancel?: () => void;
    onError?: (error: unknown) => void;
  }): PaypalButtons;
}
declare global {
  interface Window {
    paypal?: PaypalNamespace;
  }
}

/** Where PayPal's script comes from. Nothing else is ever loaded for payments. */
export const PAYPAL_SDK = 'https://www.paypal.com/sdk/js';

/** The script's address for one client ID: test-mode buttons only, in US dollars, for a payment taken at once. */
export function sdkUrl(clientId: string): string {
  return `${PAYPAL_SDK}?client-id=${encodeURIComponent(clientId)}&currency=${PAYPAL_CURRENCY}&intent=capture&components=buttons&disable-funding=credit,paylater,venmo`;
}

let loading: { readonly clientId: string; readonly promise: Promise<PaypalNamespace> } | null = null;

/** Loads PayPal's script once (again only after a failure, or for another client ID). */
export function loadPaypal(clientId: string): Promise<PaypalNamespace> {
  if (loading !== null && loading.clientId === clientId) return loading.promise;
  const promise = new Promise<PaypalNamespace>((resolve, reject) => {
    const fail = () => {
      loading = null;
      reject(new Error('PayPal could not be loaded. Check your connection, or turn off an ad blocker for this site, and try again.'));
    };
    const script = document.createElement('script');
    script.src = sdkUrl(clientId);
    script.async = true;
    script.onload = () => {
      const paypal = window.paypal;
      if (paypal) resolve(paypal);
      else fail();
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  loading = { clientId, promise };
  return promise;
}

export function PaypalPay({ config, def, onPaid, onCancel }: { config: PaypalConfig; def: CosmeticDef; onPaid: (out: PaypalPaid) => void; onCancel: () => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  const latest = useRef({ onPaid });
  latest.current = { onPaid };
  const lastProblem = useRef<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const clientId = config.clientId ?? '';

  useEffect(() => {
    if (!config.enabled || clientId === '') return undefined;
    let alive = true;
    let buttons: PaypalButtons | null = null;
    loadPaypal(clientId)
      .then(async (paypal) => {
        if (!alive || box.current === null) return;
        buttons = paypal.Buttons({
          style: { layout: 'horizontal', height: 36, tagline: false, label: 'pay', shape: 'rect' },
          // The server makes the order and picks the price. The page sends only which look.
          createOrder: async () => {
            lastProblem.current = null;
            try {
              return (await api.paypalCreate(def.id)).orderId;
            } catch (e) {
              lastProblem.current = problemText(e);
              throw e;
            }
          },
          // After the buyer approved in the PayPal window the server takes the payment, checks it with PayPal and gives the look.
          onApprove: async (data) => {
            if (alive) setWorking(true);
            try {
              const out = await api.paypalCapture(data.orderID);
              if (alive) latest.current.onPaid(out);
            } catch (e) {
              if (alive) setProblem(problemText(e));
            } finally {
              if (alive) setWorking(false);
            }
          },
          onCancel: () => {
            if (alive) setProblem('You closed the PayPal window. Nothing was taken.');
          },
          onError: () => {
            if (alive) setProblem(lastProblem.current ?? 'PayPal could not finish that. Nothing was taken. Try again.');
          },
        });
        await buttons.render(box.current);
        if (alive) setReady(true);
      })
      .catch((e: unknown) => {
        if (alive) setProblem(problemText(e));
      });
    return () => {
      alive = false;
      if (buttons !== null) void buttons.close().catch(() => undefined);
    };
  }, [clientId, def.id, config.enabled]);

  return (
    <div className="paypal-pay" data-testid={`paypal-pay-${def.id}`}>
      <p className="paypal-pay-line">
        <strong>{paypalMoneyText(paypalPriceOf(def))}</strong> <span className="paypal-test-tag">TEST</span> <span className="muted">in PayPal test money for {def.name}</span>
      </p>
      <div className="paypal-box" ref={box} data-testid={`paypal-box-${def.id}`} aria-busy={!ready || working} />
      {!ready && !problem && (
        <p className="muted paypal-wait" data-testid={`paypal-loading-${def.id}`}>
          Loading PayPal…
        </p>
      )}
      {working && (
        <p className="muted paypal-wait" role="status" data-testid={`paypal-working-${def.id}`}>
          Finishing your payment…
        </p>
      )}
      {problem && (
        <p className="notice error paypal-problem" role="alert" data-testid={`paypal-problem-${def.id}`}>
          {problem}
        </p>
      )}
      <button type="button" className="btn btn-small btn-ghost" disabled={working} onClick={onCancel} data-testid={`paypal-cancel-${def.id}`}>
        Cancel
      </button>
    </div>
  );
}
