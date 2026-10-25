// One company: price, market cap, the facts about it, a live chart, the order book, trading, and its news.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { CompanyChart } from './CompanyChart';
import { EarningsPanel } from './EarningsPanel';
import { bidFrom, formatBps, formatCap, formatCents, formatCount, SECTOR_NAMES, toneOf } from './format';
import { NewsList } from './NewsList';
import { CompanyPrice } from './PriceFx';
import { sharedStore, useShared } from './store';
import { TradePanel } from './TradePanel';
import type { Account, Book, CompanyDetail, NewsItem, OrderResult } from './types';

/** Which account a company page trades with. Career by default; a 1v1 match passes its own match account. */
export interface TradeContext {
  kind: 'career' | 'match';
  account: Account | null;
  /** A reason why trading is not possible right now. */
  blocked: string | null;
  onTraded: (r: OrderResult) => void;
}

const LAUNCHED_MESSAGE = 'Companies that players launched cannot be traded in a 1v1 match, so nobody can win by pumping their own coin or stock. Pick any other company.';
const BANKRUPT_MESSAGE = (ticker: string): string => `${ticker} went bankrupt. Its price stopped for good and nobody can buy or short it any more. You hold none of it, so there is nothing to trade here.`;
const HALTED_MESSAGE = (ticker: string): string => `Trading in ${ticker} is halted by the TradeQuest team. You can still watch the price, but nothing can be bought or sold for now.`;

