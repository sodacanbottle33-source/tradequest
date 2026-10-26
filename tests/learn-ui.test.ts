// LEARN-56 … LEARN-64 — the Learn screens: the small decisions they make (pure helpers) and source-level checks that the browser only asks and
// shows: it never generates a lesson, never grades, never sees the AI key, shows the AI's words only as plain text, and every class it uses is styled.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canExplain,
  coachNote,
  defaultView,
  doneCount,
  firstOpenStep,
  goodPercent,
  gradeBanner,
  learnSeen,
  markLearnSeen,
  readWhyPref,
  statText,
  tutorialLabel,
  weakSpots,
  writeWhyPref,
  xpText,
} from '../src/shared/learnUtil';

const read = (...parts: string[]): string => readFileSync(resolve(process.cwd(), ...parts), 'utf8');
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREENS = ['LearnScreen.tsx', 'LessonsView.tsx', 'TutorialView.tsx', 'LearnDemos.tsx', 'MiniChart.tsx'].map((f) => `src/shared/${f}`);

describe('Learn screens: small decisions', () => {
  it('LEARN-56: the tutorial opens on the first step not done yet, and counts only real steps', () => {
    expect(firstOpenStep([], 9)).toBe(0);
    expect(firstOpenStep([1, 2, 3], 9)).toBe(3);
    expect(firstOpenStep([1, 3], 9)).toBe(1);
    expect(firstOpenStep([1, 2, 3, 4, 5, 6, 7, 8, 9], 9)).toBe(0);
    expect(doneCount([1, 1, 2, 12, 0, -1, 2.5], 9)).toBe(2);
    expect(tutorialLabel([], 9)).toBe('Tutorial');
    expect(tutorialLabel([1, 2], 9)).toBe('Tutorial (2/9)');
    expect(tutorialLabel([1, 2, 3, 4, 5, 6, 7, 8, 9], 9)).toBe('Tutorial (done)');
  });

  it('LEARN-57: a new player starts with the tutorial; once it is finished, or he has answered a lesson, the lessons open first', () => {
    expect(defaultView([], 9, 0)).toBe('tutorial');
    expect(defaultView([1, 2, 3], 9, 0)).toBe('tutorial');
    expect(defaultView([1, 2, 3, 4, 5, 6, 7, 8, 9], 9, 0)).toBe('lessons');
    expect(defaultView([], 9, 1)).toBe('lessons');
  });

  it('LEARN-58: the practice list: percent good, the words, and the weak spots (tried twice at least, under 60 %, worst first, at most three)', () => {
    expect(goodPercent({ seen: 0, best: 0, ok: 0 })).toBeNull();
    expect(goodPercent({ seen: 3, best: 1, ok: 1 })).toBe(67);
    expect(goodPercent({ seen: 4, best: 0, ok: 0 })).toBe(0);
    expect(statText({ seen: 0, best: 0, ok: 0 })).toBe('not tried yet');
    expect(statText({ seen: 1, best: 1, ok: 0 })).toBe('1 try · 100 % good');
    expect(statText({ seen: 3, best: 1, ok: 1 })).toBe('3 tries · 67 % good');
    const s = (name: string, seen: number, best: number, ok: number) => ({ name, seen, best, ok });
    expect(weakSpots([s('A', 1, 0, 0), s('B', 5, 5, 0), s('C', 3, 0, 1), s('D', 2, 0, 0), s('E', 4, 1, 0), s('F', 4, 0, 0), s('G', 2, 1, 0)])).toEqual(['D', 'F', 'E']);
    expect(weakSpots([])).toEqual([]);
  });

  it('LEARN-59: the "why" box is offered only when the AI is on and comments are left; the notes for a missing comment are calm and never show an error', () => {
    expect(canExplain({ enabled: true, leftToday: 3 })).toBe(true);
    expect(canExplain({ enabled: true, leftToday: 0 })).toBe(false);
    expect(canExplain({ enabled: false, leftToday: 5 })).toBe(false);
    expect(coachNote('ok')).toBeNull();
    expect(coachNote('off')).toBeNull();
    expect(coachNote('limit')).toMatch(/used today's AI comments/);
    expect(coachNote('failed')).toMatch(/could not answer just now/);
    for (const r of ['limit', 'failed'] as const) expect(coachNote(r)).not.toMatch(/\b(error|500|401|key|status)\b/i);
  });

  it('LEARN-60: how a grade is announced, and the XP text', () => {
    expect(gradeBanner('best')).toEqual({ label: 'Best move', tone: 'good' });
    expect(gradeBanner('ok')).toEqual({ label: 'Acceptable', tone: 'fair' });
    expect(gradeBanner('wrong')).toEqual({ label: 'Not this time', tone: 'bad' });
    expect(xpText(10)).toBe('+10 XP');
    expect(xpText(0)).toBe('no XP this time');
  });

  it('LEARN-61: what the browser remembers (one setting, one mark) is guarded: it works without storage and with storage that throws', () => {
    const saved = (globalThis as { localStorage?: unknown }).localStorage;
    try {
      // No storage at all.
      (globalThis as { localStorage?: unknown }).localStorage = undefined;
      expect(readWhyPref()).toBe(false);
      expect(learnSeen()).toBe(false);
      expect(() => writeWhyPref(true)).not.toThrow();
      expect(() => markLearnSeen()).not.toThrow();
      // Storage that refuses everything.
      (globalThis as { localStorage?: unknown }).localStorage = {
        getItem() {
          throw new Error('blocked');
        },
        setItem() {
          throw new Error('blocked');
        },
      };
      expect(readWhyPref()).toBe(false);
      expect(learnSeen()).toBe(false);
      expect(() => writeWhyPref(true)).not.toThrow();
      expect(() => markLearnSeen()).not.toThrow();
      // Storage that works.
      const data = new Map<string, string>();
      (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
      expect(readWhyPref()).toBe(false);
      writeWhyPref(true);
      expect(readWhyPref()).toBe(true);
      writeWhyPref(false);
      expect(readWhyPref()).toBe(false);
      expect(learnSeen()).toBe(false);
      markLearnSeen();
      expect(learnSeen()).toBe(true);
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = saved;
    }
  });
});

describe('Learn screens: the browser only asks and shows', () => {
  it('LEARN-62: no screen makes a lesson, grades, rolls dice or knows the AI settings', () => {
    for (const file of SCREENS) {
      const text = code(read(file));
      expect(text, file).not.toMatch(/Math\.random|crypto\.|Date\.now|new Date/);
      expect(text, file).not.toMatch(/\bgradeOf\b|\bresultsOf\b|\bdirectionGrade\b|\bsizeResults\b|\bgenerateDirection\b|\bgenerateSize\b|\bbuiltInCoach\b|\bbuildCoachPrompt\b/);
      expect(text, file).not.toMatch(/from '\.\.\/server|TQ_AI|apiKey|x-api-key|api\.anthropic|api\.openai/);
      expect(text, file).not.toMatch(/\bfetch\(/); // only api.ts talks to the server
    }
    // The lesson screens import the generator for one thing only: how a price is written.
    for (const file of ['src/shared/LearnScreen.tsx', 'src/shared/LessonsView.tsx']) {
      const text = code(read(file));
      const generateImports = [...text.matchAll(/import \{([^}]*)\} from '\.\.\/learn\/generate'/g)].map((m) => (m[1] as string).trim());
      for (const names of generateImports) expect(names, file).toBe('lessonPrice');
      expect(text, file).not.toMatch(/\bgenerate\(/);
    }
  });

  it('LEARN-63: the AI\'s words and the player\'s words are shown as plain text (never as HTML), and storage goes only through the guarded helpers', () => {
    for (const file of SCREENS) {
      const text = code(read(file));
      expect(text, file).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|\beval\(/);
      expect(text, file).not.toMatch(/localStorage|sessionStorage/); // learnUtil.ts holds the only (try/catch guarded) access
    }
    expect(code(read('src/shared/learnUtil.ts'))).toMatch(/try \{[\s\S]*localStorage[\s\S]*\} catch/);
    // The text box sends at most what the server keeps.
    expect(read('src/shared/LessonsView.tsx')).toMatch(/maxLength=\{REASON_MAX\}/);
    expect(read('src/shared/LessonsView.tsx')).toMatch(/const REASON_MAX = 300;/);
  });

  it('LEARN-64: the Learn tab sits in the Career tabs after Launch, the routes in api.ts match the server, and every class the screens use is styled', () => {
    const app = read('src/shared/SharedApp.tsx');
    expect(app).toMatch(/\['launch', 'Launch'\],\s*\['learn', 'Learn'\],\s*\['players', 'Players'\]/);
    expect(app).toMatch(/careerTab === 'learn' && <LearnScreen \/>/);
    const api = read('src/shared/api.ts');
    for (const path of ['/api/learn/state', '/api/learn/tutorial', '/api/learn/lesson/start', '/api/learn/lesson/answer', '/api/learn/lesson/skip', '/api/learn/lesson/coach']) expect(api).toContain(`'${path}'`);
    // Every class named in the Learn screens has a rule in styles.css (or is a class the game already styles).
    const css = read('src/styles.css');
    const used = new Set<string>();
    for (const file of [...SCREENS, 'src/shared/SharedApp.tsx']) {
      const text = read(file);
      for (const m of text.matchAll(/className=(?:"([^"]+)"|'([^']+)')/g)) for (const c of ((m[1] ?? m[2]) as string).split(/\s+/)) used.add(c);
      for (const m of text.matchAll(/className=\{`([^`]+)`\}/g)) for (const c of (m[1] as string).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (c) used.add(c);
      for (const m of text.matchAll(/className=\{([^}`]*)\}/g)) for (const q of (m[1] as string).matchAll(/[?:]\s*'([^']+)'/g)) for (const c of (q[1] as string).split(/\s+/)) used.add(c);
    }
    const missing = [...used].filter((c) => c && !new RegExp(`\\.${c.replace(/[-]/g, '\\-')}(?![a-zA-Z0-9_-])`).test(css));
    expect(missing).toEqual([]);
  });
});
