// "While you were away" (docs/world.md §33): when the player comes back after at least half an hour, a short card says how his net worth moved, where he stands on the leaderboard,
// which holding moved most, how his own companies did (and who bought them), and what is left to do today. The server makes the report; this card shows it and says when it is closed.
import { awayCompanyLines, awayLines, awayText } from './goalUtil';
import { awayStore, useAway } from './awayStore';

export function AwayCard({ onGoals }: { onGoals: () => void }) {
  const away = useAway();
  if (!away) return null;
  const { report, today } = away;
  const lines = awayLines(report);
  const companies = awayCompanyLines(report);
  const quiet = lines.length === 0 && companies.length === 0;
  const close = () => void awayStore.dismiss();
  return (
    <section className="card away-card" role="region" aria-label="While you were away" data-testid="away-card">
      <p className="eyebrow">Welcome back</p>
      <h2>
        While you were away <span className="h2-note">{awayText(report.awayMs)}</span>
      </h2>
      {quiet ? (
        <p data-testid="away-quiet">Nothing much changed while you were gone.</p>
      ) : (
        <ul className="away-list">
          {lines.map((l) => (
            <li key={l.key} className={l.tone} data-testid={`away-${l.key}`}>
              {l.text}
            </li>
          ))}
          {companies.length > 0 && (
            <li className="away-companies" data-testid="away-companies">
              <strong>Your companies</strong>
              <ul>
                {companies.map((c) => (
                  <li key={c.key} className={c.tone}>
                    {c.text}
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
      )}
      <p className="away-today" data-testid="away-today">
        <span aria-hidden="true">{today.streak > 0 ? '🔥' : '🎯'}</span>{' '}
        {today.streak > 0 ? `${today.streak}-day streak${today.atRisk ? ': finish a goal today to keep it.' : '.'}` : 'No streak yet: finish a goal today to start one.'}
        {today.goalsLeft > 0 ? ` ${today.goalsLeft} goal${today.goalsLeft === 1 ? '' : 's'} left today.` : ' All of today\'s goals are done.'}
      </p>
      <div className="row-buttons">
        {today.goalsLeft > 0 && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              close();
              onGoals();
            }}
            data-testid="away-goals"
          >
            See today&apos;s goals
          </button>
        )}
        <button type="button" className={today.goalsLeft > 0 ? 'btn' : 'btn btn-primary'} onClick={close} data-testid="away-close">
          Close
        </button>
      </div>
    </section>
  );
}
