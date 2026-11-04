// The owner's PayPal ON/OFF button (docs/world.md §43), on the Market tab of the admin panel. PayPal test payments start OFF: players see nothing about PayPal until the owner presses
// the button. The button only works when the server has the two PayPal settings (TQ_PAYPAL_CLIENT_ID and TQ_PAYPAL_SECRET). The server keeps the switch and decides; this card only
// asks and shows what the server says. Pressing it is written once to the admin log.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { newRequestId } from './adminUtil';
import { problemText } from './playersUtil';
import type { AdminPaypalView } from './types';

type Message = { kind: 'ok' | 'error'; text: string } | null;

export function AdminPaypal() {
  const [view, setView] = useState<AdminPaypalView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.adminPaypal());
    } catch (e) {
      setMessage({ kind: 'error', text: problemText(e) });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const press = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const out = await api.adminPaypalSwitch({ requestId: newRequestId(), on });
      setView(out);
      setMessage({ kind: 'ok', text: on ? 'PayPal test payments are switched on. Players now see the PayPal button on Shop looks.' : 'PayPal test payments are switched off. Players see no PayPal button.' });
    } catch (e) {
      setMessage({ kind: 'error', text: problemText(e) });
    } finally {
      setBusy(false);
    }
  };

  const orders = view?.orders ?? {};
  const finished = orders.granted ?? 0;
  const stuck = orders.paid_not_granted ?? 0;
  const open = (orders.created ?? 0) + (orders.granting ?? 0);

  return (
    <section className="card" aria-label="PayPal test payments" data-testid="admin-paypal">
      <h2>
        PayPal test payments <span className="h2-note">{view === null ? '' : view.showing ? 'ON' : 'off'}</span>
      </h2>
      {view === null && !message && <p className="hint">Loading…</p>}
      {view !== null && (
        <>
          <p className="hint" data-testid="admin-paypal-state">
            {!view.configured
              ? 'PayPal has no codes yet, so it cannot be switched on. Add TQ_PAYPAL_CLIENT_ID and TQ_PAYPAL_SECRET (from developer.paypal.com, Sandbox) in the server settings, then come back here.'
              : view.on
                ? 'PayPal is ON. Players see a yellow "PayPal $ TEST" button next to Buy on Shop looks. It is PayPal\'s free test mode: no real money is ever taken. A paid look is given at once and Career cash does not change.'
                : 'PayPal is OFF. Players see nothing about PayPal. The codes are set, so you can switch it on whenever you like (for example for your demo video).'}
          </p>
          <p className="hint" data-testid="admin-paypal-orders">
            Test orders: {finished} finished{open > 0 ? `, ${open} still open` : ''}
            {stuck > 0 ? `, ${stuck} paid for a look the player already had (see the server log)` : ''}.
          </p>
          <button
            type="button"
            className={view.on ? 'btn btn-small btn-sell' : 'btn btn-small'}
            disabled={busy || (!view.on && !view.configured)}
            onClick={() => void press(!view.on)}
            data-testid="admin-paypal-toggle"
          >
            {view.on ? 'Switch PayPal off' : 'Switch PayPal on'}
          </button>
        </>
      )}
      {message && (
        <p className={message.kind === 'ok' ? 'notice success' : 'notice error'} role="status" data-testid="admin-paypal-message">
          {message.text}
        </p>
      )}
    </section>
  );
}
