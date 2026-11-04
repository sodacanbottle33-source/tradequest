// Log in / create an account. The server checks everything (the username and password rules, the limits, who is banned); this form only
// sends what was typed and shows the server's answer. Two big tabs at the top say which of the two you are doing.
import { useState, type FormEvent } from 'react';
import { sharedStore } from './store';

type AuthMode = 'login' | 'register';

export function AuthPanel({ initialMode = 'login', autoFocus = false }: { initialMode?: AuthMode; autoFocus?: boolean }) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await sharedStore.signIn(mode, username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next: AuthMode) => {
    setMode(next);
    setError(null);
  };

  return (
    <section className="card auth-card" aria-label="Log in or create an account" data-testid="auth-panel">
      <div className="auth-tabs" role="tablist" aria-label="Log in or create an account">
        <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'auth-tab active' : 'auth-tab'} onClick={() => switchTo('login')} data-testid="auth-tab-login">
          Log in
        </button>
        <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'auth-tab active' : 'auth-tab'} onClick={() => switchTo('register')} data-testid="auth-tab-register">
          Create account
        </button>
      </div>
      <h2>{mode === 'login' ? 'Welcome back' : 'Create your free account'}</h2>
      <p className="hint" data-testid="auth-hint">
        {mode === 'login'
          ? 'Type the username and password you picked when you made your account. Your money and your shares are saved on the server.'
          : 'It is free and takes about 10 seconds. No email needed. You start with $1,000 of pretend money.'}
      </p>
      <form onSubmit={submit} className="auth-form">
        <label className="qty-label" htmlFor="auth-user">
          Username
        </label>
        <input id="auth-user" className="qty-input" type="text" autoComplete="username" autoFocus={autoFocus} value={username} onChange={(e) => setUsername(e.target.value)} />
        {mode === 'register' && (
          <span className="auth-fieldhint" data-testid="auth-user-hint">
            3 to 20 letters, numbers or underscores. Other players will see it.
          </span>
        )}
        <label className="qty-label" htmlFor="auth-pass">
          Password
        </label>
        <input
          id="auth-pass"
          className="qty-input"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {mode === 'register' && (
          <span className="auth-fieldhint" data-testid="auth-pass-hint">
            8 to 72 characters. Remember it: there is no "forgot password" button.
          </span>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-wide" disabled={busy || username.trim() === '' || password === ''} data-testid="auth-submit">
          {busy ? 'One moment…' : mode === 'login' ? 'Log in' : 'Create my account'}
        </button>
      </form>
      <p className="small-print">
        {mode === 'login' ? 'New here? ' : 'Already have an account? '}
        <button type="button" className="link-btn" onClick={() => switchTo(mode === 'login' ? 'register' : 'login')} data-testid="auth-switch">
          {mode === 'login' ? 'Create a free account' : 'Log in'}
        </button>
      </p>
    </section>
  );
}
