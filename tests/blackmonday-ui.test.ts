// BM-13 — the owner's Black Monday card (src/shared/AdminBroadcast.tsx): source-level checks that the browser only asks and shows. It never starts the crash without the typed words, never makes up a
// rule the server owns, talks to the server only through api.ts, shows the server's refusal in plain words, and every class it uses is styled.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLACK_MONDAY_CONFIRM } from '../server/admin';

const read = (...parts: string[]): string => readFileSync(resolve(process.cwd(), ...parts), 'utf8');
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('The owner\'s Black Monday card', () => {
  const screen = read('src/shared/AdminBroadcast.tsx');
  const source = code(screen);

  it('BM-13: the card asks for the typed words, sends one request through api.ts, shows the server\'s answer, and is fully styled', () => {
    // The word the browser asks for is the word the server checks.
    expect(source).toContain(`const BLACK_MONDAY_WORD = '${BLACK_MONDAY_CONFIRM}';`);
    // The start button stays off until the words are typed; the function checks again before it asks.
    expect(source).toMatch(/disabled=\{word\.trim\(\)\.toUpperCase\(\) !== BLACK_MONDAY_WORD\}/);
    expect(source).toMatch(/if \(busy \|\| word\.trim\(\)\.toUpperCase\(\) !== BLACK_MONDAY_WORD\) return;/);
    expect(source).toContain('api.adminBlackMonday({ requestId: newRequestId(), confirm: word.trim() })');
    // Its answer and its refusal (for example "already running") are shown as the server words them.
    expect(source).toMatch(/setBmMessage\(\{ kind: 'error', text: problem\(error\) \}\)/);
    for (const id of ['admin-bm-hint', 'admin-bm-word', 'admin-bm-start', 'admin-bm-message']) expect(screen).toContain(`data-testid="${id}"`);
    // The card tells the owner what it does, in plain words.
    expect(screen).toMatch(/October 19/);
    expect(screen).toMatch(/about a week/);
    expect(screen).toMatch(/cannot be undone/);
    // The browser only talks to the server through api.ts, and shows nothing as markup.
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/innerHTML|dangerouslySetInnerHTML/);
    expect(source).not.toMatch(/localStorage|sessionStorage/);
    const api = read('src/shared/api.ts');
    expect(api).toContain("adminBlackMonday: (body: { requestId: string; confirm: string })");
    expect(api).toContain("'/api/admin/black-monday'");
    // The owner's log says it in words.
    expect(read('src/shared/AdminLog.tsx')).toMatch(/case 'black_monday':\s*return 'started Black Monday by hand/);
    // Every class the card uses has a rule in styles.css.
    const css = read('src/styles.css');
    const used = new Set<string>();
    for (const m of screen.matchAll(/className=(?:"([^"]+)"|'([^']+)')/g)) for (const c of ((m[1] ?? m[2]) as string).split(/\s+/)) used.add(c);
    for (const m of screen.matchAll(/className=\{`([^`]+)`\}/g)) for (const c of (m[1] as string).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (c) used.add(c);
    for (const m of screen.matchAll(/className=\{([^}`]*)\}/g)) for (const q of (m[1] as string).matchAll(/'([A-Za-z][A-Za-z0-9_ -]*)'/g)) for (const c of (q[1] as string).split(/\s+/)) if (c) used.add(c);
    expect(used.size).toBeGreaterThan(8);
    const missing = [...used].filter((c) => c && !new RegExp(`\\.${c.replace(/[-]/g, '\\-')}(?![a-zA-Z0-9_-])`).test(css));
    expect(missing).toEqual([]);
  });
});
