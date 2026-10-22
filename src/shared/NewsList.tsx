// A list of news stories: headline, BREAKING label, category, direction, how long ago, and what the price did afterwards.
import { useState } from 'react';
import { DIRECTION_LABEL, STRENGTH_LABEL, formatBps, timeAgo, toneOf } from './format';
import type { NewsItem } from './types';

interface Props {
  items: readonly NewsItem[];
  /** The market's clock in ms (the time of the newest tick), so "5 min ago" is right whatever the player's own clock says. */
  nowMs: number;
  onTicker?: (ticker: string) => void;
  emptyText?: string;
}

export function NewsList({ items, nowMs, onTicker, emptyText }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  if (items.length === 0) return <p className="hint">{emptyText ?? 'No news yet.'}</p>;
  return (
    <ul className="news-list">
      {items.map((n) => {
        const expanded = open === n.id;
        const arrow = n.direction === 'positive' ? '▲' : n.direction === 'negative' ? '▼' : '◆';
        return (
          <li key={n.id} className={`news-item dir-${n.direction}${n.breaking ? ' is-breaking' : ''}`} data-news-id={n.id}>
            <div className="news-meta">
              {n.breaking && <span className="badge-breaking">BREAKING</span>}
              <span className="news-cat">{n.categoryLabel}</span>
              {n.ticker && onTicker ? (
                <button type="button" className="link-btn news-ticker" onClick={() => onTicker(n.ticker as string)}>
                  {n.ticker}
                </button>
              ) : (
                n.ticker && <span className="news-ticker">{n.ticker}</span>
              )}
              {n.partnerTicker && <span className="news-partner">with {n.partnerTicker}</span>}
              {!n.ticker && n.sectorName && <span className="news-partner">{n.sectorName}</span>}
              {!n.ticker && !n.sectorName && <span className="news-partner">Whole market</span>}
              <span className="news-time">{timeAgo(n.publishedMs, nowMs)}</span>
            </div>
            <button type="button" className="news-headline" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : n.id)}>
              <span className={`news-arrow dir-${n.direction}`} aria-hidden="true">
                {arrow}
              </span>
              {n.headline}
            </button>
            <div className="news-tags">
              <span className={`tag dir-${n.direction}`}>{DIRECTION_LABEL[n.direction]}</span>
              <span className="tag">{STRENGTH_LABEL[n.strength]}</span>
              {n.outcome && (
                <span className={`tag outcome ${toneOf(n.outcome.changeBps)}`} title="Price when the story came out, and after its effect was over">
                  Price afterwards {formatBps(n.outcome.changeBps)}
                </span>
              )}
            </div>
            {expanded && <p className="news-body">{n.body}</p>}
          </li>
        );
      })}
    </ul>
  );
}
