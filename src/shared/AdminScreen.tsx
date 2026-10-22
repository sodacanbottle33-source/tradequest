// The owner's admin panel. It is opened from the profile menu and only works for the owner: the server refuses everybody else,
// whatever this page does.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';
import { AdminLog } from './AdminLog';
import { AdminMarket } from './AdminMarket';
import { AdminPlayers } from './AdminPlayers';
import { AdminLaunches } from './AdminLaunches';
import { AdminStocks } from './AdminStocks';
import type { AdminState } from './types';

type Tab = 'market' | 'players' | 'stocks' | 'launches' | 'log';
const TABS: [Tab, string][] = [
  ['market', 'Market'],
  ['players', 'Players'],
  ['stocks', 'Create stock'],
  ['launches', 'Launches'],
  ['log', 'Log'],
];

export function AdminScreen() {
  const [tab, setTab] = useState<Tab>('market');
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const queryRef = useRef(query);
  queryRef.current = query;

  const reload = useCallback(async () => {
    try {
      setState(await api.adminState(queryRef.current ?? ''));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), 5000);
    return () => clearInterval(id);
  }, [reload]);

  // Searching players asks the server again, a moment after the typing stops.
  useEffect(() => {
    const id = setTimeout(() => void reload(), 250);
    return () => clearTimeout(id);
  }, [query, reload]);

  return (
    <div className="admin-screen" data-testid="admin-screen">
      <section className="card admin-banner">
        <h2>
          Admin panel <span className="badge-owner">Owner</span>
        </h2>
        <p className="hint">These tools change the live market for every player. Price moves cannot be undone. Everything you do is written to the log.</p>
      </section>
      {error && (
        <p className="notice error" role="alert" data-testid="admin-error">
          {error}
        </p>
      )}
      <nav className="tabs" role="tablist" aria-label="Admin sections">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)} data-testid={`admin-tab-${id}`}>
            {label}
          </button>
        ))}
      </nav>
      {tab === 'market' && <AdminMarket state={state} reload={reload} />}
      {tab === 'players' && <AdminPlayers state={state} query={query} onQuery={setQuery} reload={reload} />}
      {tab === 'stocks' && <AdminStocks state={state} reload={reload} />}
      {tab === 'launches' && <AdminLaunches state={state} />}
      {tab === 'log' && <AdminLog state={state} />}
    </div>
  );
}
