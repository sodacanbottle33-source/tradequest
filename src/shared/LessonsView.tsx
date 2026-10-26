// The practice lessons: a made-up chart, your decision, then what happened next and why.
// What this page does: asks the server for a lesson, sends the player's choice (and, if he wants, his reason), shows what comes back.
// What it never does: grade, pick the lesson, or see what happens next before the answer is in. All of that is the server's (docs/world.md §19).
import { useEffect, useRef, useState } from 'react';
import { lessonPrice } from '../learn/generate';
import { pctText } from '../learn/grade';
import type { AiStatus, CoachReply, LearnState, LessonResult, LessonView } from '../learn/wire';
import { api } from './api';
import { canExplain, coachNote, gradeBanner, goodPercent, readWhyPref, statText, weakSpots, writeWhyPref, xpText } from './learnUtil';
import { MiniChart } from './MiniChart';
import { problemText } from './playersUtil';

type Phase = { kind: 'idle' } | { kind: 'question'; lesson: LessonView } | { kind: 'result'; lesson: LessonView; result: LessonResult };

type Coach = { status: 'none' } | { status: 'loading' } | { status: 'ok'; text: string } | { status: 'note'; text: string } | { status: 'failed' };

const REASON_MAX = 300;

/** What the teacher's box shows for the server's answer. */
function coachOf(reply: CoachReply): Coach {
  if (reply.text) return { status: 'ok', text: reply.text };
  if (reply.reason === 'failed') return { status: 'failed' };
  const note = coachNote(reply.reason);
  return note ? { status: 'note', text: note } : { status: 'none' };
}

export interface LessonsViewProps {
  readonly state: LearnState;
  readonly onState: (patch: Partial<LearnState>) => void;
  /** Loads the player's progress and statistics again (after an answer). */
  readonly onRefresh: () => Promise<unknown>;
  readonly tutorialDone: number;
  readonly onGoTutorial: () => void;
}

