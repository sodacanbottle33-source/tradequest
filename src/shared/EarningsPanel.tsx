// A company's earnings: its price/earnings ratio and profit per share, when it reports next (with what analysts expect), and what its last reports said.
import { useEffect, useState } from 'react';
import { api } from './api';
import { formatBps, formatEps, formatRevenue, formatSurprise, formatUntil, plainPercent, resultWord, timeAgo, toneOf } from './format';
import { useShared } from './store';
import type { CompanyEarnings, EarningsReport } from './types';

function clockOf(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** One report as a table row (a legacy story has no numbers: it shows its headline instead). */
export function ReportRow({ r, nowMs, lead, onTicker }: { r: EarningsReport; nowMs: number; lead?: { ticker: string; name: string }; onTicker?: (t: string) => void }) {
  const res = resultWord(r.kind);
  return (
    <tr data-testid={`report-${lead ? `${lead.ticker}-` : ''}${r.cycle}`}>
      {lead && (
        <td>
          <button type="button" className="link-btn" onClick={() => onTicker?.(lead.ticker)}>
            <strong>{lead.ticker}</strong>
          </button>{' '}
          <span className="muted">{lead.name}</span>
        </td>
      )}
      <td>
        {r.label || '—'} <span className="muted sub">{timeAgo(r.publishedMs, nowMs)}</span>
      </td>
      {r.kind === 'legacy' || r.epsMills === null || r.epsConsMills === null || r.epsBp === null || r.revDollars === null || r.revConsDollars === null ? (
        <td colSpan={4} className="muted">
          {r.headline}
        </td>
      ) : (
        <>
          <td>
            <span className={`tag ${res.tone}`}>{res.word}</span>
          </td>
          <td className="num mono">
            {formatEps(r.epsMills)}{' '}
            <span className="muted sub">
              vs {formatEps(r.epsConsMills)} expected · <span className={toneOf(r.epsBp)}>{formatSurprise(r.epsBp)}</span>
              {r.yoyBp !== null && Math.abs(r.yoyBp) >= 50 ? ` · ${r.yoyBp > 0 ? 'up' : 'down'} ${plainPercent(r.yoyBp)} on a year ago` : ''}
            </span>
          </td>
          <td className="num mono">
            {formatRevenue(r.revDollars)}{' '}
            <span className="muted sub">
              vs {formatRevenue(r.revConsDollars)} · <span className={toneOf(r.revBp ?? 0)}>{formatSurprise(r.revBp ?? 0)}</span>
            </span>
          </td>
          <td className={`num mono ${toneOf(r.reactionBps ?? 0)}`}>{r.reactionBps === null ? <span className="muted">moving…</span> : formatBps(r.reactionBps)}</td>
        </>
      )}
    </tr>
  );
}

export function EarningsPanel({ ticker }: { ticker: string }) {
  const { tickMs, news } = useShared();
  const [data, setData] = useState<CompanyEarnings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read again when a report of this company comes out.
  const newest = news.find((n) => n.category === 'earnings' && n.ticker === ticker)?.id ?? 0;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const load = () =>
      api
        .companyEarnings(ticker)
        .then((d) => {
          if (!cancelled) setData(d);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        });
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ticker, newest]);

  if (error) {
    return (
      <section className="card" aria-label="Earnings">
        <p className="notice error" role="alert">
          Could not load the earnings: {error}
        </p>
      </section>
    );
  }
  if (!data || !data.applies) return null;
  const next = data.next;
  return (
    <section className="card earnings-card" aria-label={`${data.ticker} earnings`} data-testid="earnings-card">
      <h2>
        Earnings <span className="h2-note">a fiscal quarter lasts {data.periodDays} days here</span>
      </h2>
      <dl className="stats">
        <div className="stat">
          <dt>Price / earnings</dt>
          <dd data-testid="pe-ratio">{data.peRatio === null ? '—' : data.peRatio.toFixed(1)}</dd>
        </div>
        <div className="stat">
          <dt>Profit per share, last 4 quarters</dt>
          <dd>{data.epsTtmMills === null ? '—' : formatEps(data.epsTtmMills)}</dd>
        </div>
        <div className="stat">
          <dt>Revenue, last 4 quarters</dt>
          <dd>{data.revenueTtmDollars === null ? '—' : formatRevenue(data.revenueTtmDollars)}</dd>
        </div>
        <div className="stat">
          <dt>Profit margin</dt>
          <dd>{data.netMarginBps === null ? '—' : `${(data.netMarginBps / 100).toFixed(1)}%`}</dd>
        </div>
      </dl>
      {next && (
        <p className="hint" data-testid="next-report">
          <strong>Next report ({next.label}):</strong> {formatUntil(next.publishedMs, tickMs)} ({clockOf(next.publishedMs)}). Analysts expect {formatEps(next.epsConsMills)} a share on {formatRevenue(next.revConsDollars)} of revenue. A report that beats what is expected usually
          lifts the price and a miss usually drops it, but not always.
        </p>
      )}
      {data.history.length === 0 ? (
        <p className="hint">{data.ticker} has not reported yet. Its reports will be listed here.</p>
      ) : (
        <div className="table-wrap">
          <table className="trades" aria-label="Last reports">
            <thead>
              <tr>
                <th>Quarter</th>
                <th>Result</th>
                <th className="num">Profit per share</th>
                <th className="num">Revenue</th>
                <th className="num">Price after</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((r) => (
                <ReportRow key={r.newsId} r={r} nowMs={tickMs} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
