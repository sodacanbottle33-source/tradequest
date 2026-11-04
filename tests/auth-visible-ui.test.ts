// AUTHVIS-1…7 — logging in and creating an account must be easy to find: two big buttons in the top bar, a welcome box with three steps for
// somebody who is not logged in, two tabs in the form, the same two buttons in the trade box of a company page, and one shared window that
// all of them open. The browser decides nothing: the hints in the form are checked here against the rules the server really enforces.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Auth, START_CASH_CENTS } from '../server/auth';
import { SharedStore } from '../src/shared/store';
import { makeRig, type Rig } from './helpers/server';

const root = (...parts: string[]): string => resolve(process.cwd(), ...parts);
const read = (...parts: string[]): string => readFileSync(root(...parts), 'utf8');
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const src = (file: string): string => code(read('src', 'shared', file));

type Snap = { authDialog: 'login' | 'register' | null; user: unknown };
type Store = { openAuth(mode: 'login' | 'register'): void; closeAuth(): void; getSnapshot(): Snap; set(patch: Record<string, unknown>): void };

const rigs: Rig[] = [];
afterEach(() => {
  while (rigs.length > 0) rigs.pop()?.cleanup();
});

describe('Log in and create account are easy to find', () => {
  it('AUTHVIS-1: one shared window: any button opens it as Log in or Create account, closing and a second press behave, and a signed-in player gets no window', () => {
    const store = new SharedStore() as unknown as Store;
    expect(store.getSnapshot().authDialog).toBeNull();
    store.openAuth('register');
    expect(store.getSnapshot().authDialog).toBe('register');
    store.openAuth('login'); // the other button changes which side is shown
    expect(store.getSnapshot().authDialog).toBe('login');
    store.closeAuth();
    expect(store.getSnapshot().authDialog).toBeNull();
    store.closeAuth(); // closing a window that is closed does nothing
    expect(store.getSnapshot().authDialog).toBeNull();
    // Somebody who is logged in is never offered the window.
    store.set({ user: { id: 1, username: 'alice', displayName: 'alice', role: 'player', createdMs: 0 } });
    store.openAuth('register');
    expect(store.getSnapshot().authDialog).toBeNull();
    // And a log in that works closes it (the code that sets the user also clears the window).
    expect(code(read('src', 'shared', 'store.ts'))).toMatch(/this\.set\(\{ user: res\.user, banned: null, authDialog: null \}\)/);
  });

  it('AUTHVIS-2: the top bar shows "Log in" and "Create free account" while nobody is logged in, both open the shared window, and the old menu items are still there', () => {
    const menu = src('ProfileMenu.tsx');
    expect(menu).toMatch(/\{!user && \(\s*<div className="auth-cta" data-testid="auth-cta">/);
    expect(menu).toMatch(/onClick=\{\(\) => sharedStore\.openAuth\('login'\)\} data-testid="header-login"/);
    expect(menu).toMatch(/onClick=\{\(\) => sharedStore\.openAuth\('register'\)\} data-testid="header-register"/);
    expect(menu).toContain('Create free account');
    // The icon's menu still offers both, and they open the same window.
    expect(menu).toMatch(/choose\(\(\) => sharedStore\.openAuth\('login'\)\)\} data-testid="menu-login"/);
    expect(menu).toMatch(/choose\(\(\) => sharedStore\.openAuth\('register'\)\)\} data-testid="menu-register"/);
    // The window is drawn from the shared state, only while nobody is logged in, and it starts again when the side changes.
    expect(menu).toMatch(/\{authDialog && !user && <AuthDialog key=\{authDialog\} mode=\{authDialog\} onClose=\{\(\) => sharedStore\.closeAuth\(\)\} \/>\}/);
    expect(menu).toMatch(/if \(user\) sharedStore\.closeAuth\(\);/);
    // A logged-in player does not get the two buttons.
    expect(menu.indexOf('auth-cta')).toBeGreaterThan(menu.indexOf("className={user ? 'profile' : 'profile signed-out'}"));
  });

  it('AUTHVIS-3: the welcome box has the three steps and both buttons; the page shows it only to somebody who is not logged in (and not banned), when the market answers, and not where the form is already on the page', () => {
    const card = src('WelcomeCard.tsx');
    for (const text of ['Create free account', 'Already have an account?', 'No email needed', 'Buy your first stock', 'made-up companies and fake money']) expect(card).toContain(text);
    expect(card).toMatch(/sharedStore\.openAuth\('register'\)\} data-testid="welcome-register"/);
    expect(card).toMatch(/sharedStore\.openAuth\('login'\)\} data-testid="welcome-login"/);
    expect(card).toContain('data-testid="welcome-card"');
    // The money in step 2 is what a new account really gets.
    expect(START_CASH_CENTS).toBe(100_000);
    expect(card).toContain('<strong>$1,000</strong>');
    // Nothing in it decides, stores or fetches anything.
    expect(card).not.toMatch(/\bfetch\(|localStorage|sessionStorage|innerHTML|Math\.random|Date\.now/);
    const app = src('SharedApp.tsx');
    expect(app).toMatch(/\{showWelcome && <WelcomeCard \/>\}/);
    const rule = app.slice(app.indexOf('const showWelcome ='), app.indexOf(';', app.indexOf('const showWelcome =')));
    for (const part of ['s.authChecked', "s.conn === 'online'", '!s.user', '!s.banned', "shown === 'battle'", "shown === 'news'", '!OWN_FORM_TABS.includes(careerTab)', 'ticker !== null']) expect(rule).toContain(part);
    // The tabs that show the form themselves are exactly the ones whose screens return the form for a signed-out player.
    const own = /const OWN_FORM_TABS: readonly CareerTab\[\] = \[([^\]]*)\]/.exec(app)?.[1] ?? '';
    expect(own.match(/'[a-z]+'/g)?.sort()).toEqual(["'account'", "'chat'", "'goals'", "'launch'", "'messages'", "'players'", "'shop'", "'teams'"]);
    const screens: Record<string, string> = { account: 'AccountScreen', chat: 'ChatScreen', goals: 'GoalsScreen', launch: 'LaunchScreen', messages: 'MessagesScreen', players: 'PlayersScreen', shop: 'ShopScreen', teams: 'TeamsScreen' };
    for (const [tab, file] of Object.entries(screens)) expect(src(`${file}.tsx`), tab).toMatch(/if \(!user\) return <AuthPanel/);
  });

  it('AUTHVIS-4: the form has two tabs (Log in, Create account), says what each does in plain words, and its hints are the rules the server really enforces', async () => {
    const panel = src('AuthPanel.tsx');
    expect(panel).toMatch(/data-testid="auth-tab-login"/);
    expect(panel).toMatch(/data-testid="auth-tab-register"/);
    expect(panel).toMatch(/role="tab" aria-selected=\{mode === 'login'\}/);
    expect(panel).toMatch(/role="tab" aria-selected=\{mode === 'register'\}/);
    for (const text of ['Welcome back', 'Create your free account', 'Create my account', 'No email needed', '$1,000 of pretend money', 'there is no "forgot password" button']) expect(panel).toContain(text);
    expect(panel).toContain('3 to 20 letters, numbers or underscores');
    expect(panel).toContain('8 to 72 characters');
    expect(panel).toMatch(/sharedStore\.signIn\(mode, username\.trim\(\), password\)/); // still only sends what was typed
    // The hints are true: the server accepts exactly these lengths and refuses one more or one less.
    const rig = makeRig();
    rigs.push(rig);
    const { db } = rig.open({ companyCount: 3, warmupDays: 0 });
    const auth = new Auth(db, rig.clock.now, '');
    const ok = async (name: string, pass: string, ip: string) => (await auth.register(name, pass, ip).then(() => 'ok', (e: { code?: string }) => e.code ?? 'error')) as string;
    expect(await ok('ab', 'password1', '1.1.1.1')).toBe('bad_username'); // 2 letters: too short
    expect(await ok('abc', 'password1', '1.1.1.1')).toBe('ok'); // 3 letters
    expect(await ok('a'.repeat(20), 'password1', '1.1.1.2')).toBe('ok'); // 20 letters
    expect(await ok('a'.repeat(21), 'password1', '1.1.1.3')).toBe('bad_username'); // 21 letters
    expect(await ok('has space', 'password1', '1.1.1.3')).toBe('bad_username');
    expect(await ok('under_score_9', 'password1', '1.1.1.4')).toBe('ok'); // letters, numbers and underscores
    expect(await ok('pwshort', '1234567', '1.1.1.5')).toBe('bad_password'); // 7 characters
    expect(await ok('pweight', '12345678', '1.1.1.5')).toBe('ok'); // 8 characters
    expect(await ok('pwlong72', 'x'.repeat(72), '1.1.1.6')).toBe('ok'); // 72 characters
    expect(await ok('pwlong73', 'x'.repeat(73), '1.1.1.7')).toBe('bad_password'); // 73 characters
    // No email is asked for: the form has exactly a username and a password.
    expect(panel).not.toMatch(/type="email"|e-?mail address/i);
  }, 60_000);

  it('AUTHVIS-5: the trade box of a company page offers both buttons to somebody who is not logged in, and says so in words, not only "My account tab"', () => {
    const panel = src('TradePanel.tsx');
    expect(panel).toMatch(/const \{ limits, user: signedInUser \} = useShared\(\);/);
    expect(panel).toMatch(/\{blocked && !signedInUser && \(\s*<div className="trade-auth" data-testid="trade-auth">/);
    expect(panel).toMatch(/sharedStore\.openAuth\('register'\)\} data-testid="trade-register"/);
    expect(panel).toMatch(/sharedStore\.openAuth\('login'\)\} data-testid="trade-login"/);
    expect(src('CompanyView.tsx')).toContain("'Log in or create a free account to trade with your Career money.'");
  });

  it('AUTHVIS-6: every class these pieces use has a rule in styles.css, and the pulsing button only moves for people who have not asked for less motion', () => {
    const css = read('src', 'styles.css');
    const files = ['WelcomeCard.tsx', 'AuthPanel.tsx', 'ProfileMenu.tsx'].map((f) => read('src', 'shared', f));
    const used = new Set<string>();
    for (const screen of files) {
      for (const m of screen.matchAll(/className=(?:"([^"]+)"|'([^']+)')/g)) for (const c of ((m[1] ?? m[2]) as string).split(/\s+/)) used.add(c);
      for (const m of screen.matchAll(/className=\{([^}`]*)\}/g)) for (const q of (m[1] as string).replace(/===\s*'[^']*'/g, '').matchAll(/'([A-Za-z][A-Za-z0-9_ -]*)'/g)) for (const c of (q[1] as string).split(/\s+/)) if (c) used.add(c);
    }
    expect(used.size).toBeGreaterThan(20);
    expect(css).toMatch(/\.trade-auth \{/); // the two buttons in the trade box (TradePanel.tsx)
    const missing = [...used].filter((c) => c && !new RegExp(`\\.${c.replace(/-/g, '\\-')}(?![a-zA-Z0-9_-])`).test(css));
    expect(missing).toEqual([]);
    const animated = css.slice(css.indexOf('@media (prefers-reduced-motion: no-preference) {\n  .auth-cta-create'));
    expect(animated.slice(0, 200)).toContain('animation: ctaPulse');
    // The animation appears only inside that guard.
    expect(css.match(/animation: ctaPulse/g)?.length).toBe(1);
  });

  it('AUTHVIS-7: nothing in the browser keeps or invents a log in: no storage, no cookies written by the page, no password kept after sending', () => {
    for (const file of ['WelcomeCard.tsx', 'AuthPanel.tsx']) expect(src(file), file).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    // The password lives only in the form's state, and the form sends it through the store (never to a URL).
    const panel = src('AuthPanel.tsx');
    expect(panel).not.toMatch(/location\.|searchParams|\?password=|console\.log/);
    expect(panel).toContain('autoComplete={mode === \'login\' ? \'current-password\' : \'new-password\'}');
  });
});
