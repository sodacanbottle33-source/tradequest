// The profile button at the top right, like the one in Claude: click it and a small menu opens. Signed out it offers "Log in" and
// "Create account" (the form opens in a window on top of the page); signed in it shows who you are and offers "My account",
// the Admin panel (only for the owner) and "Log out". Whether somebody is the owner is decided by the server; this menu only
// shows what the server said.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AuthPanel } from './AuthPanel';
import { sharedStore, useShared } from './store';

interface Props {
  /** Go to Career → My account. */
  onAccount: () => void;
  /** Open the admin panel (offered to the owner only). */
  onAdmin: () => void;
  /** Called after the player logged out, so the screen can leave pages that need a login. */
  onLoggedOut: () => void;
}

function Person() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="12" cy="8" r="4" fill="currentColor" />
      <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8z" fill="currentColor" />
    </svg>
  );
}

function AuthDialog({ mode, onClose }: { mode: 'login' | 'register'; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      data-testid="auth-dialog"
      onMouseDown={(e: { target: unknown; currentTarget: unknown }) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={mode === 'login' ? 'Log in' : 'Create account'}>
        <button type="button" className="modal-close btn btn-small btn-ghost" onClick={onClose} aria-label="Close" data-testid="auth-close">
          ✕
        </button>
        <AuthPanel initialMode={mode} autoFocus />
      </div>
    </div>
  );
}

export function ProfileMenu({ onAccount, onAdmin, onLoggedOut }: Props) {
  const { user } = useShared();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'login' | 'register' | null>(null);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Close the menu when the player clicks somewhere else or presses Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: Event) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A successful log in closes the window by itself.
  useEffect(() => {
    if (user) setDialog(null);
  }, [user]);

  const initial = (user?.displayName ?? '?').slice(0, 1).toUpperCase();
  const isOwner = user?.role === 'owner';

  const moveFocus = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const choose = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  const logOut = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await sharedStore.signOut();
    } finally {
      setBusy(false);
      setOpen(false);
      onLoggedOut();
    }
  };

  return (
    <div className="profile" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={user ? 'avatar-btn signed-in' : 'avatar-btn'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={user ? `Profile menu for ${user.displayName}` : 'Profile menu: log in'}
        data-testid="profile-button"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="avatar" aria-hidden="true">
          {user ? initial : <Person />}
        </span>
      </button>

      {open && (
        <div className="menu-panel" role="menu" aria-label="Profile" ref={panel} onKeyDown={moveFocus} data-testid="profile-menu">
          {user ? (
            <>
              <div className="menu-head">
                <span className="avatar avatar-lg" aria-hidden="true">
                  {initial}
                </span>
                <div className="menu-who">
                  <strong data-testid="menu-name">{user.displayName}</strong>
                  <span className="muted">@{user.username}</span>
                </div>
                {isOwner && (
                  <span className="badge-owner" data-testid="owner-badge">
                    Owner
                  </span>
                )}
              </div>
              <button type="button" role="menuitem" className="menu-item" onClick={choose(onAccount)} data-testid="menu-account">
                My account
              </button>
              {isOwner && (
                <button type="button" role="menuitem" className="menu-item" onClick={choose(onAdmin)} data-testid="menu-admin">
                  Admin panel
                </button>
              )}
              <hr className="menu-sep" />
              <button type="button" role="menuitem" className="menu-item" onClick={() => void logOut()} disabled={busy} data-testid="menu-logout">
                Log out
              </button>
            </>
          ) : (
            <>
              <div className="menu-head">
                <div className="menu-who">
                  <strong>Not logged in</strong>
                  <span className="muted">Log in to trade with your Career money.</span>
                </div>
              </div>
              <button type="button" role="menuitem" className="menu-item" onClick={choose(() => setDialog('login'))} data-testid="menu-login">
                Log in
              </button>
              <button type="button" role="menuitem" className="menu-item" onClick={choose(() => setDialog('register'))} data-testid="menu-register">
                Create account
              </button>
            </>
          )}
        </div>
      )}

      {dialog && !user && <AuthDialog mode={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
