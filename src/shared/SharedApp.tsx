// The whole game: Career (the market and your account), 1v1 battles, and News. All three use the one permanent market that the
// server runs, with the same companies. If the server cannot be reached, nothing is invented; the screen says so.
import { useEffect, useRef, useState } from 'react';
import { Header, type Mode } from '../ui/Header';
import { AccountScreen } from './AccountScreen';
import { AdminScreen } from './AdminScreen';
import { AwayCard } from './AwayCard';
import { CallBar } from './CallBar';
import { careerLocked, modeShown } from './careerLock';
import { ChallengeBanner } from './Challenges';
import { ChatScreen } from './ChatScreen';
import { CompanyView } from './CompanyView';
import { BillboardStrip } from './BillboardStrip';
import { DailyQuoteCard } from './DailyQuoteCard';
import { EventsStrip } from './EventsStrip';
import { clockTime } from './format';
import { predictOpen, usePredict } from './extrasStore';
import { goalsWaiting } from './goalUtil';
import { useGoals } from './goalsStore';
import { GoalsScreen } from './GoalsScreen';
import { LaunchScreen } from './LaunchScreen';
import { LearnScreen } from './LearnScreen';
import { learnSeen } from './learnUtil';
import { LobbyScreen } from './LobbyScreen';
import { MarketScreen } from './MarketScreen';
import { ModScreen } from './ModScreen';
import { MessagesScreen } from './MessagesScreen';
import { pmBadge } from './messagesUtil';
import { NewsList } from './NewsList';
import { NewsScreen } from './NewsScreen';
import { PlayersScreen } from './PlayersScreen';
import { Notices } from './Notices';
import { EarningsScreen } from './EarningsScreen';
import { Toasts } from './Toasts';
import { ProfileCard } from './ProfileCard';
import { ProfileMenu } from './ProfileMenu';
import { ShopScreen } from './ShopScreen';
import { TeamsScreen } from './TeamsScreen';
import { BadgeUnlockLayer } from './BadgeUnlock';
import { WinBurstLayer } from './WinBurst';
import { sharedStore, useShared } from './store';

type CareerTab = 'market' | 'coins' | 'earnings' | 'launch' | 'goals' | 'learn' | 'players' | 'teams' | 'chat' | 'messages' | 'shop' | 'account';
const CAREER_TABS: [CareerTab, string][] = [
  ['market', 'Market'],
  ['coins', 'Memecoins'],
  ['goals', 'Goals'],
  ['earnings', 'Earnings'],
  ['launch', 'Launch'],
  ['learn', 'Learn'],
  ['players', 'Players'],
  ['teams', 'Teams'],
  ['chat', 'Chat'],
  ['messages', 'Messages'],
  ['shop', 'Shop'],
  ['account', 'My account'],
];

