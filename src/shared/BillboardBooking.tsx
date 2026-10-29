// The booking card of the billboard (docs/world.md §30), in the Launch tab: pick one of the companies YOU launched, a place and for how long, then "Book" and "Confirm"
// (the money is gone for good, so it always asks twice). The server decides everything: who may book what, whether a place is free, the price and the longest time.
// This card only asks and shows the answer.
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { billboardStore, useBillboard } from './billboardStore';
import { BILLBOARD_CENTS_PER_HOUR, BILLBOARD_MAX_HOURS_AHEAD, billboardPriceCents, hoursText, leftText } from './billboardCatalog';
import { formatCents } from './format';
import { problemText } from './playersUtil';
import { sharedStore, useShared } from './store';

type Note = { kind: 'ok' | 'error'; text: string } | null;

export function BillboardBooking({ onOpen, refreshKey }: { onOpen: (ticker: string) => void; refreshKey: number }) {
  const { user } = useShared();
  const { view, slots, nowMs } = useBillboard();
  const [ticker, setTicker] = useState('');
  const [slot, setSlot] = useState(0);
  const [hours, setHours] = useState(1);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  // A company that was just launched is in the answer only after the page asks again.
  useEffect(() => {
    void billboardStore.load();
  }, [refreshKey, user?.id]);

  const launched = view?.mine?.launched ?? [];
  const hourChoices = view?.hours ?? [1, 3, 6, 12, 24];
  const perHour = view?.centsPerHour ?? BILLBOARD_CENTS_PER_HOUR;
  const myPlace = useMemo(() => slots.find((s) => s.rental && user && s.rental.byUsername === user.username) ?? null, [slots, user]);
  const chosen = ticker !== '' && launched.some((c) => c.ticker === ticker) ? ticker : (myPlace?.rental?.ticker ?? launched[0]?.ticker ?? '');
  // He has a place already: that is the only one he can ask for (to add hours); otherwise the first free one is suggested.
  const wantedSlot = myPlace ? myPlace.slot : slot !== 0 && slots.some((s) => s.slot === slot && !s.rental) ? slot : (slots.find((s) => !s.rental)?.slot ?? 0);
  const price = perHour * hours;
  const cash = view?.mine?.cashCents ?? 0;
  const room = myPlace?.rental ? BILLBOARD_MAX_HOURS_AHEAD * 3_600_000 - (myPlace.rental.endsMs - nowMs) : BILLBOARD_MAX_HOURS_AHEAD * 3_600_000;

  if (!user) return null;

  const book = async () => {
    if (busy || wantedSlot === 0 || chosen === '') return;
    setBusy(true);
    setNote(null);
    try {
      const out = await api.bookBillboard(wantedSlot, chosen, hours);
      billboardStore.setView(out);
      setNote({ kind: 'ok', text: `${out.booked.extended ? 'Added' : 'Booked'} ${hoursText(out.booked.hours)} for ${out.booked.ticker} on place ${out.booked.slot}. It cost ${formatCents(out.booked.priceCents)}.` });
      void sharedStore.refreshAccount();
    } catch (e) {
      setNote({ kind: 'error', text: problemText(e) });
      void billboardStore.load();
    } finally {
      setAsking(false);
      setBusy(false);
    }
  };

  return (
    <section className="card billboard-booking" aria-label="Billboard" data-testid="billboard-booking">
      <h2>
        Billboard <span className="h2-note">show your company to everybody</span>
      </h2>
      <p className="hint">
        Three places at the top of the Market and Memecoins tabs show a company for the hours you pay for: {formatCents(perHour).replace(/\.00$/, '')} an hour for any place, first come, first served. You can only show a company <strong>you launched</strong>, and it only
        shows it (nobody gets any help in trading from it). The money comes out of your Career cash and is gone for good, so your net worth and your place on the leaderboard go down by the price. A place can run for at most {hoursText(BILLBOARD_MAX_HOURS_AHEAD)} from now.
      </p>
      {launched.length === 0 ? (
        <p className="hint" data-testid="bb-nolaunch">
          You have no living company of your own to show yet. Launch a coin or a stock below, then come back.
        </p>
      ) : (
        <div className="bb-form">
          <label className="bb-field">
            <span>Company</span>
            <select className="qty-input" value={chosen} disabled={busy || myPlace !== null} onChange={(e) => { setTicker(e.target.value); setAsking(false); }} aria-label="Company to show" data-testid="bb-company">
              {launched.map((c) => (
                <option key={c.ticker} value={c.ticker}>
                  {c.ticker} · {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="bb-field" role="group" aria-label="Place">
            <span>Place</span>
            <div className="seg-group">
              {slots.map((s) => {
                const yours = myPlace?.slot === s.slot;
                const free = !s.rental;
                const ok = myPlace ? yours : free;
                return (
                  <button
                    key={s.slot}
                    type="button"
                    className={s.slot === wantedSlot ? 'seg active' : 'seg'}
                    aria-pressed={s.slot === wantedSlot}
                    disabled={!ok || busy}
                    onClick={() => { setSlot(s.slot); setAsking(false); }}
                    data-testid={`bb-pick-${s.slot}`}
                    title={free ? 'Free' : yours ? 'Yours' : `Taken: ${leftText(s.rental?.endsMs ?? 0, nowMs).toLowerCase()}`}
                  >
                    {s.slot} · {free ? 'free' : yours ? 'yours' : 'taken'}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="bb-field" role="group" aria-label="Hours">
            <span>How long</span>
            <div className="seg-group">
              {hourChoices.map((h) => (
                <button key={h} type="button" className={h === hours ? 'seg active' : 'seg'} aria-pressed={h === hours} disabled={busy || h * 3_600_000 > room} onClick={() => { setHours(h); setAsking(false); }} data-testid={`bb-hours-${h}`}>
                  {h} h
                </button>
              ))}
            </div>
          </div>
          {myPlace?.rental && (
            <p className="hint" data-testid="bb-yours">
              You have place {myPlace.slot} for {myPlace.rental.ticker}. {leftText(myPlace.rental.endsMs, nowMs)}. Pick the hours to add.{' '}
              <button type="button" className="link-btn" onClick={() => onOpen(myPlace.rental?.ticker ?? '')}>
                Open {myPlace.rental.ticker}
              </button>
            </p>
          )}
          {wantedSlot === 0 && !myPlace && (
            <p className="hint" data-testid="bb-full">
              All three places are taken right now. Come back when one is free.
            </p>
          )}
          <div className="bb-actions">
            {asking ? (
              <>
                <button type="button" className="btn btn-buy" disabled={busy} onClick={() => void book()} data-testid="bb-confirm">
                  Confirm {formatCents(price).replace(/\.00$/, '')}
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setAsking(false)} data-testid="bb-cancel">
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="btn" disabled={busy || wantedSlot === 0 || chosen === '' || cash < price || price > billboardPriceCents(BILLBOARD_MAX_HOURS_AHEAD)} onClick={() => setAsking(true)} data-testid="bb-book">
                {myPlace ? 'Add' : 'Book'} {hoursText(hours)} · {formatCents(price).replace(/\.00$/, '')}
              </button>
            )}
            <span className="muted bb-cash">
              You have <span className="mono" data-testid="bb-cash">{formatCents(cash)}</span>
            </span>
          </div>
        </div>
      )}
      {note && (
        <p className={note.kind === 'ok' ? 'notice success' : 'notice error'} role={note.kind === 'ok' ? 'status' : 'alert'} data-testid="bb-note">
          {note.text}
        </p>
      )}
    </section>
  );
}