function Stats({ state }: { state: LearnState }) {
  const weak = weakSpots(state.stats);
  return (
    <section className="card learn-stats" aria-label="How you are doing" data-testid="learn-stats">
      <h2>How you are doing</h2>
      {weak.length > 0 && (
        <p className="hint" data-testid="learn-weak">
          Come back to these: {weak.join(', ')}. The lessons show them more often.
        </p>
      )}
      <ul className="stat-list">
        {state.stats.map((s) => {
          const p = goodPercent(s);
          return (
            <li key={s.key} data-testid={`stat-${s.key}`}>
              <span className="stat-name">{s.name}</span>
              <span className="stat-bar" aria-hidden="true">
                <span style={{ width: `${p ?? 0}%` }} />
              </span>
              <span className="stat-text muted">{statText(s)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AiLine({ ai }: { ai: AiStatus }) {
  return (
    <p className="hint" data-testid="learn-ai-line">
      {ai.enabled
        ? `AI teacher is on: ${ai.leftToday} comment${ai.leftToday === 1 ? '' : 's'} left today.`
        : 'The game explains every lesson itself. An AI teacher can be turned on by the owner of this server.'}
    </p>
  );
}

export function LessonsView({ state, onState, onRefresh, tutorialDone, onGoTutorial }: LessonsViewProps) {
  const [phase, setPhase] = useState<Phase>(() => (state.open ? { kind: 'question', lesson: state.open } : { kind: 'idle' }));
  const [choice, setChoice] = useState<string | null>(null);
  const [why, setWhy] = useState<boolean>(() => readWhyPref());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [coach, setCoach] = useState<Coach>({ status: 'none' });
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const begin = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const lesson = await api.learnStart();
      setChoice(null);
      setReason('');
      setCoach({ status: 'none' });
      setPhase({ kind: 'question', lesson });
      window.scrollTo?.(0, 0);
    } catch (e) {
      setProblem(problemText(e));
    } finally {
      setBusy(false);
    }
  };

  const skip = async (lesson: LessonView) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.learnSkip(lesson.id);
      const next = await api.learnStart();
      setChoice(null);
      setReason('');
      setPhase({ kind: 'question', lesson: next });
    } catch (e) {
      setProblem(problemText(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (lesson: LessonView) => {
    if (busy || choice === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.learnAnswer(lesson.id, choice, why && canExplain(state.ai) ? reason.trim() : undefined);
      setCoach({ status: 'none' });
      setPhase({ kind: 'result', lesson, result });
      onState({ progress: result.progress, ai: result.ai, open: null });
      void onRefresh(); // the statistics changed too
    } catch (e) {
      setProblem(problemText(e));
    } finally {
      setBusy(false);
    }
  };

  // After an answer, the AI teacher (when it is on and the player has comments left) says what it thinks. The grade is already decided.
  const resultId = phase.kind === 'result' ? phase.result.lessonId : 0;
  const resultAi = phase.kind === 'result' ? phase.result.ai : null;
  const askCoach = async (lessonId: number) => {
    setCoach({ status: 'loading' });
    try {
      const reply = await api.learnCoach(lessonId);
      onState({ ai: reply.ai });
      setCoach(coachOf(reply));
    } catch {
      setCoach({ status: 'failed' });
    }
  };
  useEffect(() => {
    if (resultId === 0 || resultAi === null) return;
    headingRef.current?.focus();
    if (!resultAi.enabled) return;
    if (resultAi.leftToday <= 0) {
      setCoach({ status: 'note', text: coachNote('limit') ?? '' });
      return;
    }
    let alive = true;
    setCoach({ status: 'loading' });
    api.learnCoach(resultId).then(
      (reply) => {
        if (!alive) return;
        onState({ ai: reply.ai });
        setCoach(coachOf(reply));
      },
      () => alive && setCoach({ status: 'failed' }),
    );
    return () => {
      alive = false;
    };
    // Only when a new result arrives (the same lesson is never asked twice on this page).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultId]);

  const toggleWhy = (on: boolean) => {
    setWhy(on);
    writeWhyPref(on);
  };

  return (
    <div className="lessons" data-testid="lessons">
      {problem !== null && (
        <p className="notice error" role="alert" data-testid="lesson-error">
          {problem}
        </p>
      )}

      {phase.kind === 'idle' && (
        <section className="card lesson-intro" data-testid="lesson-intro">
          <h2>Lesson</h2>
          <p>
            You get a made-up chart of an invented company or coin. You decide: <strong>Buy</strong>, <strong>Short</strong> or <strong>Wait</strong>. Then you see what happened next and why.
            A wrong answer costs nothing. It only shows you what to look for.
          </p>
          {tutorialDone < 9 && (
            <p className="notice info" data-testid="lesson-tutorial-hint">
              New here? The tutorial explains the words first ({tutorialDone} of 9 steps done).{' '}
              <button type="button" className="link-btn" onClick={onGoTutorial}>
                Open the tutorial
              </button>
            </p>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void begin()} disabled={busy} data-testid="lesson-start">
            {busy ? 'Making a chart…' : state.progress.lessonsDone === 0 ? 'Start my first lesson' : 'Start a lesson'}
          </button>
          <AiLine ai={state.ai} />
        </section>
      )}

      {phase.kind === 'question' && (
        <QuestionCard
          lesson={phase.lesson}
          choice={choice}
          onChoice={setChoice}
          ai={state.ai}
          why={why}
          onWhy={toggleWhy}
          reason={reason}
          onReason={setReason}
          busy={busy}
          onSubmit={() => void submit(phase.lesson)}
          onSkip={() => void skip(phase.lesson)}
        />
      )}

      {phase.kind === 'result' && (
        <ResultCard
          lesson={phase.lesson}
          result={phase.result}
          coach={coach}
          onRetryCoach={() => void askCoach(phase.result.lessonId)}
          onNext={() => void begin()}
          busy={busy}
          headingRef={headingRef}
        />
      )}

      {phase.kind !== 'question' && <Stats state={state} />}
    </div>
  );
}

function QuestionCard({
  lesson,
  choice,
  onChoice,
  ai,
  why,
  onWhy,
  reason,
  onReason,
  busy,
  onSubmit,
  onSkip,
}: {
  lesson: LessonView;
  choice: string | null;
  onChoice: (id: string) => void;
  ai: AiStatus;
  why: boolean;
  onWhy: (on: boolean) => void;
  reason: string;
  onReason: (text: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onSkip: () => void;
}) {
  const fmt = (p: number) => lessonPrice(lesson.asset.kind, p);
  const explain = canExplain(ai);
  return (
    <section className="card lesson-card" data-testid="lesson-card" aria-label="Lesson">
      <p className="lesson-story" data-testid="lesson-story">
        {lesson.story}
      </p>
      <MiniChart candles={lesson.candles} format={fmt} label={`Chart of ${lesson.asset.name}, ${lesson.candles.length} candles. The last price is ${fmt((lesson.candles[lesson.candles.length - 1] as { c: number }).c)}.`} testId="lesson-chart" />
      <h3 className="lesson-question">{lesson.question}</h3>
      <div className="lesson-options" role="group" aria-label="Your choices">
        {lesson.options.map((o) => (
          <button key={o.id} type="button" className={choice === o.id ? 'lesson-option selected' : 'lesson-option'} aria-pressed={choice === o.id} onClick={() => onChoice(o.id)} disabled={busy} data-testid={`lesson-option-${o.id}`}>
            <strong>{o.label}</strong>
            <span className="muted">{o.detail}</span>
          </button>
        ))}
      </div>
      {explain && (
        <div className="lesson-why">
          <label className="check-row">
            <input type="checkbox" checked={why} onChange={(e) => onWhy(e.target.checked)} data-testid="lesson-why-toggle" /> Tell the AI teacher why I chose this (optional)
          </label>
          {why && (
            <>
              <textarea
                className="admin-text"
                rows={2}
                maxLength={REASON_MAX}
                value={reason}
                onChange={(e) => onReason(e.target.value)}
                placeholder="For example: the price keeps making higher lows, so I think it goes up."
                aria-label="Why did you choose this?"
                data-testid="lesson-why"
              />
              <p className="hint">
                {reason.length} / {REASON_MAX}. The AI reads this and answers it. It cannot change your grade.
              </p>
            </>
          )}
        </div>
      )}
      <div className="lesson-actions">
        <button type="button" className="btn btn-primary" onClick={onSubmit} disabled={busy || choice === null} data-testid="lesson-submit">
          {busy ? 'Checking…' : 'Check my answer'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onSkip} disabled={busy} data-testid="lesson-skip">
          Skip this chart
        </button>
      </div>
      {choice === null && <p className="hint">Pick one choice, then press “Check my answer”.</p>}
      <p className="hint">The chart is made up by the game and is not a real company. Nothing here uses your game money.</p>
    </section>
  );
}

function ResultCard({
  lesson,
  result,
  coach,
  onRetryCoach,
  onNext,
  busy,
  headingRef,
}: {
  lesson: LessonView;
  result: LessonResult;
  coach: Coach;
  onRetryCoach: () => void;
  onNext: () => void;
  busy: boolean;
  headingRef: { current: HTMLHeadingElement | null };
}) {
  const fmt = (p: number) => lessonPrice(lesson.asset.kind, p);
  const banner = gradeBanner(result.grade);
  const all = [...lesson.candles, ...result.outcome];
  return (
    <section className="card lesson-result" data-testid="lesson-result" aria-label="Lesson result">
      <div className={`grade-banner ${banner.tone}`} data-testid="lesson-grade" data-grade={result.grade}>
        <h3 ref={headingRef} tabIndex={-1}>
          {banner.label}
        </h3>
        <span data-testid="lesson-xp">{xpText(result.xpGained)}</span>
      </div>
      <MiniChart
        candles={all}
        futureFrom={lesson.candles.length}
        lines={result.lines}
        marks={result.marks}
        format={fmt}
        label={`Chart of ${lesson.asset.name} with the ${result.outcome.length} candles that came next. Over those candles the price moved ${pctText(result.outcomePct)}.`}
        testId="lesson-result-chart"
      />
      <p className="lesson-headline" data-testid="lesson-headline">
        {result.headline}
      </p>
      <p className="muted">
        Pattern: <strong>{result.patternName}</strong>. In the next {result.outcome.length} candles the price moved <strong>{pctText(result.outcomePct)}</strong>.
      </p>
      {result.reason && (
        <p className="lesson-yours" data-testid="lesson-your-reason">
          <span className="muted">You wrote:</span> {result.reason}
        </p>
      )}
      <div className="lesson-sections">
        {result.sections.map((s, i) => (
          <div key={s.title} className="lesson-section" data-testid={`lesson-section-${i}`}>
            <h4>{s.title}</h4>
            <p>{s.text}</p>
          </div>
        ))}
      </div>

      <h4 className="lesson-sub">What each choice would have done</h4>
      <ul className="lesson-results" data-testid="lesson-results">
        {result.results.map((r) => (
          <li key={r.id} className={`opt-result ${r.grade}${r.id === result.chosen ? ' yours' : ''}`} data-testid={`lesson-result-${r.id}`}>
            <div className="opt-head">
              <strong>{r.label}</strong>
              {r.id === result.chosen && <span className="tag">your choice</span>}
              {r.id === result.best && <span className="tag tag-best">best</span>}
              <span className={r.changePct > 0 ? 'pos' : r.changePct < 0 ? 'neg' : ''}>{r.liquidated ? 'wiped out' : pctText(r.changePct)}</span>
            </div>
            <p>{r.text}</p>
          </li>
        ))}
      </ul>

      {coach.status !== 'none' && (
        <div className="coach-box" data-testid="lesson-coach" aria-live="polite">
          <h4>AI teacher</h4>
          {coach.status === 'loading' && <p className="muted">The teacher is thinking…</p>}
          {coach.status === 'ok' && (
            <>
              <p className="coach-text" data-testid="lesson-coach-text">
                {coach.text}
              </p>
              <p className="hint">Written by an AI. It can be wrong. Your grade above was decided by the game&apos;s rules, not by the AI.</p>
            </>
          )}
          {coach.status === 'note' && <p className="muted">{coach.text}</p>}
          {coach.status === 'failed' && (
            <p className="muted">
              {coachNote('failed')}{' '}
              <button type="button" className="link-btn" onClick={onRetryCoach} data-testid="lesson-coach-retry">
                Try again
              </button>
            </p>
          )}
        </div>
      )}

      <div className="lesson-actions">
        <button type="button" className="btn btn-primary" onClick={onNext} disabled={busy} data-testid="lesson-next">
          {busy ? 'Making a chart…' : 'Next lesson →'}
        </button>
      </div>
      <p className="hint" data-testid="lesson-level-line">
        Level {result.progress.level} · {result.progress.title} · {result.progress.xp} XP
        {result.progress.streak > 1 ? ` · streak ${result.progress.streak}` : ''}
      </p>
    </section>
  );
}
