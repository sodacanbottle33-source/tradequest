// The "Launches" tab: every stock and memecoin that a player launched (Launch tab in Career), who launched it, what he put in, what he holds of it
// now and what his rug pulls so far brought in. Read only: the owner can halt a company in the Market tab (a halted company cannot be rug pulled),
// but a launch is never deleted.
import { formatCents } from './format';
import type { AdminLaunch, AdminState } from './types';

function statusOf(l: AdminLaunch): string {
  if (l.pool?.dead) return 'Rug pulled (dead)';
  if (l.halted) return 'Trading stopped';
  if (!l.trading) return 'Not trading yet';
  if (l.sharesNow === 0) return l.rugs > 0 ? 'Dumped' : l.stakeShares === 0 ? 'Trading' : 'Sold out';
  return 'Trading';
}

export function AdminLaunches({ state }: { state: AdminState | null }) {
  const launches = state?.launches ?? [];
  return (
    <section className="card" aria-label="Launches by players">
      <h2>
        Launched by players <span className="h2-note">{launches.length}</span>
      </h2>
      <p className="hint">
        Any signed-in player can launch a stock or a memecoin with his own Career cash (a memecoin costs a small launch fee and an optional first buy; a stock needs at least $100 put in and a $10 launch fee). A memecoin has a money pool: what buyers pay goes into it, sales are paid from it, and its developer can take all of it (a "rug pull"), which kills the coin. A stock's rug pull sells everything the player holds of it in one order. Players only see the developer name; you see the username here. Halt a company in the Market tab to stop trading in it,
        including a rug pull.
      </p>
      {state === null && <p className="hint">Loading…</p>}
      {state !== null && launches.length === 0 && (
        <p className="hint" data-testid="admin-launch-empty">
          Nobody has launched anything yet.
        </p>
      )}
      {launches.length > 0 && (
        <div className="table-wrap">
          <table className="trades" data-testid="admin-launch-list">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Name</th>
                <th>Kind</th>
                <th>Player</th>
                <th className="num">Put in</th>
                <th className="num">Started at</th>
                <th className="num">Now</th>
                <th className="num">Holds now</th>
                <th className="num">Pool</th>
                <th className="num">Rug pulls</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {launches.map((l) => (
                <tr key={l.id} data-testid={`admin-launch-row-${l.ticker}`}>
                  <td>
                    <strong>{l.ticker}</strong>
                  </td>
                  <td>{l.name}</td>
                  <td>{l.kind === 'coin' ? 'Memecoin' : 'Stock'}</td>
                  <td>{l.username}</td>
                  <td className="num">{formatCents(l.spentCents)}</td>
                  <td className="num">{formatCents(l.startPriceCents)}</td>
                  <td className="num">{l.trading ? formatCents(l.priceCents) : '–'}</td>
                  <td className="num">{l.sharesNow.toLocaleString('en-US')}</td>
                  <td className="num" data-testid={`admin-launch-pool-${l.ticker}`}>
                    {l.pool ? (l.pool.dead ? `taken (${formatCents(l.pool.drainedCents)})` : formatCents(l.pool.cents)) : '–'}
                  </td>
                  <td className="num">
                    {l.rugs === 0 ? '–' : l.pool ? `took ${formatCents(l.ruggedCents)}` : `${l.rugs} · ${l.ruggedShares.toLocaleString('en-US')} for ${formatCents(l.ruggedCents)}`}
                  </td>
                  <td>{statusOf(l)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
