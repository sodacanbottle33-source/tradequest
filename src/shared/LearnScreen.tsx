// Learn: a step-by-step tutorial (no AI, works without an account) and practice lessons (a made-up chart, your decision, then what happened and why).
// The server makes every lesson, keeps what happens next hidden until the answer is in, and grades the answer itself (docs/world.md §19);
// this page only shows what it is given. Nothing here can change a grade or give XP.
import { useCallback, useEffect, useState } from 'react';
import type { LearnState, LearnProgress } from '../learn/wire';
import { TUTORIAL_STEPS } from '../learn/tutorial';
import { api } from './api';
import { AuthPanel } from './AuthPanel';
import { defaultView, markLearnSeen, tutorialLabel, type LearnView } from './learnUtil';
import { LessonsView } from './LessonsView';
import { problemText } from './playersUtil';
import { useShared } from './store';
import { TutorialView } from './TutorialView';

function ProgressBar({ progress }: { progress: LearnProgress }) {
  const pct = Math.min(100, Math.max(0, Math.round((progress.xpInLevel * 100) / progress.xpPerLevel)));
  return (
    <section className="card learn-progress" aria-label="Your progress" data-testid="learn-progress">
      <div className="learn-level">
        <strong data-testid="learn-level">
          Level {progress.level} · {progress.title}
        </strong>
        <span className="muted" data-testid="learn-xp">
          {progress.xp} XP
        </span>
      </div>
      <div className="xp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={progress.xpPerLevel} aria-valuenow={progress.xpInLevel} aria-label="XP to the next level">
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="hint">
        {progress.xpPerLevel - progress.xpInLevel} XP to level {progress.level + 1}
        {progress.streak > 0 ? ` · streak of ${progress.streak} good answer${progress.streak === 1 ? '' : 's'}` : ''}
        {progress.bestStreak > 1 ? ` (best ${progress.bestStreak})` : ''}
      </p>
    </section>
  );
}

export function LearnScreen() {
  const { user } = useShared();
  const name = user?.username ?? null;
  const [state, setState] = useState<LearnState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<LearnView | null>(null);

  useEffect(() => {
    markLearnSeen();
  }, []);

  // (Re)load the player's progress when he signs in or out.
  const load = useCallback(() => {
    setProblem(null);
    return api.learnState().then(setState, (e: unknown) => setProblem(problemText(e)));
  }, []);
  useEffect(() => {
    setState(null);
    setProblem(null);
    setSaveProblem(null);
    setChosen(null);
    if (name === null) return;
    let alive = true;
    api.learnState().then(
      (s) => alive && setState(s),
      (e: unknown) => alive && setProblem(problemText(e)),
    );
    return () => {
      alive = false;
    };
  }, [name]);

  const loading = name !== null && state === null && problem === null;
  const view: LearnView = chosen ?? (state ? defaultView(state.progress.tutorialSteps, TUTORIAL_STEPS, state.progress.lessonsDone) : 'tutorial');
  const doneSteps = state?.progress.tutorialSteps ?? [];

  const saveStep = (step: number) => {
    if (name === null) return;
    setSaveProblem(null);
    api.learnTutorial(step).then(
      (r) => setState((s) => (s ? { ...s, progress: r.progress } : s)),
      (e: unknown) => setSaveProblem(problemText(e)),
    );
  };

  return (
    <div className="learn-layout" data-testid="learn-screen">
      {state && <ProgressBar progress={state.progress} />}

      <div className="seg-group" role="group" aria-label="Learn sections">
        <button type="button" className={view === 'lessons' ? 'seg active' : 'seg'} aria-pressed={view === 'lessons'} onClick={() => setChosen('lessons')} data-testid="learn-view-lessons">
          Lessons
        </button>
        <button type="button" className={view === 'tutorial' ? 'seg active' : 'seg'} aria-pressed={view === 'tutorial'} onClick={() => setChosen('tutorial')} data-testid="learn-view-tutorial">
          {tutorialLabel(doneSteps, TUTORIAL_STEPS)}
        </button>
      </div>

      {problem !== null && (
        <p className="notice error" role="alert" data-testid="learn-error">
          {problem}{' '}
          <button type="button" className="link-btn" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}
      {saveProblem !== null && (
        <p className="notice error" role="alert" data-testid="learn-save-error">
          Your tutorial progress could not be saved: {saveProblem}
        </p>
      )}

      {loading && <p className="muted" role="status">Loading…</p>}

      {!loading && view === 'tutorial' && <TutorialView done={doneSteps} signedIn={name !== null} onStepDone={saveStep} onGoLessons={() => setChosen('lessons')} />}

      {!loading && view === 'lessons' && name === null && (
        <>
          <section className="card" data-testid="learn-signin">
            <h2>Lessons</h2>
            <p>
              Each lesson shows you a made-up chart and asks what you would do. Then you see what happened next and why. Your XP and level are saved on your account,
              so you need to sign in. The tutorial works without one.
            </p>
          </section>
          <AuthPanel />
        </>
      )}

      {!loading && view === 'lessons' && name !== null && state && (
        <LessonsView
          state={state}
          onState={(patch) => setState((s) => (s ? { ...s, ...patch } : s))}
          onRefresh={load}
          tutorialDone={doneSteps.length}
          onGoTutorial={() => setChosen('tutorial')}
        />
      )}
    </div>
  );
}
