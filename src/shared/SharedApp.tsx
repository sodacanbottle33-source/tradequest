// The whole game: Career (the market and your account), 1v1 battles, and News. All three use the one permanent market that the
// server runs, with the same companies. If the server cannot be reached, nothing is invented; the screen says so.
import { useEffect, useState } from 'react';
import { Header, type Mode } from '../ui/Header';
import { AccountScreen } from './AccountScreen';
import { AdminScreen } from './AdminScreen';
import { CompanyView } from './CompanyView';
import { clockTime } from './format';
import { LaunchScreen } from './LaunchScreen';
import { LobbyScreen } from './LobbyScreen';
import { MarketScreen } from './MarketScreen';
import { NewsList } from './NewsList';
import { NewsScreen } from './NewsScreen';
import { PlayersScreen } from './PlayersScreen';
import { Notices } from './Notices';
import { EarningsScreen } from './EarningsScreen';
import { Toasts } from './Toasts';
import { ProfileMenu } from './ProfileMenu';
import { sharedStore, useShared } from './store';

type CareerTab = 'market' | 'coins' | 'earnings' | 'launch' | 'players' | 'account';
const CAREER_TABS: [CareerTab, string][] = [
  ['market', 'Market'],
  ['coins', 'Memecoins'],
  ['earnings', 'Earnings'],
  ['launch', 'Launch'],
  ['players', 'Players'],
  ['account', 'My account'],
];

