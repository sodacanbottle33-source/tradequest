// Daily goals (docs/world.md §32): three goals a day (one from the market, one from learning, one from 1v1), a little XP, Career cash and 1v1 coins for each, a bonus for all
// three, a streak that grows with every day you finish a goal, freezes that cover a missed day, and a free look at 3, 7, 14 and 30 days. The server decides everything (what counts,
// what is paid, which looks you may take); this page shows what the server says and asks it to give a free look.
import { useState } from 'react';
import { api } from './api';
import { AuthPanel } from './AuthPanel';
import { cosmeticById } from './cosmeticCatalog';
import { FREEZE_EVERY, MAX_FREEZES, rewardText } from './goalCatalog';
import { barPercent, kindName, longUntil, lookName, streakNote } from './goalUtil';
import { goalsStore, useGoals } from './goalsStore';
import { problemText } from './playersUtil';
import { Sample } from './ShopScreen';
import { Skeleton } from './Skeleton';
import { useShared } from './store';
import type { GoalLine, GoalsView, MilestoneView } from './types';

function GoalRow({ goal }: { goal: GoalLine }) {
  const pct = barPercent(goal.progress, goal.target);
  return (
    <li className={`goal-row${goal.done ? ' is-done' : ''}`} data-testid={`goal-${goal.id}`} data-done={goal.done}>
      <span className="goal-icon" aria-hidden="true">
        {goal.done ? '✅' : goal.icon}
      </span>
      <div className="goal-body">
        <strong className="goal-title">{goal.title}</strong>
        <span className="goal-hint muted">{goal.hint}</span>
        <div className="goal-bar" role="progressbar" aria-label={goal.title} aria-valuemin={0} aria-valuemax={goal.target} aria-valuenow={goal.progress}>
          <span className="goal-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="goal-side">
        <span className="goal-count mono" data-testid={`goal-count-${goal.id}`}>
          {goal.progress}/{goal.target}
        </span>
        <span className="goal-reward muted">{goal.done ? 'Paid' : rewardText(goal.reward)}</span>
      </div>
    </li>
  );
}

