// The market-wide news feed: newest first, nothing is ever deleted, older stories load page by page.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { CATEGORIES } from './format';
import { NewsList } from './NewsList';
import { useShared } from './store';
import type { NewsItem } from './types';

export function NewsScreen({ onTicker }: { onTicker: (ticker: string) => void }) {
  const { news: live, tickMs, health, conn } = useShared();
  const [category, setCategory] = useState('');
  const [breakingOnly, setBreakingOnly] = useState(false);
  const [text, setText] = useState('');
  const [items, setItems] = useState<NewsItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const q = { limit: 30, before, ...(category ? { category } : {}), ...(breakingOnly ? { breaking: true } : {}) };
        const page = await api.news(q);
        setItems((old) => (before === null ? page.items : [...old, ...page.items.filter((n) => !old.some((o) => o.id === n.id))]));
        setNext(page.next);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [category, breakingOnly],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  // A story that arrives over the live stream is added at the top (if it fits the filters).
  const matches = (n: NewsItem) => (category === '' || n.category === category) && (!breakingOnly || n.breaking);
  const fresh = live.filter((n) => matches(n) && !items.some((o) => o.id === n.id) && (items[0] === undefined || n.publishTick >= items[0].publishTick));
  const all = [...fresh, ...items];
  const needle = text.trim().toLowerCase();
  const shown = needle === '' ? all : all.filter((n) => n.headline.toLowerCase().includes(needle) || (n.ticker ?? '').toLowerCase().includes(needle) || (n.partnerTicker ?? '').toLowerCase().includes(needle));

  return (
    <section className="card news-screen" aria-label="Market news">
      <div className="market-head">
        <h2>
          Market news <span className="h2-note">newest first · every story is kept</span>
        </h2>
        <div className="filters">
          <input className="qty-input search" type="search" placeholder="Find a company or word" aria-label="Filter the loaded stories" value={text} onChange={(e) => setText(e.target.value)} />
          <select className="qty-input" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={breakingOnly} onChange={(e) => setBreakingOnly(e.target.checked)} /> Breaking only
          </label>
        </div>
      </div>
      {error && (
        <p className="notice error" role="alert">
          Could not load the news: {error}
        </p>
      )}
      {!error && conn === 'offline' && <p className="notice info">The server is not reachable, so the feed cannot update right now.</p>}
      {health?.news && !health.news.ok && (
        <p className="notice warn" role="status">
          The news service is catching up ({health.news.behind.length} companies behind, {health.news.belowMinimum.length} below the daily minimum). Stories appear as soon as it has written them.
        </p>
      )}
      <NewsList items={shown} nowMs={tickMs} onTicker={onTicker} emptyText={loading ? 'Loading the news…' : 'No stories match these filters.'} />
      {next && (
        <p className="more-row">
          <button type="button" className="btn btn-small" disabled={loading} onClick={() => void load(next)}>
            {loading ? 'Loading…' : 'Older stories'}
          </button>
        </p>
      )}
    </section>
  );
}