export function SharedApp({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) {
  const s = useShared();
  const [chosenTab, setCareerTab] = useState<CareerTab>('market');
  const [ticker, setTicker] = useState<string | null>(null);

  useEffect(() => {
    sharedStore.start();
  }, []);

  /** Opens a company in Career, from wherever the player is (a news story, a holding...). */
  const openCompany = (t: string) => {
    setTicker(t);
    // A memecoin opens inside the Memecoins tab, a stock inside the Market tab.
    setCareerTab(s.companies.find((c) => c.ticker === t)?.sector === 'meme' ? 'coins' : 'market');
    onMode('career');
    window.scrollTo?.(0, 0);
  };

  const goSignIn = () => {
    setCareerTab('account');
    onMode('career');
  };

  // The admin panel belongs to the owner. If the player is not the owner (logged out, or never was), leave it.
  const isOwner = s.user?.role === 'owner';
  useEffect(() => {
    if (mode === 'admin' && s.authChecked && !isOwner) onMode('career');
  }, [mode, s.authChecked, isOwner, onMode]);

  const inBattle = s.match && (s.match.phase === 'countdown' || s.match.phase === 'live');
  // While a match is starting or running (and you have not forfeited it) there is no Launch tab: nothing can be launched then.
  const launchLocked = Boolean(inBattle) && !s.match?.players.find((p) => p.you)?.forfeited;
  const careerTab: CareerTab = chosenTab === 'launch' && launchLocked ? 'market' : chosenTab;
  const careerTabs = CAREER_TABS.filter(([id]) => id !== 'launch' || !launchLocked);
  // Friend requests waiting for an answer: shown as a number on the Players tab.
  const requests = s.friends?.incoming.length ?? 0;
  const listed = s.companies.filter((c) => c.trading).length;
  const stockCount = s.companies.filter((c) => c.sector !== 'meme').length;
  const coinCount = s.companies.length - stockCount;
  const subtitle =
    s.conn === 'online' ? (
      <>
        <span className="ticker">{s.companies.length > 0 ? `${stockCount} companies${coinCount > 0 ? ` · ${coinCount} coins` : ''}` : 'TradeQuest'}</span>
        <span className="company">
          {listed > 0 ? `${listed} trading · ` : ''}market time {s.tickMs > 0 ? clockTime(s.tickMs) : '…'}
        </span>
      </>
    ) : (
      <span className="company">fictional companies · virtual money</span>
    );

  return (
    <div className="app shared-app">
      <Header mode={mode} onMode={onMode} subtitle={subtitle}>
        <ProfileMenu
          onAccount={goSignIn}
          onAdmin={() => {
            onMode('admin');
            window.scrollTo?.(0, 0);
          }}
          onLoggedOut={() => {
            if (mode === 'admin') onMode('career');
          }}
        />
      </Header>

      {s.conn !== 'online' && (
        <section className="card offline-card" role="alert" data-testid="offline">
          <h2>{s.conn === 'connecting' && !s.authChecked ? 'Connecting to the market…' : 'The market is not reachable'}</h2>
          {s.conn === 'offline' && (
            <>
              <p>{s.problem ?? 'The TradeQuest server did not answer.'}</p>
              <p className="hint">
                The market runs on the TradeQuest server (<code>npm run server</code>). Nothing is invented while it is away: no prices,
                no news and no 1v1 lobby. This page reconnects by itself.
              </p>
            </>
          )}
        </section>
      )}

      <Notices />
      <Toasts />

      {s.health && s.health.stalled && (
        <p className="notice error" role="alert">
          The market is paused by the server: {s.health.stalled}
        </p>
      )}
      {s.health && !s.health.stalled && s.health.catchingUp && (
        <p className="notice info" role="status">
          The market is catching up after downtime ({s.health.lagTicks} s behind). Prices are exactly what they would have been; trading opens when it has caught up.
        </p>
      )}

      {s.breaking && (
        <aside className="breaking-banner" role="status" aria-live="polite" data-testid="breaking">
          <NewsList items={[s.breaking]} nowMs={s.tickMs} onTicker={openCompany} />
          <button type="button" className="btn btn-small btn-ghost" onClick={() => sharedStore.closeBreaking()}>
            Dismiss
          </button>
        </aside>
      )}

      {inBattle && mode !== 'battle' && (
        <p className="notice info battle-notice" role="status">
          Your 1v1 match is {s.match?.phase === 'live' ? 'live' : 'about to start'}.{' '}
          <button type="button" className="link-btn" onClick={() => onMode('battle')}>
            Go to the match
          </button>
        </p>
      )}

      {mode === 'career' && (
        <nav className="tabs" role="tablist" aria-label="Career sections">
          {careerTabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={careerTab === id}
              className={careerTab === id ? 'tab active' : 'tab'}
              onClick={() => {
                setCareerTab(id);
                if (id === 'market' || id === 'coins') setTicker(null);
              }}
              data-testid={`tab-${id}`}
            >
              {label}
              {id === 'players' && requests > 0 && (
                <span className="tab-count" data-testid="players-badge" aria-label={`${requests} friend request${requests === 1 ? '' : 's'}`}>
                  {requests}
                </span>
              )}
            </button>
          ))}
        </nav>
      )}

      <main className="shared-main">
        {mode === 'career' && (careerTab === 'market' || careerTab === 'coins') && (ticker ? <CompanyView ticker={ticker} onBack={() => setTicker(null)} onTicker={openCompany} /> : <MarketScreen key={careerTab} kind={careerTab === 'coins' ? 'coins' : 'stocks'} onOpen={openCompany} selected={ticker} />)}
        {mode === 'career' && careerTab === 'earnings' && <EarningsScreen onOpen={openCompany} />}
        {mode === 'career' && careerTab === 'launch' && <LaunchScreen onOpen={openCompany} />}
        {mode === 'career' && careerTab === 'players' && <PlayersScreen />}
        {mode === 'career' && careerTab === 'account' && <AccountScreen onOpen={openCompany} />}
        {mode === 'battle' && <LobbyScreen onGoSignIn={goSignIn} />}
        {mode === 'news' && <NewsScreen onTicker={openCompany} />}
        {mode === 'admin' && isOwner && <AdminScreen />}
      </main>

      <footer className="footer">
        Simulated market for education only. Every company, person and news story is fictional and generated; prices are not real market
        data and there is no real money. The market runs on the server and never restarts.
        {s.health ? ` Market tick ${s.tick.toLocaleString()}.` : ''}
      </footer>
    </div>
  );
}
