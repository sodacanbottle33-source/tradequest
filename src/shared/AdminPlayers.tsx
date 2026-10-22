// Owner tools for players: see everybody's Career cash, net worth and coins; give or take cash, coins or shares; ban and unban;
// and reset a Career account. Every action is a request to the server, which does (or refuses) it and writes it to the log.
import { useMemo, useState } from 'react';
import { ApiError, api } from './api';
import { dollarsToCents, newRequestId, whenText } from './adminUtil';
import { formatCents } from './format';
import { useShared } from './store';
import type { AdminPlayer, AdminState } from './types';

type Kind = 'cash' | 'coins' | 'shares';
type Confirm = { type: 'ban' | 'reset'; id: string } | null;
const QUICK = ['100', '1,000', '10,000', '100,000', '1,000,000'];
const QUICK_SHARES = ['10', '100', '1,000', '10,000'];
const BAN_LENGTHS: { label: string; hours: number | null }[] = [
  { label: '1 hour', hours: 1 },
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 168 },
  { label: 'Until I lift it', hours: null },
];

function problem(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error);
}

function banText(p: AdminPlayer): string {
  if (!p.banned) return '';
  return `${p.banned.untilMs === null ? 'Banned until you lift it' : `Banned until ${whenText(p.banned.untilMs)}`}${p.banned.reason ? `: ${p.banned.reason}` : '.'}`;
}

