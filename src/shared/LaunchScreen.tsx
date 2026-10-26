// The "Launch" tab (Career): ANY signed-in player can launch a memecoin or a stock of his own with his own Career cash, and later "rug pull" it
// (sell everything he holds of it in one order). There is no size menu: the SIZE comes from the money put in. The money is not
// lost; it buys the shares the player starts out holding, at the starting price. Making a MEMECOIN is like pump.fun: it costs only a small launch
// fee, and the money put in is an optional first buy (it can be $0: then the player holds none and buys it on the market later). A coin's starting price is not typed either: every launched coin
// has the same number of coins (a trillion, like the real memecoins), so the money sets the market cap and the price follows: a free launch starts at
// about $0.00000000006 and even the biggest launch starts far below ten cents. A STOCK needs a real stake (at least $100) and a launch fee, and its starting price is not typed
// either: the money sets it. The server works out and
// checks everything; this screen only asks it for a preview as the player types, and never decides a price, a size or what a sale returns.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';
import { dollarsToCents, newRequestId } from './adminUtil';
import { AuthPanel } from './AuthPanel';
import { CompanyLogo } from './CompanyLogo';
import { CompanyPictureTools, LaunchPicturePicker, sendLaunchPicture } from './CompanyPictureTools';
import { formatCap, formatCents, formatCount, toneOf } from './format';
import { sharedStore, useShared } from './store';
import type { CoinPreview, Estimate, LaunchState, LaunchView, StockLaunchPreview } from './types';
import { celebrate, launchWin } from './winCelebration';

type Message = { kind: 'ok' | 'error'; text: string } | null;
type Preview<T> = { kind: 'none' } | { kind: 'ok'; preview: T } | { kind: 'problem'; text: string };
type Kind = 'coin' | 'stock';

const COIN_PRESETS: [string, string][] = [
  ['No first buy', '0'],
  ['$2', '2'],
  ['$10', '10'],
  ['$100', '100'],
  ['$1,000', '1000'],
  ['$5,000', '5000'],
  ['$10,000', '10000'],
  ['$25,000', '25000'],
  ['$100,000', '100000'],
  ['$500,000', '500000'],
];
const STOCK_PRESETS: [string, string][] = [
  ['$100', '100'],
  ['$500', '500'],
  ['$1,000', '1000'],
  ['$5,000', '5000'],
  ['$50,000', '50000'],
  ['$250,000', '250000'],
  ['$1,000,000', '1000000'],
];

function problem(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error);
}

function statusOf(l: LaunchView): string {
  if (!l.listed) return l.listsInSeconds > 0 ? `Lists in ${l.listsInSeconds} s` : 'Not trading yet';
  if (l.pool?.dead) return 'Rug pulled (dead)';
  if (l.halted) return 'Trading stopped';
  if (l.sharesNow === 0) return l.rugs > 0 ? 'Dumped' : l.stakeShares === 0 ? 'Trading' : 'Sold out'; // (a free coin he never held is still trading; the card says he holds none)
  return 'Trading';
}

/** Asks the server what this money makes, a moment after the typing stops. */
function usePreview<T>(enabled: boolean, seedCents: number | null, priceCents: number, ask: (seed: number, price: number) => Promise<{ ok: true; preview: T } | { ok: false; problem: string }>): Preview<T> {
  const [preview, setPreview] = useState<Preview<T>>({ kind: 'none' });
  const asked = useRef(0);
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    if (!enabled || seedCents === null) {
      setPreview({ kind: 'none' });
      return undefined;
    }
    const mine = (asked.current += 1);
    const id = setTimeout(() => {
      askRef
        .current(seedCents, priceCents)
        .then((res) => {
          if (asked.current !== mine) return;
          setPreview(res.ok ? { kind: 'ok', preview: res.preview } : { kind: 'problem', text: res.problem });
        })
        .catch((e: unknown) => {
          if (asked.current === mine) setPreview({ kind: 'problem', text: problem(e) });
        });
    }, 250);
    return () => clearTimeout(id);
  }, [enabled, seedCents, priceCents]);
  return preview;
}

