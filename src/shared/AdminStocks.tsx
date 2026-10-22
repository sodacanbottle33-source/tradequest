// The "Create stock" tab: the owner makes a company of his own. The server checks every field, saves the company, adds it to the
// running market and gives it news; this screen only collects the choices, shows what the server says and never decides a price.
import { useState } from 'react';
import { ApiError, api } from './api';
import { dollarsToCents, newRequestId } from './adminUtil';
import { formatCents } from './format';
import type { AdminState, OwnStock } from './types';

type Message = { kind: 'ok' | 'error'; text: string } | null;

function problem(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error);
}

function statusOf(s: OwnStock): string {
  if (!s.loaded) return 'Saved. Starts after the next server start';
  if (s.halted) return 'Trading stopped';
  if (!s.trading) return `Lists in ${s.listsInTicks} s`;
  return 'Trading';
}

export function AdminStocks({ state, reload }: { state: AdminState | null; reload: () => Promise<void> }) {
  const form = state?.stockForm ?? null;
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [sector, setSector] = useState('tech');
  const [tier, setTier] = useState('small');
  const [personality, setPersonality] = useState('steady');
  const [price, setPrice] = useState('');
  const [industry, setIndustry] = useState('');
  const [description, setDescription] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null); // the request id, once "Create stock…" was pressed
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const cents = dollarsToCents(price);
  const nameOk = name.trim().length >= 3 && name.trim().length <= (form?.nameMax ?? 40);
  const tickerOk = /^[A-Z]{3,5}$/.test(ticker);
  const priceOk = form !== null && cents !== null && cents >= form.minPriceCents && cents <= form.maxPriceCents;
  const ready = form !== null && nameOk && tickerOk && priceOk;
  const sectorName = form?.sectors.find((s) => s.id === sector)?.name ?? sector;
  const tierInfo = form?.tiers.find((t) => t.id === tier);
  const personalityInfo = form?.personalities.find((p) => p.id === personality);

  const hint = (): string | null => {
    if (form === null) return null;
    if (name.trim() !== '' && !nameOk) return `The name needs 3 to ${form.nameMax} characters.`;
    if (ticker !== '' && !tickerOk) return 'The ticker is 3 to 5 letters, for example ZRLX.';
    if (price.trim() !== '' && !priceOk) return `The starting price is from ${formatCents(form.minPriceCents)} to ${formatCents(form.maxPriceCents)}.`;
    return null;
  };

  const create = async () => {
    if (busy || confirm === null || cents === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.adminStock({
        requestId: confirm,
        name: name.trim(),
        ticker,
        sector,
        tier,
        personality,
        priceCents: cents,
        industry: industry.trim() || undefined,
        description: description.trim() || undefined,
      });
      setConfirm(null);
      if (res.loaded === false) {
        setMessage({ kind: 'error', text: `${res.ticker} was saved, but it could not be added to the running market. It will start trading after the next server start.` });
      } else {
        setMessage({ kind: 'ok', text: `${res.ticker} is created. It starts trading in about ${res.startsInSeconds ?? form?.listsInSeconds ?? 30} seconds and shows up in the market list now.` });
      }
      setName('');
      setTicker('');
      setPrice('');
      setIndustry('');
      setDescription('');
      await reload();
    } catch (error) {
      setConfirm(null);
      setMessage({ kind: 'error', text: problem(error) });
    } finally {
      setBusy(false);
    }
  };

  const stocks = state?.stocks ?? [];
  const waiting = stocks.some((s) => !s.loaded);

  return (
    <>
      <section className="card" aria-label="Create a stock">
        <h2>
          Create a stock <span className="h2-note">a company of your own</span>
        </h2>
        <p className="hint">
          It becomes a real company: players can buy and sell it, it has charts, its own news, and it is moved by market and sector news like all the others. You can later push its price, stop its trading or give shares of it. A stock cannot be deleted.
        </p>
        {form === null && <p className="hint">Loading…</p>}
        {form !== null && (
          <fieldset className="admin-fields" disabled={busy || confirm !== null}>
            <label className="qty-label" htmlFor="adm-stock-name">
              Company name
            </label>
            <input id="adm-stock-name" className="qty-input" type="text" maxLength={form.nameMax} placeholder="For example: Zorlex Robotics" value={name} onChange={(e) => setName(e.target.value)} data-testid="admin-stock-name" />

            <label className="qty-label" htmlFor="adm-stock-ticker">
              Ticker (3 to 5 letters)
            </label>
            <input
              id="adm-stock-ticker"
              className="qty-input"
              type="text"
              maxLength={5}
              autoCapitalize="characters"
              placeholder="ZRLX"
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
              data-testid="admin-stock-ticker"
            />

            <label className="qty-label" htmlFor="adm-stock-sector">
              Sector
            </label>
            <select id="adm-stock-sector" className="qty-input" value={sector} onChange={(e) => setSector(e.target.value)} data-testid="admin-stock-sector">
              {form.sectors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>

            <label className="qty-label" htmlFor="adm-stock-tier">
              Size
            </label>
            <select id="adm-stock-tier" className="qty-input" value={tier} onChange={(e) => setTier(e.target.value)} data-testid="admin-stock-tier">
              {form.tiers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            {tierInfo && <p className="hint">{tierInfo.note}</p>}

            <label className="qty-label" htmlFor="adm-stock-personality">
              Personality
            </label>
            <select id="adm-stock-personality" className="qty-input" value={personality} onChange={(e) => setPersonality(e.target.value)} data-testid="admin-stock-personality">
              {form.personalities.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {personalityInfo && <p className="hint">{personalityInfo.note}</p>}

            <label className="qty-label" htmlFor="adm-stock-price">
              Starting price ($)
            </label>
            <input id="adm-stock-price" className="qty-input" type="text" inputMode="decimal" placeholder="12.50" value={price} onChange={(e) => setPrice(e.target.value)} data-testid="admin-stock-price" />

            <label className="qty-label" htmlFor="adm-stock-industry">
              Industry (optional)
            </label>
            <input id="adm-stock-industry" className="qty-input" type="text" maxLength={50} placeholder="Leave empty to use the sector's usual one" value={industry} onChange={(e) => setIndustry(e.target.value)} data-testid="admin-stock-industry" />

            <label className="qty-label" htmlFor="adm-stock-description">
              About the company (optional, {description.length}/{form.descriptionMax})
            </label>
            <textarea
              id="adm-stock-description"
              className="qty-input"
              rows={3}
              maxLength={form.descriptionMax}
              placeholder="Leave empty for an automatic description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="admin-stock-description"
            />

            {hint() && (
              <p className="hint" role="status" data-testid="admin-stock-hint">
                {hint()}
              </p>
            )}
            <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setConfirm(newRequestId())} data-testid="admin-stock-start">
              Create stock…
            </button>
          </fieldset>
        )}

        {confirm !== null && cents !== null && (
          <div className="admin-confirm" data-testid="admin-stock-confirm-box">
            <p>
              Create <strong>{ticker}</strong> — {name.trim()} ({tierInfo?.label.toLowerCase()}, {sectorName.toLowerCase()}, {personalityInfo?.label.toLowerCase()}) at <strong>{formatCents(cents)}</strong> a share? It starts trading in about{' '}
              {form?.listsInSeconds ?? 30} seconds. You cannot delete it afterwards, but you can stop its trading.
            </p>
            <div className="row-buttons">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create()} data-testid="admin-stock-confirm">
                Yes, create it
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(null)} data-testid="admin-stock-cancel">
                Cancel
              </button>
            </div>
          </div>
        )}
        {message && (
          <p className={message.kind === 'ok' ? 'notice success' : 'notice error'} role="status" data-testid="admin-stock-message">
            {message.text}
          </p>
        )}
      </section>

      <section className="card" aria-label="Your stocks">
        <h2>
          Your stocks <span className="h2-note">{stocks.length} made</span>
        </h2>
        {waiting && (
          <p className="notice warn" role="status" data-testid="admin-stock-waiting">
            A stock is saved but not running yet. Stop the server (Ctrl+C) and start it again with <code>npm run server</code>; it begins trading a few minutes after that.
          </p>
        )}
        {stocks.length === 0 && <p className="hint">You have not made a stock yet.</p>}
        {stocks.length > 0 && (
          <div className="table-wrap">
            <table className="trades" data-testid="admin-stock-list">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Name</th>
                  <th>Kind</th>
                  <th className="num">Started at</th>
                  <th className="num">Now</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {stocks.map((s) => (
                  <tr key={s.id} data-testid={`admin-stock-row-${s.ticker}`}>
                    <td>
                      <strong>{s.ticker}</strong>
                    </td>
                    <td>{s.name}</td>
                    <td>
                      {s.tier} · {s.personality}
                    </td>
                    <td className="num">{formatCents(s.startPriceCents)}</td>
                    <td className="num">{s.trading ? formatCents(s.priceCents) : '–'}</td>
                    <td>{statusOf(s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
