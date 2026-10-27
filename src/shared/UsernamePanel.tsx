// Changing your username: it costs money from your Career cash and can be done once a week. The server decides everything (the price, the wait, which
// names are allowed); this panel asks it for the facts, checks only the obvious, asks "Sure?" and shows what happened.
import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { formatCents } from './format';
import { problemText } from './playersUtil';
import { usernameProblem, waitLabel } from './renameUtil';
import { sharedStore, useShared } from './store';
import type { RenameStatus } from './types';

export function UsernamePanel() {
  const { user, career } = useShared();
  const [status, setStatus] = useState<RenameStatus | null>(null);
  const [name, setName] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // The facts are asked for again when the name or the cash changes (the cash is part of "can I afford it").
  const username = user?.username ?? '';
  const cash = career?.cashCents ?? null;
  useEffect(() => {
    if (!username) return undefined;
    let cancelled = false;
    api
      .usernameStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(problemText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [username, cash]);

  if (!user) return null;
  const typed = name.trim();
  const problem = usernameProblem(name, user.username);
  const cost = status ? formatCents(status.costCents) : '$4,000';
  const now = Date.now();
  const waiting = status !== null && status.nextAllowedMs !== null && status.nextAllowedMs > now;
  const locked = status !== null && !status.canChange;

  const change = async () => {
    if (busy || typed === '') return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const out = await api.changeUsername(typed);
      if (out.user) sharedStore.noteRenamed(out.user, out.previous);
      setDone(`Done. You are now ${out.username}. It cost ${formatCents(out.costCents)}. Your old name, ${out.previous}, is kept for you for 30 days, and you can change your name again in ${waitLabel(out.nextAllowedMs - Date.now())}.`);
      setName('');
      void api
        .usernameStatus()
        .then(setStatus)
        .catch(() => undefined);
    } catch (e) {
      setError(problemText(e));
      void api
        .usernameStatus()
        .then(setStatus)
        .catch(() => undefined);
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (typed === '' || problem !== null || busy) return;
    setAsking(true);
  };

  return (
    <section className="card" aria-label="Change your username" data-testid="username-panel">
      <h2>
        Change your username <span className="h2-note">{cost} · once a week</span>
      </h2>
      <p className="hint">
        Your username is <strong data-testid="username-now">{user.username}</strong>. A new one costs {cost} of your Career cash (it is spent, not returned) and you can change it once every 7 days. Your money, shares, friends, groups,
        messages and badges all stay with you. The name you leave is kept for you for 30 days, so nobody can copy it.
      </p>
      {status && !status.canChange && (
        <p className="notice info" role="status" data-testid="username-reason">
          {waiting && status.nextAllowedMs !== null ? `You changed your username recently. You can change it again in ${waitLabel(status.nextAllowedMs - now)} (${new Date(status.nextAllowedMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}).` : status.reason}
        </p>
      )}
      <form className="pm-form" onSubmit={onSubmit}>
        <label className="qty-label" htmlFor="username-new">
          New username
        </label>
        <input
          id="username-new"
          className="qty-input"
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setAsking(false);
            setDone(null);
          }}
          maxLength={20}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={busy || locked}
          data-testid="username-input"
        />
        {problem && (
          <span className="hint" data-testid="username-problem">
            {problem}
          </span>
        )}
        {!asking && (
          <div className="people-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || typed === '' || problem !== null || locked} data-testid="username-change">
              Change username for {cost}
            </button>
          </div>
        )}
        {asking && (
          <div className="notice warn pm-request-bar" role="alert" data-testid="username-sure">
            <span>
              Pay {cost} from your Career cash and change your username from <strong>{user.username}</strong> to <strong>{typed}</strong>? You cannot change it again for 7 days.
            </span>
            <span className="people-actions">
              <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void change()} data-testid="username-yes">
                {busy ? 'Changing…' : 'Yes, change it'}
              </button>
              <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setAsking(false)} data-testid="username-no">
                No
              </button>
            </span>
          </div>
        )}
      </form>
      {done && (
        <p className="notice info" role="status" data-testid="username-done">
          {done}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert" data-testid="username-error">
          {error}
        </p>
      )}
    </section>
  );
}
