// The tutorial screen: nine steps, each with a demo and a check question (src/learn/tutorial.ts). A step counts as done when its question is
// answered right; a signed-in player's progress is saved on the server, so it is still there on another device.
import { useMemo, useState } from 'react';
import { TUTORIAL } from '../learn/tutorial';
import { TutorialDemo } from './LearnDemos';
import { firstOpenStep } from './learnUtil';

export interface TutorialViewProps {
  /** The steps this player has already finished (from the server; empty when signed out). */
  readonly done: readonly number[];
  readonly signedIn: boolean;
  /** Called once when a step is answered right the first time on this screen. */
  readonly onStepDone: (step: number) => void;
  readonly onGoLessons: () => void;
}

export function TutorialView({ done, signedIn, onStepDone, onGoLessons }: TutorialViewProps) {
  // A signed-out player (or one whose save has not come back yet) still sees his steps tick off on this page.
  const [local, setLocal] = useState<ReadonlySet<number>>(new Set());
  const finished = useMemo(() => new Set<number>([...done, ...local]), [done, local]);
  const [index, setIndex] = useState<number>(() => firstOpenStep(done, TUTORIAL.length));
  const [picked, setPicked] = useState<number | null>(null);
  const step = TUTORIAL[index] ?? TUTORIAL[0];
  if (!step) return null;
  const q = step.question;
  const answered = picked !== null;
  const right = picked === q.correct;
  const allDone = TUTORIAL.every((s) => finished.has(s.id));

  const go = (i: number) => {
    setIndex(Math.min(Math.max(i, 0), TUTORIAL.length - 1));
    setPicked(null);
    window.scrollTo?.(0, 0);
  };

  const choose = (i: number) => {
    if (answered && right) return;
    setPicked(i);
    if (i === q.correct && !finished.has(step.id)) {
      setLocal((s) => new Set(s).add(step.id));
      onStepDone(step.id);
    }
  };

  return (
    <section className="tutorial" data-testid="tutorial">
      <ol className="tut-steps" aria-label="Tutorial steps">
        {TUTORIAL.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              className={`tut-dot${i === index ? ' current' : ''}${finished.has(s.id) ? ' done' : ''}`}
              aria-current={i === index ? 'step' : undefined}
              aria-label={`Step ${s.id}: ${s.title}${finished.has(s.id) ? ' (done)' : ''}`}
              onClick={() => go(i)}
              data-testid={`tut-step-${s.id}`}
            >
              {finished.has(s.id) ? '✓' : s.id}
            </button>
          </li>
        ))}
      </ol>

      {!signedIn && (
        <p className="notice info" data-testid="tut-signin-note">
          You can do the whole tutorial without an account. Sign in (My account) to keep your progress.
        </p>
      )}

      <article className="card tut-card">
        <p className="tut-count">
          Step {step.id} of {TUTORIAL.length}
        </p>
        <h2 className="tut-title" data-testid="tut-title">
          {step.title}
        </h2>
        {step.paragraphs.map((p, i) => (
          <p key={i} className="tut-text">
            {p}
          </p>
        ))}
        <p className="tut-try">
          <strong>Try it:</strong> {step.tryIt}
        </p>
        <TutorialDemo key={step.id} kind={step.demo} />

        <div className="tut-question" data-testid="tut-question">
          <h3>Check yourself</h3>
          <p>{q.text}</p>
          <div className="tut-options" role="group" aria-label="Answers">
            {q.options.map((o, i) => {
              // The right answer is only marked once the player has found it himself.
              const state = !answered ? '' : right ? (i === q.correct ? ' right' : '') : i === picked ? ' wrong' : '';
              return (
                <button
                  key={o}
                  type="button"
                  className={`tut-option${state}`}
                  aria-pressed={picked === i}
                  disabled={answered && right}
                  onClick={() => choose(i)}
                  data-testid={`tut-option-${i}`}
                >
                  {o}
                </button>
              );
            })}
          </div>
          {answered && (
            <p className={right ? 'tut-feedback right' : 'tut-feedback wrong'} role="status" data-testid="tut-feedback">
              <strong>{right ? 'Right! ' : 'Not quite. '}</strong>
              {right ? q.explain : 'Read the step again and try another answer.'}
            </p>
          )}
        </div>

        <div className="tut-nav">
          <button type="button" className="btn btn-ghost" onClick={() => go(index - 1)} disabled={index === 0} data-testid="tut-back">
            ← Back
          </button>
          {index < TUTORIAL.length - 1 ? (
            <button type="button" className="btn btn-primary" onClick={() => go(index + 1)} disabled={!finished.has(step.id)} data-testid="tut-next">
              Next step →
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={onGoLessons} disabled={!allDone} data-testid="tut-finish">
              Finish: go to the lessons →
            </button>
          )}
        </div>
        {!finished.has(step.id) && <p className="hint">Answer the question to unlock the next step.</p>}
      </article>
    </section>
  );
}