function Picker({ milestone, onTaken }: { milestone: MilestoneView; onTaken: (view: GoalsView) => void }) {
  const { user } = useShared();
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = user?.displayName ?? 'You';
  const take = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onTaken(await api.claimGoal(milestone.days, id));
    } catch (e) {
      setError(problemText(e));
    } finally {
      setAsking(null);
      setBusy(false);
    }
  };
  const defs = milestone.choices.map((id) => cosmeticById(id)).filter((d) => d !== undefined);
  return (
    <div className="goal-picker" data-testid={`goal-picker-${milestone.days}`}>
      <p className="hint">Pick one. You can take only one look for this streak, and it is yours for good.</p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <ul className="shop-grid">
        {defs.map((def) => {
          const confirm = asking === def.id;
          return (
            <li className={`shop-item rar-${def.rarity}`} key={def.id} data-testid={`goal-choice-${def.id}`}>
              <div className="shop-sample-box">
                <Sample def={def} name={name} />
              </div>
              <div className="shop-item-info">
                <strong>{def.name}</strong>
                <span className="muted">{kindName(def.slot)}</span>
              </div>
              <div className="shop-item-act">
                {confirm ? (
                  <>
                    <button type="button" className="btn btn-small btn-buy" disabled={busy} onClick={() => void take(def.id)} data-testid={`goal-confirm-${def.id}`}>
                      Confirm
                    </button>
                    <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setAsking(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => setAsking(def.id)} data-testid={`goal-take-${def.id}`}>
                    Take
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function GoalsScreen() {
  const { user } = useShared();
  const { view, nowMs } = useGoals();
  const [open, setOpen] = useState<number | null>(null);
  if (!user) return <AuthPanel />;
  if (!view) {
    return (
      <section className="card goals-head" aria-label="Daily goals" data-testid="goals-loading">
        <h2>Daily goals</h2>
        <Skeleton />
      </section>
    );
  }
  const s = view.streak;
  const done = view.goals.filter((g) => g.done).length;
  const ready = view.milestones.filter((m) => m.state === 'ready');
  return (
    <div className="goals-layout" data-testid="goals-screen">
      <section className="card goals-head" aria-label="Streak">
        <h2>
          Daily goals <span className="h2-note">change {longUntil(view.endMs, nowMs)}</span>
        </h2>
        <div className={`streak-box${s.current > 0 ? ' alive' : ''}${s.atRisk ? ' at-risk' : ''}`} data-testid="streak-box">
          <span className="streak-flame" aria-hidden="true">
            {s.current > 0 ? '🔥' : '🕯️'}
          </span>
          <div className="streak-text">
            <strong className="streak-count" data-testid="streak-count">
              {s.current} day{s.current === 1 ? '' : 's'}
            </strong>
            <span className="muted">in a row · best {s.best}</span>
          </div>
          <div className="streak-freezes" data-testid="streak-freezes" aria-label={`${s.freezes} freeze${s.freezes === 1 ? '' : 's'}`}>
            {Array.from({ length: MAX_FREEZES }, (_, i) => (
              <span key={i} className={i < s.freezes ? 'freeze has' : 'freeze'} aria-hidden="true">
                ❄️
              </span>
            ))}
          </div>
        </div>
        <p className="hint" data-testid="streak-note">
          {streakNote(s)}
        </p>
        <p className="hint">
          A freeze covers one day you miss, so the streak goes on. You earn one every {FREEZE_EVERY} days in a row ({s.toFreeze > 0 ? `next in ${s.toFreeze} day${s.toFreeze === 1 ? '' : 's'}` : `you hold the most, ${MAX_FREEZES}`}).
        </p>
      </section>

      <section className="card" aria-label="Today's goals">
        <h3>
          Today <span className="h2-note">{done} of {view.goals.length} done</span>
        </h3>
        <ul className="goal-list">
          {view.goals.map((g) => (
            <GoalRow key={g.id} goal={g} />
          ))}
        </ul>
        <p className={`goal-bonus${view.bonus.paid ? ' is-done' : ''}`} data-testid="goal-bonus">
          <span aria-hidden="true">{view.bonus.paid ? '✅' : '🎁'}</span> Finish all {view.goals.length} for a bonus: <strong>{rewardText(view.bonus.reward)}</strong>
          {view.bonus.paid ? ' (paid today)' : ''}
        </p>
        <p className="hint">
          A goal is paid once, when the game sees it is done. The cash is yours to spend, but it does not count as growth on the weekly leaderboard. Goals never give an advantage in a trade or a match.
        </p>
      </section>

      <section className="card" aria-label="Streak rewards">
        <h3>
          Streak rewards <span className="h2-note">a free look each, once</span>
        </h3>
        {ready.length > 0 && (
          <p className="notice info" role="status" data-testid="goals-ready">
            You have {ready.length === 1 ? 'a free look' : `${ready.length} free looks`} to choose.
          </p>
        )}
        <ul className="milestone-list">
          {view.milestones.map((m) => {
            return (
              <li className={`milestone is-${m.state}`} key={m.days} data-testid={`milestone-${m.days}`} data-state={m.state}>
                <div className="milestone-head">
                  <span className="milestone-days">{m.days} days</span>
                  <span className={`rar-chip rar-${m.rarity}`}>{m.rarityName}</span>
                  <span className="milestone-state muted">
                    {m.state === 'claimed' ? `You took ${lookName(m.item)}` : m.state === 'ready' ? 'Ready to choose' : s.current > 0 ? `${Math.max(0, m.days - s.current)} more day${m.days - s.current === 1 ? '' : 's'}` : 'Locked'}
                  </span>
                  {m.state === 'ready' && (
                    <button type="button" className="btn btn-small btn-primary" onClick={() => setOpen(open === m.days ? null : m.days)} data-testid={`milestone-open-${m.days}`}>
                      {open === m.days ? 'Hide' : 'Choose'}
                    </button>
                  )}
                </div>
                {m.state === 'ready' && open === m.days && (
                  <Picker
                    milestone={m}
                    onTaken={(v) => {
                      goalsStore.setView(v);
                      setOpen(null);
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