export function LaunchScreen({ onOpen }: { onOpen: (ticker: string) => void }) {
  const { user, career } = useShared();
  const [state, setState] = useState<LaunchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('coin');
  const [message, setMessage] = useState<Message>(null);

  const reload = useCallback(async () => {
    try {
      setState(await api.launchState());
      setError(null);
    } catch (e) {
      setError(problem(e));
    }
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    void reload();
    const id = setInterval(() => void reload(), 5000);
    return () => clearInterval(id);
  }, [user, reload]);

  if (!user) return <AuthPanel />;

  const cash = career?.cashCents ?? state?.cashCents ?? 0;
  const mine = state?.mine ?? [];
  const fee = state?.coinForm.launchFeeCents ?? 200;
  const stockFee = state?.stockForm.launchFeeCents ?? 1000;
  const stockMin = state?.stockForm.minSeedCents ?? 10_000;

  return (
    <div className="launch-layout" data-testid="launch-screen">
      <section className="card" aria-label="Launch">
        <h2>
          Launch your own coin or stock <span className="h2-note">you have {formatCents(cash)} of cash</span>
        </h2>
        <p className="hint">
          Pick a name and a ticker. <strong>Making a memecoin costs only a {formatCents(fee)} launch fee</strong> (not refunded), like on pump.fun, and you can buy some of your own coin right away or wait and buy it on the market once it lists. A stock cannot be made for free: it needs <strong>at least {formatCents(stockMin)} put in</strong> and costs a <strong>{formatCents(stockFee)} launch fee</strong> (not refunded).
          You do not pick a size: the size comes from the money you put in (a coin with no first buy is the smallest). A little money makes a small, thin, wild company; a lot makes a big, deep, calmer one. For a memecoin the money also sets the starting price
          (every launched coin has {formatCount(state?.coinForm.supply ?? 1_000_000_000_000)} coins, like the real memecoins, so the price is tiny, a fraction of a cent: a free launch starts at about $0.00000000006 and even the biggest launch starts below ten cents; more money makes a bigger market cap and so a higher price); for a stock the money sets the starting price too (more money, a higher price per share). The money you put in is not lost: it buys the coins or shares you start out holding, at the starting price (only the launch fee is gone). Everybody can then trade your company.
        </p>
        <p className="hint">
          <strong>A memecoin has a money pool.</strong> Everything other players pay when they buy your coin goes into the pool, and everyone who sells is paid out of it (a sale can only be paid with what the pool holds). The <strong>Rug pull</strong> button takes <em>everything</em> that is in the pool for you, in cash, and kills the coin: its price drops to almost nothing ($0.00000000000001) and stays there, and
          the players who still hold it are left with coins that are worth nothing and cannot be sold. You do not need to hold any of your own coin to do it. The price itself is still made by the market, not by the pool, and a coin takes plain buying and selling only (no leverage, shorting, stop-loss or limit orders). A <strong>stock</strong> has no pool: its rug pull sells everything you hold of it in one order, which pushes the price down like any big sell (a few percent for a steady stock).
        </p>
        <p className="hint" data-testid="launch-match-note">
          Companies players launch can be traded in Career only. They are left out of 1v1 matches, and you cannot launch while your own match is starting or running.
        </p>
        {error && (
          <p className="notice error" role="alert" data-testid="launch-error">
            {error}
          </p>
        )}
        {message && (
          <p className={message.kind === 'ok' ? 'notice success' : 'notice error'} role="status" data-testid="launch-message">
            {message.text}
          </p>
        )}
      </section>

      {mine.length > 0 && (
        <section className="card" aria-label="Your launches">
          <h2>
            Your launches <span className="h2-note">{mine.length}</span>
          </h2>
          {mine.map((l) => (
            <LaunchCard key={l.companyId} launch={l} onOpen={onOpen} onChanged={async (m) => { setMessage(m); await reload(); void sharedStore.refreshAccount(); }} />
          ))}
        </section>
      )}

      <section className="card" aria-label="New launch">
        <div className="seg-group" role="tablist" aria-label="What to launch">
          <button type="button" role="tab" aria-selected={kind === 'coin'} className={kind === 'coin' ? 'seg active' : 'seg'} onClick={() => setKind('coin')} data-testid="launch-kind-coin">
            Memecoin
          </button>
          <button type="button" role="tab" aria-selected={kind === 'stock'} className={kind === 'stock' ? 'seg active' : 'seg'} onClick={() => setKind('stock')} data-testid="launch-kind-stock">
            Stock
          </button>
        </div>
        {state === null && <p className="hint">Loading…</p>}
        {state !== null && kind === 'coin' && <CoinForm state={state} cash={cash} onDone={async (m) => { setMessage(m); await reload(); void sharedStore.refreshAccount(); }} />}
        {state !== null && kind === 'stock' && <StockForm state={state} cash={cash} onDone={async (m) => { setMessage(m); await reload(); void sharedStore.refreshAccount(); }} />}
        {state !== null && (
          <p className="hint" data-testid="launch-limits">
            You hold {state.counts.coinActive} of {state.limits.activePerKind} coins and {state.counts.stockActive} of {state.limits.activePerKind} stocks you launched. Sell out of one, or rug pull it, to launch another. A company can never be deleted.
          </p>
        )}
      </section>
    </div>
  );
}

// ---- the coin form ----------------------------------------------------------------------------------------------------------------

