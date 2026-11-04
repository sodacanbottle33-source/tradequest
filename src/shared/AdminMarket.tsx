// Owner tools for the market: the price-impact dial, an announcement and a pause-all switch (AdminBroadcast), moving a company's
// price (rug pull, crash, pump), and stopping or resuming trading in one company.
// Nothing here changes a price by itself: the server turns the request into a special news story and the market plays it out.
import { useMemo, useState } from 'react';
import { ApiError, api } from './api';
import { AdminBroadcast } from './AdminBroadcast';
import { newRequestId, parsePercent } from './adminUtil';
import { formatBps, formatCents } from './format';
import { sharedStore, useShared } from './store';
import type { AdminSpeed, AdminState, AdminStyle } from './types';

const PRESETS: { style: AdminStyle; label: string; percent: string; hint: string }[] = [
  { style: 'rug', label: 'Rug pull', percent: '-90', hint: 'Founders vanish, the price collapses.' },
  { style: 'crash', label: 'Crash', percent: '-30', hint: 'A sudden sell-off.' },
  { style: 'pump', label: 'Pump', percent: '100', hint: 'Buyers pile in.' },
  { style: 'custom', label: 'Custom', percent: '-50', hint: 'Write your own headline.' },
];
const PACES: { id: AdminSpeed; label: string; note: string }[] = [
  { id: 'instant', label: 'Instant', note: 'about 6 seconds' },
  { id: 'fast', label: 'Fast', note: 'about 5 minutes' },
  { id: 'slow', label: 'Slow', note: 'about 1 hour' },
];

type Message = { kind: 'ok' | 'error'; text: string } | null;

function problem(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error);
}

