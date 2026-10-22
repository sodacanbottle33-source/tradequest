// The earnings calendar: who reports in the next hours (with what analysts expect) and who has just reported (with how it went and how the price took it).
import { useEffect, useState } from 'react';
import { api } from './api';
import { ReportRow } from './EarningsPanel';
import { formatEps, formatRevenue, formatUntil } from './format';
import { useShared } from './store';
import type { EarningsCalendar } from './types';

export function EarningsScreen({ onOpen }: { onOpen: (ticker: string) => void }) {
  const { tickMs, news, conn } = useShared();
  const [data, setData] = useState<EarningsCalendar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  // A report that comes out over the live stream means the calendar has changed.
  const newest = news.find((n) => n.category === 'earnings')?.id ?? 0;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const load = () =>
      api
        .earnings(hours)
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
  }, [hours, newest]);

  return (
    <div className="earnings-screen">
      <section className="card" aria-label="Earnings calendar">
        <div className="market-head">
          <h2>
            Earnings <span className="h2-note">every company reports once every 3 days</span>
          </h2>
          <div className="filters">
            <select className="qty-input" aria-label="How far to look" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              <option value={6}>6 hours</option>
              <option value={24}>24 hours</option>
              <option value={72}>3 days</option>
            </select>
          </div>
        </div>
        {error && (
          <p className="notice error" role="alert">
            Could not load the earnings: {error}
          </p>
        )}
        {!error && conn === 'offline' && <p className="notice info">The server is not reachable, so the calendar cannot update right now.</p>}
        <p className="hint">
          A company's report says what it earned against what analysts expected. A beat usually lifts the price and a miss usually drops it, and the move can be big. The date and the expectations are known in advance; the result is not.
        </p>
        <h3>Coming up</h3>
        {data && data.upcoming.length === 0 && <p className="hint">No company reports in the next {hours} hours.</p>}
        {data && data.upcoming.length > 0 && (
          <div className="table-wrap">
            <table className="trades" aria-label="Upcoming reports">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>When</th>
                  <th>Quarter</th>
                  <th className="num">Expected profit per share</th>
                  <th className="num">Expected revenue</th>
                </tr>
              </thead>
              <tbody>
                {data.upcoming.map((u) => (
                  <tr key={`${u.ticker}-${u.cycle}`} data-testid={`upcoming-${u.ticker}`}>
                    <td>
                      <button type="button" className="link-btn" onClick={() => onOpen(u.ticker)}>
                        <strong>{u.ticker}</strong>
                      </button>{' '}
                      <span className="muted">{u.name}</span>
                    </td>
                    <td>
                      {formatUntil(u.publishedMs, tickMs)} <span className="muted sub">{new Date(u.publishedMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                    </td>
                    <td>{u.label}</td>
                    <td className="num mono">{formatEps(u.epsConsMills)}</td>
                    <td className="num mono">{formatRevenue(u.revConsDollars)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3>Just reported</h3>
        {data && data.recent.length === 0 && <p className="hint">No company has reported in the last {hours} hours.</p>}
        {data && data.recent.length > 0 && (
          <div className="table-wrap">
            <table className="trades" aria-label="Recent reports">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Quarter</th>
                  <th>Result</th>
                  <th className="num">Profit per share</th>
                  <th className="num">Revenue</th>
                  <th className="num">Price after</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => (
                  <ReportRow key={r.newsId} r={r} nowMs={tickMs} lead={{ ticker: r.ticker, name: r.name }} onTicker={onOpen} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