export function SharedApp({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) {
  const s = useShared();
  const [chosenTab, setCareerTab] = useState<CareerTab>('market');
  const [ticker, setTicker] = useState<string | null>(null);
  // A small "New" mark on the Learn tab until this browser has opened it once.
  const [learnNew, setLearnNew] = useState<boolean>(() => !learnSeen());
  // A company the player asked for (a news story, the breaking banner) while Career is closed: it opens inside his match instead, once.
  const [matchJump, setMatchJump] = useState<{ ticker: string } | null>(null);

  useEffect(() => {
    sharedStore.start();
  }, []);

  // While the player's own match is starting or running (and he has not forfeited it) Career is closed: the server refuses Career orders then
  // (docs/world.md §9.12), and here its button and tabs are gone. Anything that would open Career shows the 1v1 screen.
  const inBattle = s.match && (s.match.phase === 'countdown' || s.match.phase === 'live');
  const locked = careerLocked(s.match);
  const shown = modeShown(mode, locked);
  useEffect(() => {
    if (mode === 'career' && locked) onMode('battle');
  }, [mode, locked, onMode]);
  useEffect(() => {
    if (!inBattle) setMatchJump(null);
  }, [inBattle]);

  /** Opens a company in Career, from wherever the player is (a news story, a holding...); inside his match while Career is closed. */
  const openCompany = (t: string) => {
    if (locked) {
      setMatchJump({ ticker: t });
      onMode('battle');
      window.scrollTo?.(0, 0);
      return;
    }
    setTicker(t);
    // A memecoin opens inside the Memecoins tab, a stock inside the Market tab.
    setCareerTab(s.companies.find((c) => c.ticker === t)?.sector === 'meme' ? 'coins' : 'market');
    onMode('career');
    window.scrollTo?.(0, 0);
  };

  // "Message" next to a player's name (Players, Chat) opens the Messages tab with that player ready.
  useEffect(() => {
    if (s.pmCompose !== null && !locked) {
      setCareerTab('messages');
      onMode('career');
      window.scrollTo?.(0, 0);
    }
  }, [s.pmCompose, locked, onMode]);

  const goSignIn = () => {
    setCareerTab('account');
    onMode('career');
  };

  const goGoals = () => {
    setCareerTab('goals');
    onMode('career');
    window.scrollTo?.(0, 0);
  };

  const goShop = () => {
    setCareerTab('shop');
    onMode('career');
    window.scrollTo?.(0, 0);
  };

  // The admin panel belongs to the owner. If the player is not the owner (logged out, or never was), leave it.
  const isOwner = s.user?.role === 'owner';
  useEffect(() => {
    if (mode === 'admin' && s.authChecked && !isOwner) onMode('career');
  }, [mode, s.authChecked, isOwner, onMode]);
  // The moderators' page belongs to the moderators the owner chose. If the player is not one (any more), leave it.
  const isMod = s.user?.role === 'moderator';
  useEffect(() => {
    if (mode === 'mod' && s.authChecked && !isMod) onMode('career');
  }, [mode, s.authChecked, isMod, onMode]);

  // A friend said yes (or you did), or both of you asked for a rematch: the lobby of the two of you opens on the 1v1 screen once, wherever you were.
  // A friend match, and a rematch (docs/world.md §35), open the lobby the same way: the first time it is waiting for the player's Ready.
  const friendLobbyId = s.match && s.match.friendMatch && s.match.phase === 'ready_check' ? s.match.id : s.match && s.match.isRematch && s.match.phase === 'ready_check' ? s.match.id : 0;
  const openedLobby = useRef(0);
  useEffect(() => {
    if (friendLobbyId !== 0 && openedLobby.current !== friendLobbyId) {
      openedLobby.current = friendLobbyId;
      onMode('battle');
      window.scrollTo?.(0, 0);
    }
  }, [friendLobbyId, onMode]);

  // (While a match is starting or running Career is closed altogether, so there is no Launch tab to hide then either.)
  const careerTab: CareerTab = chosenTab;
  const careerTabs = CAREER_TABS;
  // Friend requests waiting for an answer: shown as a number on the Players tab.
  const requests = s.friends?.incoming.length ?? 0;
  // Daily goals still open, plus free looks waiting to be chosen: shown as a number on the Goals tab.
  const { view: goalsView } = useGoals();
  // Today's daily prediction counts as one more thing to do until the guess is made.
  const { view: predictView, nowMs: predictNow } = usePredict();
  const goalsOpen = goalsWaiting(goalsView) + (predictOpen(predictView, predictNow) ? 1 : 0);
  // Chat messages from other players that arrived while the Chat tab was not open.
  const unread = s.chat?.unread ?? 0;
  // Private messages not read yet, plus message requests and group invitations waiting for an answer.
  const privateWaiting = pmBadge(s.messages);
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
      <Header mode={shown} onMode={onMode} subtitle={subtitle} hidden={locked ? ['career'] : []}>
        <ProfileMenu
          onAccount={goSignIn}
          onShop={goShop}
          onAdmin={() => {
            onMode('admin');
            window.scrollTo?.(0, 0);
          }}
          onMod={() => {
            onMode('mod');
            window.scrollTo?.(0, 0);
          }}
          onLoggedOut={() => {
            if (mode === 'admin' || mode === 'mod') onMode('career');
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
      <AwayCard onGoals={goGoals} />
      <ChallengeBanner />
      <Toasts />
      <CallBar />
      <WinBurstLayer />
      <BadgeUnlockLayer />
      <ProfileCard onShop={goShop} />

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

      {friendLobbyId !== 0 && shown !== 'battle' && (
        <p className="notice info battle-notice" role="status" data-testid="friend-lobby-notice">
          Your {s.match?.isRematch ? 'rematch' : 'friend match'} is waiting for you to press Ready.{' '}
          <button type="button" className="link-btn" onClick={() => onMode('battle')}>
            Go to the match
          </button>
        </p>
      )}

      {inBattle && shown !== 'battle' && (
        <p className="notice info battle-notice" role="status">
          Your 1v1 match is {s.match?.phase === 'live' ? 'live' : 'about to start'}.{' '}
          <button type="button" className="link-btn" onClick={() => onMode('battle')}>
            Go to the match
          </button>
        </p>
      )}

      {shown === 'career' && (
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
                if (id === 'learn') setLearnNew(false);
                if (id === 'market' || id === 'coins') setTicker(null);
              }}
              data-testid={`tab-${id}`}
            >
              {label}
              {id === 'learn' && learnNew && (
                <span className="tab-new" data-testid="learn-new">
                  New
                </span>
              )}
              {id === 'goals' && goalsOpen > 0 && (
                <span className="tab-count" data-testid="goals-badge" aria-label={`${goalsOpen} daily goal${goalsOpen === 1 ? '' : 's'} or free look${goalsOpen === 1 ? '' : 's'} waiting`}>
                  {goalsOpen}
                </span>
              )}
              {id === 'chat' && unread > 0 && (
                <span className="tab-count" data-testid="chat-badge" aria-label={`${unread} new chat message${unread === 1 ? '' : 's'}`}>
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
              {id === 'messages' && privateWaiting > 0 && (
                <span className="tab-count" data-testid="messages-badge" aria-label={`${privateWaiting} private message${privateWaiting === 1 ? '' : 's'} waiting`}>
                  {privateWaiting > 99 ? '99+' : privateWaiting}
                </span>
              )}
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
        {shown === 'career' && (careerTab === 'market' || careerTab === 'coins') && (ticker ? (
            <CompanyView ticker={ticker} onBack={() => setTicker(null)} onTicker={openCompany} />
          ) : (
            <>
              <BillboardStrip onOpen={openCompany} onBook={() => setCareerTab('launch')} />
              {s.user && <EventsStrip onOpen={openCompany} />}
              {careerTab === 'market' && <DailyQuoteCard />}
              <MarketScreen key={careerTab} kind={careerTab === 'coins' ? 'coins' : 'stocks'} onOpen={openCompany} selected={ticker} />
            </>
          ))}
        {shown === 'career' && careerTab === 'earnings' && <EarningsScreen onOpen={openCompany} />}
        {shown === 'career' && careerTab === 'launch' && <LaunchScreen onOpen={openCompany} />}
        {shown === 'career' && careerTab === 'goals' && <GoalsScreen />}
        {shown === 'career' && careerTab === 'learn' && <LearnScreen />}
        {shown === 'career' && careerTab === 'players' && <PlayersScreen />}
        {shown === 'career' && careerTab === 'teams' && <TeamsScreen />}
        {shown === 'career' && careerTab === 'chat' && <ChatScreen />}
        {shown === 'career' && careerTab === 'messages' && <MessagesScreen />}
        {shown === 'career' && careerTab === 'shop' && <ShopScreen />}
        {shown === 'career' && careerTab === 'account' && <AccountScreen onOpen={openCompany} />}
        {shown === 'battle' && <LobbyScreen onGoSignIn={goSignIn} jump={matchJump} onJumpDone={() => setMatchJump(null)} />}
        {shown === 'news' && <NewsScreen onTicker={openCompany} />}
        {mode === 'admin' && isOwner && <AdminScreen />}
        {mode === 'mod' && isMod && <ModScreen />}
      </main>

      <footer className="footer">
        Simulated market for education only. Every company, person and news story is fictional and generated; prices are not real market
        data and there is no real money. The market runs on the server and never restarts.
        {s.health ? ` Market tick ${s.tick.toLocaleString()}.` : ''}
      </footer>
    </div>
  );
}
