// The billboard strip (docs/world.md §30): three places at the top of the Market and Memecoins tabs. A place shows a company a player launched and paid to show: its picture,
// name, live price and today's change, who showed it and how long is left; a click opens the company. A free place says what it costs and leads to the booking card in the
// Launch tab. The strip only SHOWS companies: it places no order and changes no price. What each place shows comes from the server (src/shared/billboardStore.ts).
import { useEffect } from 'react';
import { billboardStore, useBillboard } from './billboardStore';
import { BILLBOARD_CENTS_PER_HOUR, leftText } from './billboardCatalog';
import { CompanyLogo } from './CompanyLogo';
import { formatBps, formatCents, toneOf } from './format';
import { PlayerName } from './PlayerName';
import { FlashPrice } from './PriceFx';
import { useShared } from './store';
import type { BillboardRental } from './types';

function Taken({ rental, mine, onOpen, nowMs }: { rental: BillboardRental; mine: boolean; onOpen: (ticker: string) => void; nowMs: number }) {
  const { companies, prices } = useShared();
  const row = companies.find((c) => c.ticker === rental.ticker);
  const price = row ? (prices[row.id] ?? 0) : 0;
  const live = !!row && row.trading && price > 0;
  const changeBps = live && row && row.open24h > 0 ? Math.round(((price - row.open24h) / row.open24h) * 10_000) : (row?.changeBps ?? 0);
  return (
    <>
      <button type="button" className="bb-open" onClick={() => onOpen(rental.ticker)} aria-label={`Open ${rental.name} (${rental.ticker})`} data-testid={`bb-open-${rental.ticker}`}>
        <CompanyLogo ticker={rental.ticker} size={40} />
        <span className="bb-main">
          <strong className="bb-ticker">{rental.ticker}</strong>
          <span className="bb-name muted">{rental.name}</span>
        </span>
        <span className="bb-quote mono">
          {live ? <FlashPrice cents={price} resetKey={rental.ticker} /> : <span className="muted">—</span>}
          {live && <span className={`bb-change ${toneOf(changeBps)}`}>{formatBps(changeBps)}</span>}
        </span>
      </button>
      <span className="bb-foot">
        <span className="bb-by">
          {mine ? <span className="bb-yours">Yours</span> : <PlayerName username={rental.byUsername} name={rental.byName} className="bb-byname" />}
        </span>
        <span className="muted bb-left" data-testid={`bb-left-${rental.ticker}`}>
          {leftText(rental.endsMs, nowMs)}
        </span>
      </span>
    </>
  );
}

export function BillboardStrip({ onOpen, onBook }: { onOpen: (ticker: string) => void; onBook: () => void }) {
  const { view, slots, nowMs } = useBillboard();
  const { user } = useShared();
  // Make sure the list is there even when the page connected before this strip was on screen (cheap: one small answer).
  useEffect(() => {
    if (view === null) void billboardStore.load();
  }, [view]);
  if (view === null) return null;
  return (
    <section className="card billboard" aria-label="Billboard" data-testid="billboard">
      <div className="billboard-head">
        <h3>
          Billboard <span className="h2-note">companies their players show off</span>
        </h3>
      </div>
      <ul className="bb-slots">
        {slots.map((s) => {
          const mine = !!s.rental && !!user && s.rental.byUsername === user.username;
          return (
            <li className={s.rental ? `bb-slot bb-taken${mine ? ' bb-mine' : ''}` : 'bb-slot bb-free'} key={s.slot} data-testid={`bb-slot-${s.slot}`} data-taken={s.rental ? 'yes' : 'no'}>
              {s.rental ? (
                <Taken rental={s.rental} mine={mine} onOpen={onOpen} nowMs={nowMs} />
              ) : (
                <>
                  <span className="bb-empty-title">Place {s.slot} is free</span>
                  <span className="muted bb-empty-price">{formatCents(view.centsPerHour || BILLBOARD_CENTS_PER_HOUR).replace(/\.00$/, '')} an hour</span>
                  <button type="button" className="btn btn-small" onClick={onBook} data-testid={`bb-book-${s.slot}`}>
                    Show your company here
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