/** The market pauses a company by itself when its price has moved 10 % within 5 minutes (like a real exchange). */
const PAUSED_MESSAGE = (ticker: string, p: { moveBps: number; reopensInTicks: number }): string => {
  const minutes = Math.ceil(p.reopensInTicks / 60);
  const when = p.reopensInTicks < 60 ? 'in under a minute' : `in about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `Trading in ${ticker} is paused for a few minutes because its price ${p.moveBps < 0 ? 'fell' : 'rose'} ${(Math.abs(p.moveBps) / 100).toFixed(1)}% within 5 minutes (exchanges do this to calm a fast move). You can still watch the price. Trading reopens ${when}.`;
};

interface Props {
  ticker: string;
  onBack: () => void;
  onTicker: (ticker: string) => void;
  trade?: TradeContext;
}

/** How many price levels of each side the order book table shows (the books have more; the totals count all of them). */
const BOOK_ROWS = 8;

export function CompanyView({ ticker, onBack, onTicker, trade }: Props) {
  const { prices, halves, tickMs, career, user, news, companies } = useShared();
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const reloadDetail = useRef<() => void>(() => undefined);
  const [error, setError] = useState<string | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [companyNews, setCompanyNews] = useState<NewsItem[]>([]);
  const [newsError, setNewsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    const load = () =>
      api
        .company(ticker)
        .then((d) => {
          if (!cancelled) setDetail(d);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        });
    reloadDetail.current = () => void load();
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      reloadDetail.current = () => undefined;
      clearInterval(id);
    };
  }, [ticker]);

  // A company the owner has just made starts trading a few seconds after its page can be opened: the moment the live prices show it
  // trading, read the page's facts again instead of waiting for the 30-second refresh (which would still say "Lists in … s").
  const startedTrading = detail !== null && !detail.trading && (prices[detail.id] ?? 0) > 0;
  useEffect(() => {
    if (startedTrading) reloadDetail.current();
  }, [startedTrading]);

  // A company that has not started trading yet (one the owner has just made) has no order book: ask for it only once it trades.
  const bookOpen = detail === null ? false : detail.trading;
  const loadBook = useCallback(() => {
    if (!bookOpen) return;
    api
      .book(ticker)
      .then(setBook)
      .catch(() => setBook(null));
  }, [ticker, bookOpen]);
  useEffect(() => {
    setBook(null);
    loadBook();
    const id = setInterval(loadBook, 2000);
    return () => clearInterval(id);
  }, [loadBook]);

  // Reload the company's news at first and whenever a new story comes out.
  const newest = news[0]?.id ?? 0;
  useEffect(() => {
    let cancelled = false;
    setNewsError(null);
    api
      .companyNews(ticker, { limit: 25 })
      .then((p) => {
        if (!cancelled) setCompanyNews(p.items);
      })
      .catch((e: unknown) => {
        if (!cancelled) setNewsError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, newest]);

  if (error) {
    return (
      <section className="card">
        <button type="button" className="btn btn-small" onClick={onBack}>
          ← All companies
        </button>
        <p className="notice error" role="alert">
          {error}
        </p>
      </section>
    );
  }
  if (!detail) {
    return (
      <section className="card">
        <button type="button" className="btn btn-small" onClick={onBack}>
          ← All companies
        </button>
        <p className="hint">Loading {ticker}…</p>
      </section>
    );
  }

  const id = detail.id;
  // The company list is refreshed the moment the owner halts, pauses or reopens trading; the page's own copy only every 30 seconds.
  const listed = companies.find((c) => c.ticker === detail.ticker);
  const halted = listed?.halted ?? detail.halted;
  const autoPause = listed ? listed.autoPause : detail.autoPause;
  const launched = listed?.launched ?? detail.launched;
  // A weak company that got a pile of bad news can go bankrupt (docs/world.md §18.2): its price has stopped, and only a position already held can be closed.
  const bankrupt = listed?.bankrupt ?? detail.bankrupt ?? false;
  const heldHere = ((trade ? trade.account : career)?.positions ?? []).some((p) => p.ticker === detail.ticker);
  // A coin launched with a money pool (docs/world.md §12.2): the cash behind it, and whether its developer took it all.
  const pool = listed ? listed.pool : detail.pool;
  const live = detail.trading && (prices[id] ?? 0) > 0;
  const price = live ? (prices[id] as number) : 0;
  const half = live ? (halves[id] ?? 0) : 0;
  // (A coin whose developer took the pool is dead: it has no bid or ask, only its frozen dust price.)
  const quoted = live && !pool?.dead;
  const bid = quoted ? bidFrom(price, half) : 0;
  const ask = quoted ? price + half : 0;
  const changeBps = live && detail.open24h > 0 ? Math.round(((price - detail.open24h) / detail.open24h) * 10_000) : detail.changeBps;
  // Market cap = price × shares outstanding, recomputed with every tick.
  const cap = live ? price * detail.sharesOutstanding : 0;
  const spreadBps = live && price > 0 ? Math.round(((ask - bid) / price) * 10_000) : detail.spreadBps;
  const coin = detail.sector === 'meme';
  const unit = coin ? 'coins' : 'sh';

  return (
    <div className="company-layout">
      <section className="card company-head">
        <div className="company-title">
          <button type="button" className="btn btn-small" onClick={onBack}>
            {coin ? '← All memecoins' : '← All companies'}
          </button>
          <h2>
            <span className="ticker">{detail.ticker}</span> {detail.name}
            {halted && (
              <span className="badge-halted" data-testid="halted-badge">
                {autoPause ? 'Paused' : 'Halted'}
              </span>
            )}
            {bankrupt && (
              <span className="badge-bankrupt" data-testid="bankrupt-badge">
                Bankrupt
              </span>
            )}
          </h2>
          <p className="muted">
            {SECTOR_NAMES[detail.sector] ?? detail.sector} · {detail.industry} · {coin ? `lives on ${detail.hq}` : detail.hq}
          </p>
          {coin && !pool && (
            <p className="hint coin-warning" data-testid="coin-warning">
              Memecoin: it can move 10 % in a minute, and trading is never paused. High leverage can wipe out your margin in seconds. Every order pays a trading fee (shown before you trade).
            </p>
          )}
          {coin && pool && !pool.dead && (
            <p className="hint coin-warning" data-testid="pool-warning">
              Memecoin with a money pool: about <strong data-testid="pool-cents">{formatCents(pool.cents)}</strong> of buyers' money sits in it. Sales are paid from it, and the player who launched {detail.ticker} can take ALL of it at any time (a rug pull): the coin then crashes and whoever still holds it is left with nothing. It can move 10 % in a minute. Every order pays a trading fee. Plain buying and selling only.
            </p>
          )}
          {bankrupt && (
            <p className="notice error" role="alert" data-testid="bankrupt-notice">
              {detail.ticker} went bankrupt. Its price crashed and stopped for good. Nobody can buy or short it any more
              {heldHere ? ', but you can still sell your shares (or cover your short) at the price it stopped at.' : '.'}
            </p>
          )}
          {coin && pool?.dead && (
            <p className="notice error" role="alert" data-testid="pool-dead">
              Rug pulled: the developer of {detail.ticker} took all the money out of its pool. {detail.ticker} is worthless and cannot be bought or sold.
            </p>
          )}
        </div>
        <CompanyPrice
          ticker={detail.ticker}
          live={live}
          price={price}
          baseCents={detail.basePriceCents}
          changeText={live ? `${formatBps(changeBps)} (24 h)` : `Lists in ${detail.listsInTicks} s`}
          changeClass={toneOf(changeBps)}
        />
        <dl className="stats company-stats">
          <div className="stat">
            <dt>Market cap</dt>
            <dd data-testid="company-cap">{live ? formatCap(cap) : '—'}</dd>
          </div>
          <div className="stat">
            <dt>{coin ? 'Coins in circulation' : 'Shares outstanding'}</dt>
            <dd>{formatCount(detail.sharesOutstanding)}</dd>
          </div>
          <div className="stat">
            <dt>{coin ? 'Freely tradable' : 'Float'}</dt>
            <dd>{formatCount(detail.floatShares)}</dd>
          </div>
          <div className="stat">
            <dt>Bid / Ask</dt>
            <dd>{quoted ? `${formatCents(bid)} / ${formatCents(ask)}` : '—'}</dd>
          </div>
          <div className="stat">
            <dt>Spread</dt>
            <dd>{quoted ? `${(spreadBps / 100).toFixed(2)}%` : '—'}</dd>
          </div>
          <div className="stat">
            <dt>24 h high / low</dt>
            <dd>{live ? `${formatCents(Math.max(detail.high24h, price))} / ${formatCents(Math.min(detail.low24h || price, price))}` : '—'}</dd>
          </div>
          <div className="stat">
            <dt>24 h volume</dt>
            <dd>{formatCount(detail.volume24h)} {unit}</dd>
          </div>
          <div className="stat">
            <dt>Avg daily volume</dt>
            <dd>{formatCount(detail.avgDailyVolume)} {unit}</dd>
          </div>
          <div className="stat">
            <dt>Liquidity</dt>
            <dd>
              {detail.liquidity} <span className="muted">({detail.liquidityScore.toFixed(0)}/100)</span>
            </dd>
          </div>
          <div className="stat">
            <dt>Mood</dt>
            <dd>{detail.mood}</dd>
          </div>
        </dl>
      </section>

      <section className="card chart-card" aria-label={`${detail.ticker} chart`}>
        {live ? <CompanyChart ticker={detail.ticker} name={detail.name} price={price} /> : <p className="hint">The chart appears when {detail.ticker} starts trading.</p>}
      </section>

      <aside className="side company-side">
        <TradePanel
          ticker={detail.ticker}
          name={detail.name}
          trading={detail.trading}
          bid={bid}
          ask={ask}
          account={trade ? trade.account : career}
          kind={trade ? trade.kind : 'career'}
          spotOnly={pool != null}
          closeOnly={bankrupt}
          blocked={pool?.dead ? `${detail.ticker} is dead: its developer took all the money out of the pool. Nothing can be bought or sold.` : bankrupt && !heldHere ? BANKRUPT_MESSAGE(detail.ticker) : halted ? (autoPause ? PAUSED_MESSAGE(detail.ticker, autoPause) : HALTED_MESSAGE(detail.ticker)) : trade && trade.kind === 'match' && launched ? LAUNCHED_MESSAGE : trade ? trade.blocked : user ? null : 'Sign in on the My account tab to trade with your Career money.'}
          onTraded={(r) => {
            if (trade) trade.onTraded(r);
            else void sharedStore.refreshAccount();
            loadBook();
          }}
        />
        <section className="card" aria-label="Order book">
          <h2>
            Order book <span className="h2-note">shares on offer</span>
          </h2>
          {!book && <p className="hint">Loading…</p>}
          {book && (
            <div className="book-scroll">
            <table className="trades book" data-testid="book">
              <thead>
                <tr>
                  <th>Bid</th>
                  <th className="num">Size</th>
                  <th>Ask</th>
                  <th className="num">Size</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: Math.min(BOOK_ROWS, Math.max(book.bids.levels.length, book.asks.levels.length)) }, (_, i) => {
                  const b = book.bids.levels[i];
                  const a = book.asks.levels[i];
                  return (
                    <tr key={i}>
                      <td className="pos mono">{b ? formatCents(b.price) : ''}</td>
                      <td className="num mono">{b ? formatCount(b.size) : ''}</td>
                      <td className="neg mono">{a ? formatCents(a.price) : ''}</td>
                      <td className="num mono">{a ? formatCount(a.size) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td>All {book.bids.levels.length} levels</td>
                  <td className="num mono" data-testid="book-total-bids">{formatCount(book.bids.total)}</td>
                  <td>All {book.asks.levels.length} levels</td>
                  <td className="num mono" data-testid="book-total-asks">{formatCount(book.asks.total)}</td>
                </tr>
              </tfoot>
            </table>
            </div>
          )}
          {book && book.bids.levels.length > BOOK_ROWS && (
            <p className="hint">
              The first {BOOK_ROWS} price levels are shown; the totals count all {book.bids.levels.length}.
            </p>
          )}
          {book && Math.abs(book.pressure) >= 0.03 && (
            <p className={`notice ${book.pressure > 0 ? 'ok' : 'warn'}`} data-testid="book-pressure">
              {book.pressure > 0
                ? 'Players have been buying lately: the asks (right) are thinner and the bids (left) thicker than usual, so buying costs more.'
                : 'Players have been selling lately: the bids (left) are thinner and the asks (right) thicker than usual, so selling gets less.'}
            </p>
          )}
        </section>
      </aside>

      <section className="card about-card" aria-label="About the company">
        <h2>About {detail.name}</h2>
        <p>{detail.description}</p>
        <p className="muted">
          {coin
            ? `Developer ${detail.ceo} · Treasury: ${detail.cfo} · Listed ${new Date(detail.listedMs).toLocaleDateString()} · Beta ${detail.beta.toFixed(2)}`
            : `CEO ${detail.ceo} · CFO ${detail.cfo} · Listed ${new Date(detail.listedMs).toLocaleDateString()} · Beta ${detail.beta.toFixed(2)}`}
        </p>
        {detail.products.length > 0 && <p className="muted">{coin ? 'Projects' : 'Products'}: {detail.products.join(', ')}</p>}
      </section>

      {!coin && <EarningsPanel ticker={detail.ticker} />}

      <section className="card news-card" aria-label={`${detail.ticker} news`}>
        <h2>
          News <span className="h2-note">{detail.ticker}, its partners, its sector and the whole market</span>
        </h2>
        {newsError && (
          <p className="notice error" role="alert">
            Could not load the news: {newsError}
          </p>
        )}
        <NewsList items={companyNews} nowMs={tickMs} onTicker={onTicker} emptyText={`No stories about ${detail.ticker} have come out yet.`} />
      </section>
    </div>
  );
}
