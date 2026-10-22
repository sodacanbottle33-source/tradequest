// All companies on the shared market: search, filter by sector, sort, and live price / change / market cap.
import { memo, useMemo, useState } from 'react';
import { formatBps, formatCap, formatCount, SECTOR_NAMES, toneOf } from './format';
import { FlashPrice } from './PriceFx';
import { useShared } from './store';
import type { OverviewRow } from './types';

type SortKey = 'cap' | 'price' | 'change' | 'move' | 'volume' | 'name';
/** Which list the screen shows: the stocks, or the memecoins (their own tab). */
export type MarketKind = 'stocks' | 'coins';
const PAGE = 100;

interface RowProps {
  coins: boolean;
  row: OverviewRow;
  price: number;
  selected: boolean;
  onOpen: (ticker: string) => void;
}

const Row = memo(function Row({ coins, row, price, selected, onOpen }: RowProps) {
  const live = row.trading && price > 0;
  const changeBps = live && row.open24h > 0 ? Math.round(((price - row.open24h) / row.open24h) * 10_000) : row.changeBps;
  // Market cap = price × shares outstanding. The list does not carry the share count, so it is scaled from the server's figure.
  const cap = live && row.price > 0 ? Math.round((row.marketCapCents / row.price) * price) : row.marketCapCents;
  return (
    <tr className={selected ? 'row-selected' : undefined} data-ticker={row.ticker}>
      <td>
        <button type="button" className="link-btn company-link" onClick={() => onOpen(row.ticker)}>
          <strong>{row.ticker}</strong>
        </button>{' '}
        <span className="muted company-name">{row.name}</span>
        {row.halted && <span className="badge-halted">{row.autoPause ? 'Paused' : 'Halted'}</span>}
      </td>
      {!coins && <td className="col-sector">{SECTOR_NAMES[row.sector] ?? row.sector}</td>}
      <td className="num mono">
        <FlashPrice cents={live ? price : 0} resetKey={row.ticker} />
      </td>
      <td className={`num mono ${live ? toneOf(changeBps) : ''}`}>{live ? formatBps(changeBps) : row.trading ? '—' : 'Not listed yet'}</td>
      <td className="num mono">{live ? formatCap(cap) : '—'}</td>
      <td className="num mono col-volume">{live ? formatCount(row.volume24h) : '—'}</td>
      <td className="col-liq">{row.liquidity}</td>
    </tr>
  );
});

export function MarketScreen({ onOpen, selected, kind = 'stocks', hideLaunched = false }: { onOpen: (ticker: string) => void; selected: string | null; kind?: MarketKind; hideLaunched?: boolean }) {
  const shared = useShared();
  const { prices, conn } = shared;
  const coins = kind === 'coins';
  // The stocks and the memecoins are two lists of the same market; each tab shows its own.
  // In a 1v1 match the companies players launched are left out: they cannot be traded there.
  const companies = useMemo(() => shared.companies.filter((c) => (c.sector === 'meme') === coins && !(hideLaunched && c.launched)), [shared.companies, coins, hideLaunched]);
  const [query, setQuery] = useState('');
  const [sector, setSector] = useState('');
  const [sort, setSort] = useState<SortKey>('cap');
  const [shown, setShown] = useState(PAGE);

  const sectors = useMemo(() => Array.from(new Set(companies.map((c) => c.sector))).sort(), [companies]);

  // The order is decided from the list the server sent (refreshed every 20 seconds), so rows do not jump around every tick.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = companies.filter((c) => (sector === '' || c.sector === sector) && (q === '' || c.ticker.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)));
    const key: Record<SortKey, (c: OverviewRow) => number | string> = {
      cap: (c) => -c.marketCapCents,
      price: (c) => -c.price,
      change: (c) => -c.changeBps,
      move: (c) => -Math.abs(c.changeBps),
      volume: (c) => -c.volume24h,
      name: (c) => c.ticker,
    };
    const k = key[sort];
    return [...list].sort((a, b) => {
      const x = k(a);
      const y = k(b);
      return x < y ? -1 : x > y ? 1 : a.id - b.id;
    });
  }, [companies, query, sector, sort]);

  const listed = companies.filter((c) => c.trading).length;

  const noun = coins ? 'Memecoins' : 'Companies';
  return (
    <section className="card market-screen" aria-label={noun} data-testid={coins ? 'coin-screen' : 'stock-screen'}>
      <div className="market-head">
        <h2>
          {noun} <span className="h2-note">{companies.length} fictional · {listed} trading now</span>
        </h2>
        <div className="filters">
          <input
            className="qty-input search"
            type="search"
            placeholder="Search ticker or name"
            aria-label="Search companies"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(PAGE);
            }}
          />
          {!coins && (
            <select className="qty-input" aria-label="Sector" value={sector} onChange={(e) => { setSector(e.target.value); setShown(PAGE); }}>
              <option value="">All sectors</option>
              {sectors.map((s) => (
                <option key={s} value={s}>
                  {SECTOR_NAMES[s] ?? s}
                </option>
              ))}
            </select>
          )}
          <select className="qty-input" aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="cap">Biggest market cap</option>
            <option value="change">Biggest 24 h gain</option>
            {coins && <option value="move">Wildest 24 h move</option>}
            <option value="volume">Most traded</option>
            <option value="price">Highest price</option>
            <option value="name">Ticker A–Z</option>
          </select>
        </div>
      </div>
      {hideLaunched && shared.companies.some((c) => c.launched) && (
        <p className="hint" data-testid="launched-hidden">
          Companies that players launched are not listed here: they cannot be traded in a 1v1 match.
        </p>
      )}
      {companies.length === 0 && (
        <p className="hint" role="status">
          {conn === 'online' ? `Loading the ${coins ? 'coins' : 'companies'}…` : 'Waiting for the server…'}
        </p>
      )}
      {companies.length > 0 && (
        <div className="table-wrap">
          <table className="trades market-table" data-testid="market-table">
            <thead>
              <tr>
                <th>{coins ? 'Coin' : 'Company'}</th>
                {!coins && <th className="col-sector">Sector</th>}
                <th className="num">Price</th>
                <th className="num">24 h</th>
                <th className="num">Market cap</th>
                <th className="num col-volume">Volume</th>
                <th className="col-liq">Liquidity</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((r) => (
                <Row key={r.id} coins={coins} row={r} price={prices[r.id] ?? 0} selected={selected === r.ticker} onOpen={onOpen} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length === 0 && companies.length > 0 && <p className="hint">No {coins ? 'coin' : 'company'} matches that search.</p>}
      {coins && companies.length === 0 && conn === 'online' && <p className="hint">The memecoins are not in this market yet. They are added the first time the server starts with the memecoins switched on.</p>}
      {rows.length > shown && (
        <p className="more-row">
          <button type="button" className="btn btn-small" onClick={() => setShown(shown + PAGE)}>
            Show {Math.min(PAGE, rows.length - shown)} more ({rows.length - shown} left)
          </button>
        </p>
      )}
      <p className="hint">
        {coins
          ? 'Market cap = coin price × coins in circulation. Coins swing far more than stocks: 10 % in a minute is normal, and small coins with low liquidity move the most. Trading is never paused. Prices move every second; the table order refreshes every 20 seconds.'
          : 'Market cap = share price × shares outstanding. Prices move every second; the table order refreshes every 20 seconds.'}
      </p>
    </section>
  );
}
