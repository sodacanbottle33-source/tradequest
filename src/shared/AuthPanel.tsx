// Sign in / create an account. The server checks everything; this form only sends what was typed.
import { useState, type FormEvent } from 'react';
import { sharedStore } from './store';

export function AuthPanel({ initialMode = 'login', autoFocus = false }: { initialMode?: 'login' | 'register'; autoFocus?: boolean }) {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
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

  return (
    <section className="card auth-card" aria-label="Sign in">
      <h2>{mode === 'login' ? 'Sign in' : 'Create your account'}</h2>
      <p className="hint">
        The market is the same for every player and never stops. Your Career account ($1,000 to start) is saved on the
        server, so it is still there when you come back.
      </p>
      <form onSubmit={submit} className="auth-form">
        <label className="qty-label" htmlFor="auth-user">
          Username
        </label>
        <input id="auth-user" className="qty-input" type="text" autoComplete="username" autoFocus={autoFocus} value={username} onChange={(e) => setUsername(e.target.value)} />
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
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-wide" disabled={busy || username.trim() === '' || password === ''}>
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <p className="small-print">
        {mode === 'login' ? 'New here? ' : 'Already have an account? '}
        <button type="button" className="link-btn" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}>
          {mode === 'login' ? 'Create an account' : 'Sign in'}
        </button>
      </p>
    </section>
  );
}