export function AdminPlayers({ state, query, onQuery, reload }: { state: AdminState | null; query: string; onQuery: (q: string) => void; reload: () => Promise<void> }) {
  const { companies } = useShared();
  const [selected, setSelected] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('cash');
  const [amountText, setAmountText] = useState('');
  const [ticker, setTicker] = useState('');
  const [qtyText, setQtyText] = useState('');
  const [note, setNote] = useState('');
  const [banReason, setBanReason] = useState('');
  const [banHours, setBanHours] = useState<number | null>(24);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const players = state?.players ?? [];
  const player = players.find((p) => p.username === selected) ?? null;
  const cents = dollarsToCents(amountText);
  const trading = useMemo(() => companies.filter((c) => c.trading), [companies]);
  const company = trading.find((c) => c.ticker === ticker.trim().toUpperCase()) ?? null;
  const qty = /^\d{1,7}$/.test(qtyText.replace(/,/g, '').trim()) ? Number(qtyText.replace(/,/g, '').trim()) : null;
  const validQty = qty !== null && qty > 0 && qty <= 1_000_000;
  const amountOk = kind === 'shares' ? company !== null && validQty : cents !== null;
  const isOwnerRow = player?.role === 'owner';

  const run = async (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ kind: 'ok', text: await fn() });
      await reload();
    } catch (error) {
      setMessage({ kind: 'error', text: problem(error) });
    } finally {
      setBusy(false);
    }
  };

  const choose = (name: string) => {
    setSelected(name);
    setConfirm(null);
    setMessage(null);
  };

  const send = (sign: 1 | -1) =>
    run(async () => {
      if (!player) throw new Error('Pick a player first.');
      const who = player.username;
      const word = sign > 0 ? 'Gave' : 'Took';
      const prep = sign > 0 ? 'to' : 'from';
      if (kind === 'shares') {
        if (!company || !validQty || qty === null) throw new Error('Pick a company and a number of shares.');
        const r = await api.adminShares({ requestId: newRequestId(), username: who, ticker: company.ticker, qty: sign * qty, note: note.trim() || undefined });
        setQtyText('');
        return `${word} ${qty.toLocaleString('en-US')} shares of ${company.ticker} ${prep} ${who}. They now hold ${r.shares.toLocaleString('en-US')}.`;
      }
      if (cents === null) throw new Error('Type a plain amount like 250 or 1,000.50.');
      const body = { requestId: newRequestId(), username: who, amountCents: sign * cents, note: note.trim() || undefined };
      setAmountText('');
      if (kind === 'cash') {
        const r = await api.adminCash(body);
        return `${word} ${formatCents(cents)} ${prep} ${who}. Career cash is now ${formatCents(r.cashCents)}.`;
      }
      const r = await api.adminCoins(body);
      return `${word} ${formatCents(cents)} in coins ${prep} ${who}. Coins are now ${formatCents(r.coinsCents)}.`;
    });

  const ban = () =>
    run(async () => {
      if (!player || confirm?.type !== 'ban') throw new Error('Press "Ban" first.');
      const r = await api.adminBan({ requestId: confirm.id, username: player.username, reason: banReason.trim() || undefined, hours: banHours });
      setConfirm(null);
      setBanReason('');
      return `${player.username} is banned${r.untilMs === null ? ' until you lift it' : ` until ${whenText(r.untilMs)}`}. They were signed out at once.`;
    });

  const unban = () =>
    run(async () => {
      if (!player) throw new Error('Pick a player first.');
      await api.adminUnban({ requestId: newRequestId(), username: player.username });
      return `${player.username} can sign in again.`;
    });

  const reset = () =>
    run(async () => {
      if (!player || confirm?.type !== 'reset') throw new Error('Press "Reset" first.');
      await api.adminReset({ requestId: confirm.id, username: player.username });
      setConfirm(null);
      return `${player.username}'s Career account is back to ${formatCents(100_000)}, with no shares and no history.`;
    });

  return (
    <div className="admin-grid">
      <section className="card" aria-label="Players">
        <h2>
          Players <span className="h2-note">{players.length} shown</span>
        </h2>
        <input className="qty-input" type="search" placeholder="Search by username" value={query} onChange={(e) => onQuery(e.target.value)} aria-label="Search players" data-testid="admin-player-search" />
        <div className="table-wrap">
          <table className="trades admin-players" data-testid="admin-players">
            <thead>
              <tr>
                <th>Player</th>
                <th className="num">Career cash</th>
                <th className="num">Net worth</th>
                <th className="num">Coins</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.id} className={p.username === selected ? 'row-selected' : undefined} data-username={p.username}>
                  <td>
                    <button type="button" className="link-btn" onClick={() => choose(p.username)}>
                      <strong>{p.username}</strong>
                    </button>
                    {p.role === 'owner' && <span className="badge-owner">Owner</span>}
                    {p.banned && (
                      <span className="badge-banned" data-testid={`admin-banned-${p.username}`}>
                        Banned
                      </span>
                    )}
                  </td>
                  <td className="num mono">{formatCents(p.cashCents)}</td>
                  <td className="num mono">{formatCents(p.netWorthCents)}</td>
                  <td className="num mono">{formatCents(p.coinsCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {state && players.length === 0 && <p className="hint">No player matches.</p>}
      </section>

      <div className="admin-col">
        <section className="card" aria-label="Give or take">
          <h2>
            Give or take <span className="h2-note">{player ? player.username : 'pick a player'}</span>
          </h2>
          {!player && <p className="hint">Click a player in the list.</p>}
          {player && (
            <fieldset className="admin-fields" disabled={busy}>
              <div className="seg-group" role="group" aria-label="What to change">
                <button type="button" className={kind === 'cash' ? 'seg active' : 'seg'} onClick={() => setKind('cash')} data-testid="admin-kind-cash">
                  Career cash
                </button>
                <button type="button" className={kind === 'coins' ? 'seg active' : 'seg'} onClick={() => setKind('coins')} data-testid="admin-kind-coins">
                  Coins
                </button>
                <button type="button" className={kind === 'shares' ? 'seg active' : 'seg'} onClick={() => setKind('shares')} data-testid="admin-kind-shares">
                  Shares
                </button>
              </div>
              <p className="hint">
                {kind === 'cash'
                  ? `Career cash now: ${formatCents(player.cashCents)}. A gift counts as a deposit, so it does not show up as trading profit.`
                  : kind === 'coins'
                    ? `Coins now: ${formatCents(player.coinsCents)}. Coins are the virtual currency from 1v1 matches.`
                    : 'Shares go into (or come out of) the Career account at the current price. Like cash, a gift never counts as trading profit.'}
              </p>
              {kind === 'shares' ? (
                <>
                  <label className="qty-label" htmlFor="adm-share-ticker">
                    Company (ticker)
                  </label>
                  <input id="adm-share-ticker" className="qty-input" type="text" list="adm-tickers" autoCapitalize="characters" placeholder="for example QLRX" value={ticker} onChange={(e) => setTicker(e.target.value)} data-testid="admin-share-ticker" />
                  <datalist id="adm-tickers">
                    {trading.map((c) => (
                      <option key={c.ticker} value={c.ticker}>
                        {c.name}
                      </option>
                    ))}
                  </datalist>
                  <label className="qty-label" htmlFor="adm-share-qty">
                    Number of shares
                  </label>
                  <input id="adm-share-qty" className="qty-input" type="text" inputMode="numeric" placeholder="for example 100" value={qtyText} onChange={(e) => setQtyText(e.target.value)} data-testid="admin-share-qty" />
                  <div className="chips" role="group" aria-label="Quick amounts">
                    {QUICK_SHARES.map((q) => (
                      <button key={q} type="button" className="chip" onClick={() => setQtyText(q)}>
                        {q}
                      </button>
                    ))}
                  </div>
                  {ticker.trim() !== '' && company === null && <p className="notice warn">No trading company has that ticker.</p>}
                  {qtyText.trim() !== '' && !validQty && <p className="notice warn">Type a whole number of shares, from 1 to 1,000,000.</p>}
                </>
              ) : (
                <>
                  <label className="qty-label" htmlFor="adm-amount">
                    Amount in dollars
                  </label>
                  <input id="adm-amount" className="qty-input" type="text" inputMode="decimal" placeholder="for example 1,000" value={amountText} onChange={(e) => setAmountText(e.target.value)} data-testid="admin-amount" />
                  <div className="chips" role="group" aria-label="Quick amounts">
                    {QUICK.map((q) => (
                      <button key={q} type="button" className="chip" onClick={() => setAmountText(q)}>
                        ${q}
                      </button>
                    ))}
                  </div>
                  {amountText.trim() !== '' && cents === null && <p className="notice warn">Type a plain amount like 250 or 1,000.50.</p>}
                </>
              )}
              <label className="qty-label" htmlFor="adm-note">
                Note (optional, only in the admin log)
              </label>
              <input id="adm-note" className="qty-input" type="text" maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="row-buttons">
                <button type="button" className="btn btn-buy" disabled={!amountOk} onClick={() => void send(1)} data-testid="admin-give">
                  Give {kind === 'shares' ? (validQty && qty !== null ? `${qty.toLocaleString('en-US')} shares` : '') : cents !== null ? formatCents(cents) : ''}
                </button>
                <button type="button" className="btn btn-sell" disabled={!amountOk} onClick={() => void send(-1)} data-testid="admin-take">
                  Take {kind === 'shares' ? (validQty && qty !== null ? `${qty.toLocaleString('en-US')} shares` : '') : cents !== null ? formatCents(cents) : ''}
                </button>
              </div>
            </fieldset>
          )}
        </section>

        <section className="card" aria-label="Ban or reset">
          <h2>
            Ban or reset <span className="h2-note">{player ? player.username : 'pick a player'}</span>
          </h2>
          {!player && <p className="hint">Click a player in the list.</p>}
          {player && (
            <>
              {player.banned ? (
                <>
                  <p className="notice error" role="status" data-testid="admin-ban-status">
                    {banText(player)}
                  </p>
                  <button type="button" className="btn btn-buy" disabled={busy} onClick={() => void unban()} data-testid="admin-unban">
                    Unban {player.username}
                  </button>
                </>
              ) : isOwnerRow ? (
                <p className="hint">The owner cannot be banned.</p>
              ) : (
                <>
                  <p className="hint">A banned player is signed out at once, cannot sign in, and leaves any 1v1 lobby or match (a live match counts as a forfeit). Their money and holdings stay as they are.</p>
                  <fieldset className="admin-fields" disabled={busy || confirm?.type === 'ban'}>
                    <label className="qty-label" htmlFor="adm-ban-reason">
                      Reason (the player sees it when he tries to sign in)
                    </label>
                    <input id="adm-ban-reason" className="qty-input" type="text" maxLength={120} placeholder="For example: cheating" value={banReason} onChange={(e) => setBanReason(e.target.value)} data-testid="admin-ban-reason" />
                    <div className="seg-group" role="group" aria-label="How long">
                      {BAN_LENGTHS.map((l) => (
                        <button key={l.label} type="button" className={banHours === l.hours ? 'seg active' : 'seg'} onClick={() => setBanHours(l.hours)} data-testid={`admin-ban-${l.hours ?? 'forever'}`}>
                          {l.label}
                        </button>
                      ))}
                    </div>
                    <button type="button" className="btn btn-sell" onClick={() => setConfirm({ type: 'ban', id: newRequestId() })} data-testid="admin-ban">
                      Ban {player.username}…
                    </button>
                  </fieldset>
                  {confirm?.type === 'ban' && (
                    <div className="admin-confirm" data-testid="admin-ban-confirm-box">
                      <p>
                        Ban <strong>{player.username}</strong> {banHours === null ? 'until you lift it' : `for ${BAN_LENGTHS.find((l) => l.hours === banHours)?.label ?? `${banHours} hours`}`}
                        {banReason.trim() ? ` (“${banReason.trim()}”)` : ''}?
                      </p>
                      <div className="row-buttons">
                        <button type="button" className="btn btn-sell" disabled={busy} onClick={() => void ban()} data-testid="admin-ban-confirm">
                          Yes, ban
                        </button>
                        <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(null)} data-testid="admin-ban-cancel">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              <h3 className="admin-h3">Reset Career account</h3>
              <p className="hint">Back to {formatCents(100_000)} with no shares and no trade history. Coins and 1v1 history stay. This cannot be undone.</p>
              <button type="button" className="btn" disabled={busy || confirm?.type === 'reset'} onClick={() => setConfirm({ type: 'reset', id: newRequestId() })} data-testid="admin-reset">
                Reset {player.username}…
              </button>
              {confirm?.type === 'reset' && (
                <div className="admin-confirm" data-testid="admin-reset-confirm-box">
                  <p>
                    Reset the Career account of <strong>{player.username}</strong>? They have {formatCents(player.netWorthCents)} net worth now.
                  </p>
                  <div className="row-buttons">
                    <button type="button" className="btn btn-sell" disabled={busy} onClick={() => void reset()} data-testid="admin-reset-confirm">
                      Yes, reset
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(null)} data-testid="admin-reset-cancel">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {message && (
          <p className={message.kind === 'ok' ? 'notice success' : 'notice error'} role="status" data-testid="admin-player-message">
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