export function AdminMarket({ state, reload }: { state: AdminState | null; reload: () => Promise<void> }) {
  const { companies, prices } = useShared();
  const [query, setQuery] = useState('');
  const [ticker, setTicker] = useState('');
  const [style, setStyle] = useState<AdminStyle>('rug');
  const [percentText, setPercentText] = useState('-90');
  const [speed, setSpeed] = useState<AdminSpeed>('instant');
  const [headline, setHeadline] = useState('');
  const [body, setBody] = useState('');
  const [breaking, setBreaking] = useState(true);
  const [review, setReview] = useState<string | null>(null); // the request id, once "Review" was pressed
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [reason, setReason] = useState('');

  const trading = useMemo(() => companies.filter((c) => c.trading), [companies]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return trading.filter((c) => q === '' || c.ticker.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)).slice(0, 300);
  }, [trading, query]);
  const company = trading.find((c) => c.ticker === ticker) ?? null;
  const price = company ? (prices[company.id] ?? 0) || company.price : 0;
  const isHalted = state?.halts.some((h) => h.ticker === ticker) ?? false;

  const percent = parsePercent(percentText);
  const percentError =
    percent === null
      ? 'Type a percentage, for example -90 or 100.'
      : percent < -99 || percent > 900
        ? 'The move must be from -99% to +900%.'
        : Math.abs(percent) < 1
          ? 'The move must be at least 1% either way.'
          : (style === 'rug' || style === 'crash') && percent > 0
            ? `A ${style === 'rug' ? 'rug pull' : 'crash'} must be a drop (a negative number).`
            : style === 'pump' && percent < 0
              ? 'A pump must be a rise (a positive number).'
              : style === 'custom' && headline.trim() === ''
                ? 'Write a headline for your custom event.'
                : null;
  // (A stock or an older coin is never below $1.00 and is counted in whole cents; a launched coin costs a tiny fraction of a cent.)
  const target = percent !== null && price > 0 ? (price < 100 ? price * (1 + percent / 100) : Math.max(100, Math.round(price * (1 + percent / 100)))) : 0;
  const speedNote = PACES.find((s) => s.id === speed)?.note ?? '';
  const canReview = company !== null && percentError === null && !busy;

  const choosePreset = (p: (typeof PRESETS)[number]) => {
    setStyle(p.style);
    setPercentText(p.percent);
    setReview(null);
    setMessage(null);
  };

  const run = async (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ kind: 'ok', text: await fn() });
      await reload();
      await sharedStore.refreshCompanies();
      await sharedStore.refreshNews();
    } catch (error) {
      setMessage({ kind: 'error', text: problem(error) });
    } finally {
      setBusy(false);
    }
  };

  const confirm = () =>
    run(async () => {
      if (!company || percent === null || review === null) throw new Error('Pick a company and a valid move first.');
      const r = await api.adminShock({
        requestId: review,
        ticker: company.ticker,
        percent,
        style,
        speed,
        headline: style === 'custom' ? headline.trim() : undefined,
        body: style === 'custom' && body.trim() !== '' ? body.trim() : undefined,
        breaking,
      });
      setReview(null);
      return `${style === 'rug' ? 'Rug pull' : style === 'crash' ? 'Crash' : style === 'pump' ? 'Pump' : 'Event'} on ${r.ticker} sent: ${formatBps(Math.round((percent ?? 0) * 100))}. The story appears in a few seconds and the price follows.`;
    });

  const setHalted = (halted: boolean, tick = ticker) =>
    run(async () => {
      if (tick === '') throw new Error('Pick a company first.');
      await api.adminHalt({ requestId: newRequestId(), ticker: tick, halted, reason: halted ? reason.trim() : undefined });
      return halted ? `Trading in ${tick} is halted.` : `Trading in ${tick} is open again.`;
    });

  return (
    <div className="admin-grid">
      <section className="card admin-span" aria-label="Price impact of player trades">
        <h2>
          Price impact of player trades <span className="h2-note">buying pushes a price up, selling pushes it down</span>
        </h2>
        <p className="hint" data-testid="admin-flow-note">
          Always on, at the size of the real market, for every company. The push depends on the size of the order compared with the company's order book, so thin and small companies move most and a giant hardly moves at all. It applies to Career trades; 1v1 matches never move prices. Each trader pays a share of the push on top of the book price. There is nothing to set.
        </p>
      </section>

      <AdminBroadcast state={state} reload={reload} />

      <section className="card" aria-label="Move a price">
        <h2>
          Move a price <span className="h2-note">rug pull · crash · pump</span>
        </h2>
        <fieldset className="admin-fields" disabled={review !== null || busy}>
          <label className="qty-label" htmlFor="adm-find">
            Company
          </label>
          <input id="adm-find" className="qty-input" type="search" placeholder="Search by ticker or name" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="admin-company-search" />
          <select
            className="qty-input"
            size={Math.min(6, Math.max(2, matches.length))}
            value={ticker}
            onChange={(e) => {
              setTicker(e.target.value);
              setMessage(null);
            }}
            aria-label="Company"
            data-testid="admin-company"
          >
            {matches.map((c) => (
              <option key={c.ticker} value={c.ticker}>
                {c.ticker} · {c.name} · {formatCents((prices[c.id] ?? 0) || c.price)}
              </option>
            ))}
          </select>

          <span className="qty-label">What happens</span>
          <div className="seg-group" role="group" aria-label="Kind of move">
            {PRESETS.map((p) => (
              <button key={p.style} type="button" className={style === p.style ? 'seg active' : 'seg'} onClick={() => choosePreset(p)} title={p.hint} data-testid={`admin-style-${p.style}`}>
                {p.label}
              </button>
            ))}
          </div>

          <label className="qty-label" htmlFor="adm-percent">
            Move in percent (about)
          </label>
          <input id="adm-percent" className="qty-input" type="text" inputMode="decimal" value={percentText} onChange={(e) => setPercentText(e.target.value)} data-testid="admin-percent" />

          <span className="qty-label">How fast</span>
          <div className="seg-group" role="group" aria-label="Speed">
            {PACES.map((s) => (
              <button key={s.id} type="button" className={speed === s.id ? 'seg active' : 'seg'} onClick={() => setSpeed(s.id)} title={s.note} data-testid={`admin-speed-${s.id}`}>
                {s.label}
              </button>
            ))}
          </div>

          {style === 'custom' && (
            <>
              <label className="qty-label" htmlFor="adm-headline">
                Headline (shown to every player)
              </label>
              <input id="adm-headline" className="qty-input" type="text" maxLength={120} value={headline} onChange={(e) => setHeadline(e.target.value)} data-testid="admin-headline" />
              <label className="qty-label" htmlFor="adm-body">
                Text (optional)
              </label>
              <textarea id="adm-body" className="qty-input admin-text" maxLength={400} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
            </>
          )}
          <label className="check">
            <input type="checkbox" checked={breaking} onChange={(e) => setBreaking(e.target.checked)} /> Show as breaking news
          </label>
        </fieldset>

        {company && percentError === null && percent !== null && (
          <p className="hint" data-testid="admin-preview">
            {company.ticker} is {formatCents(price)} now. A move of {formatBps(Math.round(percent * 100))} aims for about {formatCents(target)} ({speedNote}). The real result can differ a little, and no price goes below $1.00.
          </p>
        )}
        {percentError && company && <p className="notice warn">{percentError}</p>}
        {!company && <p className="hint">Pick a company from the list.</p>}

        {review === null ? (
          <button type="button" className={`btn btn-wide ${percent !== null && percent > 0 ? 'btn-buy' : 'btn-sell'}`} disabled={!canReview} onClick={() => setReview(newRequestId())} data-testid="admin-review">
            Review
          </button>
        ) : (
          <div className="admin-confirm" role="alert" data-testid="admin-confirm-box">
            <p>
              <strong>
                {company?.ticker} {percent !== null ? formatBps(Math.round(percent * 100)) : ''}
              </strong>{' '}
              for every player, {speedNote}. This cannot be undone; you could only send a move the other way.
            </p>
            <div className="row-buttons">
              <button type="button" className={`btn ${percent !== null && percent > 0 ? 'btn-buy' : 'btn-sell'}`} disabled={busy} onClick={() => void confirm()} data-testid="admin-confirm">
                Confirm and send
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setReview(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {message && (
          <p className={message.kind === 'ok' ? 'notice success' : 'notice error'} role="status" data-testid="admin-message">
            {message.text}
          </p>
        )}
      </section>

      <section className="card" aria-label="Trading halts">
        <h2>
          Stop trading <span className="h2-note">the price keeps moving</span>
        </h2>
        <p className="hint">A halted company cannot be bought or sold by anyone, in Career or in 1v1. {ticker ? `Selected: ${ticker}.` : 'Pick a company in the box on the left.'}</p>
        <label className="qty-label" htmlFor="adm-reason">
          Reason (shown to players who try to trade)
        </label>
        <input id="adm-reason" className="qty-input" type="text" maxLength={120} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: under investigation" data-testid="admin-halt-reason" />
        <div className="row-buttons">
          <button type="button" className="btn" disabled={busy || ticker === '' || isHalted} onClick={() => void setHalted(true)} data-testid="admin-halt">
            Halt {ticker || 'company'}
          </button>
          <button type="button" className="btn" disabled={busy || ticker === '' || !isHalted} onClick={() => void setHalted(false)} data-testid="admin-resume">
            Resume {ticker || 'company'}
          </button>
        </div>

        <h3 className="admin-h3">Halted now</h3>
        <p className="hint">Companies the market paused by itself after a 10% move in 5 minutes show up here too, marked Auto; they reopen on their own after 5 minutes, or you can resume them now. Your own price moves never trigger a pause.</p>
        {state && state.halts.length === 0 && <p className="hint">No company is halted.</p>}
        {state && state.halts.length > 0 && (
          <ul className="admin-list" data-testid="admin-halts">
            {state.halts.map((h) => (
              <li key={h.ticker}>
                <span>
                  <strong className="ticker">{h.ticker}</strong> <span className="muted">{h.name}</span>
                  {h.auto && <span className="badge-halted">Auto</span>}
                  {h.reason && <span className="muted"> · {h.reason}</span>}
                </span>
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => void setHalted(false, h.ticker)}>
                  Resume
                </button>
              </li>
            ))}
          </ul>
        )}

        <h3 className="admin-h3">Recent special events</h3>
        {state && state.events.length === 0 && <p className="hint">Nothing sent yet.</p>}
        {state && state.events.length > 0 && (
          <div className="table-wrap">
            <table className="trades" data-testid="admin-events">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Headline</th>
                  <th className="num">Result</th>
                </tr>
              </thead>
              <tbody>
                {state.events.map((e) => {
                  const done = e.priceAtPublish !== null && e.priceAtEnd !== null && e.priceAtPublish > 0;
                  const bps = done ? Math.round((((e.priceAtEnd as number) - (e.priceAtPublish as number)) / (e.priceAtPublish as number)) * 10_000) : 0;
                  const running = state.tick < e.endTick;
                  return (
                    <tr key={e.id}>
                      <td className="ticker">{e.ticker ?? '—'}</td>
                      <td>{e.headline}</td>
                      <td className={`num mono ${bps < 0 ? 'neg' : bps > 0 ? 'pos' : ''}`}>{done ? formatBps(bps) : running ? 'running…' : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