function CoinForm({ state, cash, onDone }: { state: LaunchState; cash: number; onDone: (m: Message) => Promise<void> }) {
  const form = state.coinForm;
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [seed, setSeed] = useState('');
  const [dev, setDev] = useState('');
  const [description, setDescription] = useState('');
  const [picture, setPicture] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null); // the request id, once "Launch coin…" was pressed
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  // An empty box, or a typed 0, is no first buy at all ($0): the coin is made and the player holds none of it (dollarsToCents refuses a zero).
  const typedSeed = seed.trim().replace(/^\$/, '').replace(/,/g, '');
  const seedCents = typedSeed === '' || /^0+(\.0{1,2})?$/.test(typedSeed) ? 0 : dollarsToCents(seed);
  const nameOk = name.trim().length >= 3 && name.trim().length <= form.nameMax;
  const tickerOk = /^[A-Z]{3,5}$/.test(ticker);
  const seedOk = seedCents !== null && (seedCents === 0 || (seedCents >= form.minSeedCents && seedCents <= form.maxSeedCents));
  // The starting price is not typed: the server works it out from the money and sends it back with the preview.
  const preview = usePreview<CoinPreview>(seedOk, seedCents, 0, (s) => api.launchCoinPreview(s));
  const shown = preview.kind === 'ok' ? preview.preview : null;
  const ready = nameOk && tickerOk && seedOk && shown !== null && shown.enough && shown.seedCents === seedCents;

  const hint = (): string | null => {
    if (name.trim() !== '' && !nameOk) return `The name needs 3 to ${form.nameMax} characters.`;
    if (ticker !== '' && !tickerOk) return 'The ticker is 3 to 5 letters, for example PEPE.';
    if (seed.trim() !== '' && !seedOk) return `Your first buy is $0 (none) or from ${formatCents(form.minSeedCents)} to ${formatCents(form.maxSeedCents)}.`;
    if (preview.kind === 'problem') return preview.text;
    if (shown !== null && !shown.enough) {
      return shown.spentCents === 0
        ? `Making a coin costs the ${formatCents(shown.feeCents)} launch fee and you have ${formatCents(shown.cashCents)}. Grow your cash first.`
        : `That needs ${formatCents(shown.totalCents)} of cash (the ${formatCents(shown.feeCents)} launch fee and ${formatCents(shown.spentCents)} for the first buy) and you have ${formatCents(shown.cashCents)}. Put in less, or grow your cash first.`;
    }
    return null;
  };

  const launch = async () => {
    if (busy || confirm === null || seedCents === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.launchCoin({ requestId: confirm, name: name.trim(), ticker, seedCents, dev: dev.trim() || undefined, description: description.trim() || undefined });
      setConfirm(null);
      const held = res.stakeShares ?? 0;
      const pictureProblem = await sendLaunchPicture(res.ticker, picture);
      const pictureNote = pictureProblem === null ? '' : `The picture could not be saved (${pictureProblem}). You can add it again below, under your launches, or on the coin's page. `;
      const text =
        res.loaded === false
          ? `${res.ticker} was saved, but it could not be added to the running market. It will start trading after the next server start.`
          : `${res.ticker} is launched${res.sizeLabel ? ` (${res.sizeLabel.toLowerCase()})` : ''}. You paid the ${formatCents(res.feeCents ?? 0)} launch fee${
              held > 0
                ? ` and bought ${held.toLocaleString('en-US')} coins for ${formatCents(res.spentCents ?? 0)}${res.priceCents ? ` (${formatCents(res.priceCents)} a coin)` : ''}`
                : ` and bought none yet${res.priceCents ? ` (it starts at ${formatCents(res.priceCents)} a coin)` : ''}`
            }. It starts trading in about ${res.startsInSeconds ?? form.listsInSeconds} seconds and shows up in the Memecoins list now${held > 0 ? '' : ', where you can buy it like anyone else'}.`;
      setName('');
      setTicker('');
      setSeed('');
      setDev('');
      setDescription('');
      setPicture(null);
      setMessage(null);
      if (res.loaded !== false) celebrate(launchWin(res.ticker));
      await onDone({ kind: res.loaded === false ? 'error' : 'ok', text: pictureNote === '' ? text : `${text} ${pictureNote.trim()}` });
    } catch (error) {
      setConfirm(null);
      setMessage({ kind: 'error', text: problem(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <fieldset className="admin-fields" disabled={busy || confirm !== null}>
        <label className="qty-label" htmlFor="launch-coin-name">
          Coin name
        </label>
        <input id="launch-coin-name" className="qty-input" type="text" maxLength={form.nameMax} placeholder="For example: Moon Pepe" value={name} onChange={(e) => setName(e.target.value)} data-testid="launch-coin-name" />

        <label className="qty-label" htmlFor="launch-coin-ticker">
          Ticker (3 to 5 letters)
        </label>
        <input
          id="launch-coin-ticker"
          className="qty-input"
          type="text"
          maxLength={5}
          autoCapitalize="characters"
          placeholder="PEPE"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
          data-testid="launch-coin-ticker"
        />

        <label className="qty-label" htmlFor="launch-coin-seed">
          First buy of your own coin ($) — optional: leave it empty to buy none. More money makes a bigger coin and a higher starting price
        </label>
        <input id="launch-coin-seed" className="qty-input" type="text" inputMode="decimal" placeholder="0 (no first buy)" value={seed} onChange={(e) => setSeed(e.target.value)} data-testid="launch-coin-seed" />
        <div className="row-buttons" aria-label="Quick amounts">
          {COIN_PRESETS.map(([label, value]) => (
            <button key={value} type="button" className="btn btn-small" onClick={() => setSeed(value)} data-testid={`launch-coin-preset-${value}`}>
              {label}
            </button>
          ))}
        </div>

        <label className="qty-label" htmlFor="launch-coin-dev">
          Developer name (optional — the name other players see)
        </label>
        <input id="launch-coin-dev" className="qty-input" type="text" maxLength={form.devMax} placeholder="AnonDev" value={dev} onChange={(e) => setDev(e.target.value)} data-testid="launch-coin-dev" />

        <label className="qty-label" htmlFor="launch-coin-description">
          About the coin (optional, {description.length}/{form.descriptionMax})
        </label>
        <textarea
          id="launch-coin-description"
          className="qty-input"
          rows={3}
          maxLength={form.descriptionMax}
          placeholder="Leave empty for an automatic description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="launch-coin-description"
        />
        <LaunchPicturePicker kind="coin" image={picture} onImage={setPicture} />

        {shown !== null && (
          <div className="admin-confirm" data-testid="launch-coin-preview">
            <p>
              <strong data-testid="launch-coin-size">{shown.sizeLabel}</strong> — {shown.sizeNote}
            </p>
            <ul>
              <li>
                Starting price <strong data-testid="launch-coin-price">{formatCents(shown.priceCents)}</strong> a coin.{' '}
                {`Your money sets the market cap, and every launched coin has ${shown.supply.toLocaleString('en-US')} coins, so the price is the market cap divided by that. Real memecoins cost a tiny fraction of a cent too.`}
              </li>
              <li>
                Market cap about <strong data-testid="launch-coin-cap">{formatCap(shown.marketCapCents)}</strong> ({formatCount(shown.supply)} coins in circulation)
              </li>
              <li>
                Liquidity <strong data-testid="launch-coin-liquidity">{shown.liquidityPct}%</strong> (the buy–sell gap is about {(shown.spreadBps / 100).toFixed(2)}%). A typical move in 3 minutes: about <strong data-testid="launch-coin-move">{shown.typicalMovePct}%</strong> either way
              </li>
              <li data-testid="launch-coin-cost">
                Launch fee <strong data-testid="launch-coin-fee">{formatCents(shown.feeCents)}</strong> (paid and gone){shown.stakeShares > 0 ? <> plus your first buy of {formatCents(shown.spentCents)}</> : ''}: <strong data-testid="launch-coin-total">{formatCents(shown.totalCents)}</strong> leaves your cash (you have {formatCents(cash)})
              </li>
              <li>
                {shown.stakeShares > 0 ? (
                  <>
                    You hold <strong data-testid="launch-coin-stake">{shown.stakeShares.toLocaleString('en-US')}</strong> coins ({shown.stakePct}% of all of them, about {shown.stakeOfBookPct}% of the order book)
                  </>
                ) : (
                  <>
                    You hold <strong data-testid="launch-coin-stake">0</strong> coins: you buy none right away. When it lists, in about {form.listsInSeconds} seconds, you can buy it on the market like anyone else (you then pay the buy–sell gap and the 0.5% fee)
                  </>
                )}
              </li>
              {shown.stakeShares > 0 && (
                <li data-testid="launch-coin-dump">
                  If you sold all of it right after launching ({shown.dumpFilledPct >= 100 ? 'the book takes it all' : `the book takes ${shown.dumpFilledPct}% of it`}), about <strong>{formatCents(shown.dumpReceiveCents)}</strong> would come back, the price would be pushed down about{' '}
                  {shown.dumpPriceDropPct}%, and the price would have to rise about <strong>{shown.breakEvenRisePct}%</strong> first for the sale to get your money back.
                </li>
              )}
            </ul>
          </div>
        )}

        {hint() && (
          <p className="hint" role="status" data-testid="launch-coin-hint">
            {hint()}
          </p>
        )}
        <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setConfirm(newRequestId())} data-testid="launch-coin-start">
          Launch coin…
        </button>
      </fieldset>

      {confirm !== null && shown !== null && (
        <div className="admin-confirm" data-testid="launch-coin-confirm-box">
          <p>
            Launch <strong>{ticker}</strong> — {name.trim()} ({shown.sizeLabel.toLowerCase()}) at <strong>{formatCents(shown.priceCents)}</strong> a coin? You pay the <strong>{formatCents(shown.feeCents)}</strong> launch fee
            {shown.stakeShares > 0 ? (
              <>
                {' '}
                and put in <strong>{formatCents(shown.spentCents)}</strong> of your cash for <strong>{shown.stakeShares.toLocaleString('en-US')}</strong> coins
              </>
            ) : (
              <> and buy no coins right away</>
            )}
            : <strong>{formatCents(shown.totalCents)}</strong> in all. It starts trading in about {form.listsInSeconds} seconds. You cannot delete it afterwards.
          </p>
          <div className="row-buttons">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void launch()} data-testid="launch-coin-confirm">
              Yes, launch it
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(null)} data-testid="launch-coin-cancel">
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && (
        <p className={message.kind === 'ok' ? 'notice success' : 'notice error'} role="status" data-testid="launch-coin-message">
          {message.text}
        </p>
      )}

      <details className="launch-ladder">
        <summary>What a first buy makes (the starting price too)</summary>
        <div className="table-wrap">
          <table className="trades" data-testid="launch-coin-ladder">
            <thead>
              <tr>
                <th className="num">First buy</th>
                <th className="num">Starting price</th>
                <th className="num">Coins</th>
                <th>Size</th>
                <th className="num">Market cap</th>
                <th className="num">Liquidity</th>
                <th className="num">Typical 3-minute move</th>
                <th className="num">Cost of selling it all at once</th>
              </tr>
            </thead>
            <tbody>
              {form.ladder.map((r) => (
                <tr key={r.seedCents}>
                  <td className="num">{r.seedCents === 0 ? 'none' : formatCents(r.seedCents)}</td>
                  <td className="num">{formatCents(r.priceCents)}</td>
                  <td className="num">{formatCount(r.supply)}</td>
                  <td>{r.sizeLabel}</td>
                  <td className="num">{formatCap(r.marketCapCents)}</td>
                  <td className="num">{r.liquidityPct}%</td>
                  <td className="num">{r.typicalMovePct}%</td>
                  <td className="num">about {r.dumpCostPct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

// ---- the stock form ---------------------------------------------------------------------------------------------------------------

function StockForm({ state, cash, onDone }: { state: LaunchState; cash: number; onDone: (m: Message) => Promise<void> }) {
  const form = state.stockForm;
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [sector, setSector] = useState('');
  const [seed, setSeed] = useState('');
  const [industry, setIndustry] = useState('');
  const [description, setDescription] = useState('');
  const [picture, setPicture] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const seedCents = dollarsToCents(seed);
  const nameOk = name.trim().length >= 3 && name.trim().length <= form.nameMax;
  const tickerOk = /^[A-Z]{3,5}$/.test(ticker);
  const sectorOk = form.sectors.some((s) => s.id === sector);
  const seedOk = seedCents !== null && seedCents >= form.minSeedCents && seedCents <= form.maxSeedCents;
  const preview = usePreview<StockLaunchPreview>(seedOk, seedCents, 0, (s) => api.launchStockPreview(s));
  const shown = preview.kind === 'ok' ? preview.preview : null;
  const ready = nameOk && tickerOk && sectorOk && seedOk && shown !== null && shown.enough && shown.seedCents === seedCents;

  const hint = (): string | null => {
    if (name.trim() !== '' && !nameOk) return `The name needs 3 to ${form.nameMax} characters.`;
    if (ticker !== '' && !tickerOk) return 'The ticker is 3 to 5 letters, for example ZRLX.';
    if (seed.trim() !== '' && !seedOk) return `A stock needs ${formatCents(form.minSeedCents)} to ${formatCents(form.maxSeedCents)} put in.`;
    if (preview.kind === 'problem') return preview.text;
    if (shown !== null && !shown.enough) return `That needs ${formatCents(shown.totalCents)} of cash (${formatCents(shown.spentCents)} for the shares and the ${formatCents(shown.feeCents)} launch fee) and you have ${formatCents(shown.cashCents)}. Put in less, or grow your cash first.`;
    return null;
  };

  const launch = async () => {
    if (busy || confirm === null || seedCents === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.launchStock({ requestId: confirm, name: name.trim(), ticker, sector, seedCents, industry: industry.trim() || undefined, description: description.trim() || undefined });
      setConfirm(null);
      const pictureProblem = await sendLaunchPicture(res.ticker, picture);
      const pictureNote = pictureProblem === null ? '' : `The picture could not be saved (${pictureProblem}). You can add it again below, under your launches, or on the company's page. `;
      const text =
        res.loaded === false
          ? `${res.ticker} was saved, but it could not be added to the running market. It will start trading after the next server start.`
          : `${res.ticker} is launched${res.tierLabel ? ` (${res.tierLabel.toLowerCase()})` : ''}. You hold ${(res.stakeShares ?? 0).toLocaleString('en-US')} shares at ${formatCents(res.priceCents ?? 0)} for ${formatCents(res.spentCents ?? 0)}, and the ${formatCents(res.feeCents ?? 0)} launch fee is gone. It starts trading in about ${res.startsInSeconds ?? form.listsInSeconds} seconds and shows up in the Market list now.`;
      setName('');
      setTicker('');
      setSeed('');
      setIndustry('');
      setDescription('');
      setPicture(null);
      setMessage(null);
      if (res.loaded !== false) celebrate(launchWin(res.ticker));
      await onDone({ kind: res.loaded === false ? 'error' : 'ok', text: pictureNote === '' ? text : `${text} ${pictureNote.trim()}` });
    } catch (error) {
      setConfirm(null);
      setMessage({ kind: 'error', text: problem(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <fieldset className="admin-fields" disabled={busy || confirm !== null}>
        <label className="qty-label" htmlFor="launch-stock-name">
          Company name
        </label>
        <input id="launch-stock-name" className="qty-input" type="text" maxLength={form.nameMax} placeholder="For example: Acme Robotics" value={name} onChange={(e) => setName(e.target.value)} data-testid="launch-stock-name" />

        <label className="qty-label" htmlFor="launch-stock-ticker">
          Ticker (3 to 5 letters)
        </label>
        <input
          id="launch-stock-ticker"
          className="qty-input"
          type="text"
          maxLength={5}
          autoCapitalize="characters"
          placeholder="ACMR"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
          data-testid="launch-stock-ticker"
        />

        <label className="qty-label" htmlFor="launch-stock-sector">
          Sector
        </label>
        <select id="launch-stock-sector" className="qty-input" value={sector} onChange={(e) => setSector(e.target.value)} data-testid="launch-stock-sector">
          <option value="">Pick a sector…</option>
          {form.sectors.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <label className="qty-label" htmlFor="launch-stock-seed">
          Money you put in ($) — this sets the size and the starting price
        </label>
        <input id="launch-stock-seed" className="qty-input" type="text" inputMode="decimal" placeholder="5,000" value={seed} onChange={(e) => setSeed(e.target.value)} data-testid="launch-stock-seed" />
        <div className="row-buttons" aria-label="Quick amounts">
          {STOCK_PRESETS.map(([label, value]) => (
            <button key={value} type="button" className="btn btn-small" onClick={() => setSeed(value)} data-testid={`launch-stock-preset-${value}`}>
              {label}
            </button>
          ))}
        </div>

        <label className="qty-label" htmlFor="launch-stock-industry">
          Industry (optional)
        </label>
        <input id="launch-stock-industry" className="qty-input" type="text" maxLength={50} placeholder="Leave empty for the sector's usual one" value={industry} onChange={(e) => setIndustry(e.target.value)} data-testid="launch-stock-industry" />

        <label className="qty-label" htmlFor="launch-stock-description">
          About the company (optional, {description.length}/{form.descriptionMax})
        </label>
        <textarea
          id="launch-stock-description"
          className="qty-input"
          rows={3}
          maxLength={form.descriptionMax}
          placeholder="Leave empty for an automatic description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="launch-stock-description"
        />
        <LaunchPicturePicker kind="stock" image={picture} onImage={setPicture} />

        {shown !== null && (
          <div className="admin-confirm" data-testid="launch-stock-preview">
            <p>
              <strong data-testid="launch-stock-size">{shown.tierLabel}</strong> — {shown.tierNote}
            </p>
            <ul>
              <li>
                Market cap somewhere between {formatCap(shown.capLoCents)} and {formatCap(shown.capHiCents)}
              </li>
              <li>
                Starting price <strong data-testid="launch-stock-price">{formatCents(shown.priceCents)}</strong> a share
              </li>
              <li>
                You hold <strong data-testid="launch-stock-stake">{shown.stakeShares.toLocaleString('en-US')}</strong> shares ({formatCents(shown.spentCents)}), and the {formatCents(shown.feeCents)} launch fee is gone for good, so{' '}
                <strong data-testid="launch-stock-total">{formatCents(shown.totalCents)}</strong> leaves your cash (you have {formatCents(cash)})
              </li>
              <li>Stocks are steady. Selling your whole stake costs a few percent and moves the price only a little, so a stock rug pull mostly just cashes you out. Coins are where it really shows.</li>
            </ul>
          </div>
        )}

        {hint() && (
          <p className="hint" role="status" data-testid="launch-stock-hint">
            {hint()}
          </p>
        )}
        <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => setConfirm(newRequestId())} data-testid="launch-stock-start">
          Launch stock…
        </button>
      </fieldset>

      {confirm !== null && shown !== null && (
        <div className="admin-confirm" data-testid="launch-stock-confirm-box">
          <p>
            Launch <strong>{ticker}</strong> — {name.trim()} ({shown.tierLabel.toLowerCase()}) at <strong>{formatCents(shown.priceCents)}</strong> a share, putting in <strong>{formatCents(shown.spentCents)}</strong> of your cash for{' '}
            <strong>{shown.stakeShares.toLocaleString('en-US')}</strong> shares, plus the <strong>{formatCents(shown.feeCents)}</strong> launch fee ({formatCents(shown.totalCents)} in all)? It starts trading in about {form.listsInSeconds} seconds. You cannot delete it afterwards.
          </p>
          <div className="row-buttons">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void launch()} data-testid="launch-stock-confirm">
              Yes, launch it
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(null)} data-testid="launch-stock-cancel">
              Cancel
            </button>
          </div>
        </div>
      )}
      {message && (
        <p className={message.kind === 'ok' ? 'notice success' : 'notice error'} role="status" data-testid="launch-stock-message">
          {message.text}
        </p>
      )}

      <details className="launch-ladder">
        <summary>What different amounts make (the starting price too)</summary>
        <div className="table-wrap">
          <table className="trades" data-testid="launch-stock-ladder">
            <thead>
              <tr>
                <th className="num">Money put in</th>
                <th className="num">Starting price</th>
                <th className="num">Shares you hold</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {form.ladder.map((r) => (
                <tr key={r.seedCents}>
                  <td className="num">{formatCents(r.seedCents)}</td>
                  <td className="num">{formatCents(r.priceCents)}</td>
                  <td className="num">{r.stakeShares.toLocaleString('en-US')}</td>
                  <td>{r.tierLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

// ---- one launched company, with the rug pull button ---------------------------------------------------------------------------------------

function LaunchCard({ launch: l, onOpen, onChanged }: { launch: LaunchView; onOpen: (ticker: string) => void; onChanged: (m: Message) => Promise<void> }) {
  const unit = l.kind === 'coin' ? 'coins' : 'shares';
  const [confirm, setConfirm] = useState<{ id: string; estimate: Estimate | null; problem: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    if (busy) return;
    // A coin with a money pool: the rug pull takes the pool, so there is nothing to estimate (the page shows what the pool holds).
    if (l.pool) {
      setConfirm({ id: newRequestId(), estimate: null, problem: null });
      return;
    }
    setBusy(true);
    const id = newRequestId();
    try {
      const estimate = await api.estimate(l.ticker, 'sell', l.sharesNow, 'career');
      setConfirm({ id, estimate, problem: null });
    } catch (error) {
      // The sale itself is still allowed; the estimate is only a preview.
      setConfirm({ id, estimate: null, problem: problem(error) });
    } finally {
      setBusy(false);
    }
  };

  const dump = async () => {
    if (busy || confirm === null) return;
    setBusy(true);
    try {
      const res = await api.rugPull({ requestId: confirm.id, ticker: l.ticker });
      setConfirm(null);
      if (res.kind === 'drain') {
        const left =
          res.otherHolders > 0
            ? ` ${res.otherHolders.toLocaleString('en-US')} other ${res.otherHolders === 1 ? 'player is' : 'players are'} left holding ${res.otherCoins.toLocaleString('en-US')} worthless coins.`
            : ' Nobody else was holding it.';
        await onChanged({ kind: 'ok', text: `You took ${formatCents(res.takenCents)} out of the ${l.ticker} pool. ${l.ticker} is dead now: its price has dropped to almost nothing.${left}` });
        return;
      }
      const text = res.partial
        ? `You sold ${res.filled.toLocaleString('en-US')} of ${res.requested.toLocaleString('en-US')} ${l.ticker} for ${formatCents(res.receivedCents)}. The order book could not take it all at once: ${res.remaining.toLocaleString('en-US')} ${unit} are still yours. Press Rug pull again in a few minutes for the rest.`
        : `You dumped all ${res.filled.toLocaleString('en-US')} ${l.ticker} ${unit} and got ${formatCents(res.receivedCents)} (${formatCents(res.feeCents)} of it went to the fee). The price now moves on its own.`;
      await onChanged({ kind: 'ok', text });
    } catch (error) {
      setConfirm(null);
      await onChanged({ kind: 'error', text: problem(error) });
    } finally {
      setBusy(false);
    }
  };

  const est = confirm?.estimate ?? null;
  return (
    <div className="launch-card" data-testid={`launch-row-${l.ticker}`}>
      <div className="row-between">
        <h3>
          <CompanyLogo ticker={l.ticker} size={32} className="logo-inline" />
          <button type="button" className="link-btn" onClick={() => onOpen(l.ticker)} data-testid={`launch-open-${l.ticker}`}>
            {l.ticker}
          </button>{' '}
          <span className="h2-note">
            {l.name} · {l.kind === 'coin' ? 'memecoin' : 'stock'}
          </span>
        </h3>
        <span className="launch-status" data-testid={`launch-status-${l.ticker}`}>
          {statusOf(l)}
        </span>
      </div>
      <dl className="stats">
        <div className="stat">
          <dt>Put in</dt>
          <dd>
            {l.spentCents === 0 ? 'no first buy' : formatCents(l.spentCents)}
            {l.feeCents > 0 && <span className="h2-note"> + {formatCents(l.feeCents)} fee</span>}
          </dd>
        </div>
        <div className="stat">
          <dt>You hold</dt>
          <dd data-testid={`launch-held-${l.ticker}`}>
            {l.sharesNow.toLocaleString('en-US')} {unit}
          </dd>
        </div>
        <div className="stat">
          <dt>Worth now</dt>
          <dd>{l.listed ? formatCents(l.valueNowCents) : '–'}</dd>
        </div>
        <div className="stat">
          <dt>Price</dt>
          <dd>
            {formatCents(l.priceNowCents)} <span className="h2-note">started at {formatCents(l.priceCents)}</span>
          </dd>
        </div>
        <div className="stat">
          <dt>Result so far</dt>
          <dd className={toneOf(l.profitCents)} data-testid={`launch-result-${l.ticker}`}>
            {l.profitCents > 0 ? '+' : ''}
            {formatCents(l.profitCents)}
          </dd>
        </div>
      </dl>
      {l.pool && (
        <p className="hint" data-testid={`launch-pool-${l.ticker}`}>
          {l.pool.dead ? (
            <>
              You took {formatCents(l.pool.drainedCents)} out of the pool. {l.ticker} is dead: nothing can be bought or sold, and what is still held of it is worth nothing.
            </>
          ) : (
            <>
              Money pool: <strong data-testid={`launch-pool-cents-${l.ticker}`}>{formatCents(l.pool.cents)}</strong>. Buyers paid in {formatCents(l.pool.inCents)} in all (your own first buy included) and sellers took out {formatCents(l.pool.outCents)}. A rug pull takes the {formatCents(l.pool.cents)}.
            </>
          )}
        </p>
      )}
      {l.listed && l.sharesNow > 0 && !l.pool?.dead && (
        <p className="hint">Worth now is at the middle price. Selling everything at once brings back less: the buy–sell gap, the price push{l.kind === 'coin' ? ' and the 0.5% fee' : ''} come off it.</p>
      )}
      <CompanyPictureTools ticker={l.ticker} />
      {l.rugs > 0 && !l.pool && (
        <p className="hint">
          Dumped {l.ruggedShares.toLocaleString('en-US')} {unit} in {l.rugs} {l.rugs === 1 ? 'order' : 'orders'} for {formatCents(l.ruggedCents)}.
        </p>
      )}
      {confirm === null && (
        <div className="row-buttons">
          <button type="button" className="btn btn-sell" disabled={!l.canRug || busy} title={l.blocked ?? undefined} onClick={() => void ask()} data-testid={`launch-rug-${l.ticker}`}>
            Rug pull…
          </button>
          {l.blocked && <span className="hint">{l.blocked}</span>}
        </div>
      )}
      {confirm !== null && (
        <div className="admin-confirm" data-testid={`launch-rug-confirm-box-${l.ticker}`}>
          {l.pool ? (
            <p>
              Take <strong data-testid={`launch-rug-take-${l.ticker}`}>{formatCents(l.pool.cents)}</strong>, everything in the {l.ticker} money pool, as your cash? {l.ticker} dies right away: its price drops to almost nothing and stays there, and everybody who holds it (you too: {l.sharesNow.toLocaleString('en-US')} {unit}) is left with {unit} that are worth nothing and cannot be sold. The pool may hold a different amount by the time you press the button; you get what is in it then. You cannot undo it.
            </p>
          ) : (
          <p>
            Sell <strong>all {l.sharesNow.toLocaleString('en-US')}</strong> {l.ticker} {unit} you hold, in one order, right now?{' '}
            {est !== null ? (
              <>
                {est.unfilledQty > 0 ? `The order book can take ${est.filledQty.toLocaleString('en-US')} of them right now (press again later for the rest). ` : ''}
                You would get about <strong data-testid={`launch-rug-estimate-${l.ticker}`}>{formatCents(est.netCents)}</strong>
                {est.feeCents > 0 ? ` (after a ${formatCents(est.feeCents)} fee)` : ''}, and the price would be pushed about {(Math.abs(est.moveBps) / 100).toFixed(1)}% lower. That is an estimate; the price moves all the time. You cannot undo it.
              </>
            ) : (
              <>You could not be shown an estimate ({confirm.problem}). The sale pushes the price down and you cannot undo it.</>
            )}
          </p>
          )}
          <div className="row-buttons">
            <button type="button" className="btn btn-sell" disabled={busy} onClick={() => void dump()} data-testid={`launch-rug-confirm-${l.ticker}`}>
              {l.pool ? 'Yes, take the pool' : 'Yes, dump everything'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(null)} data-testid={`launch-rug-cancel-${l.ticker}`}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
