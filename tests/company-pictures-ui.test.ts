// The screens for the pictures of stocks and memecoins (docs/world.md §20): the letters and colour shown while a company has no picture, the page's
// list of pictures (loaded when it connects, kept fresh by the live event, never invented when the server cannot be reached), and the rules the
// screens keep: only the launcher and the owner are offered the buttons (and only because the SERVER said so), a launch picture is sent only after
// the launch worked, a visitor who is not signed in still gets the pictures, and every class the screens use is styled.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { companyPictureUrl, logoStore } from '../src/shared/logoStore';
import { logoColour, logoLetters } from '../src/shared/logoUtil';

const src = (...parts: string[]): string => readFileSync(resolve(process.cwd(), 'src', ...parts), 'utf8');
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
function answer(status: number, body: unknown): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
}

describe('the letters and the list of pictures', () => {
  it('CPUI-1: a company without a picture shows its first letter (two on a big logo) on a colour that is always the same for it', () => {
    expect(logoLetters('moon', 24)).toBe('M');
    expect(logoLetters('MPEP', 24)).toBe('M');
    expect(logoLetters('MPEP', 44)).toBe('MP');
    expect(logoLetters('  b.r-k ', 44)).toBe('BR');
    expect(logoLetters('', 24)).toBe('?');
    expect(logoLetters('$$$', 44)).toBe('?');
    expect(logoColour('ACMR')).toBe(logoColour('ACMR'));
    expect(logoColour('ACMR')).toMatch(/^hsl\(\d{1,3} 45% 34%\)$/);
    const colours = new Set(['ACMR', 'MPEP', 'WOOF', 'MEOW', 'QLRX', 'ZZZ', 'TOST', 'HODL'].map(logoColour));
    expect(colours.size).toBeGreaterThanOrEqual(6); // different tickers mostly get different colours
    expect(companyPictureUrl('ACMR', 12)).toBe('/api/company-picture/ACMR?v=12');
    expect(companyPictureUrl('A/B', 3)).toBe('/api/company-picture/A%2FB?v=3');
  });

  it('CPUI-2: the page keeps ticker -> version; the live event adds, replaces and removes one; a failed load keeps what it had', async () => {
    logoStore.onPicture({ ticker: 'OLD', v: 1 }); // whatever was there from before
    answer(200, { pictures: { ACMR: 100, MPEP: 200 } });
    await logoStore.load();
    expect(logoStore.getSnapshot().pictures).toEqual({ ACMR: 100, MPEP: 200 });
    let heard = 0;
    const off = logoStore.subscribe(() => (heard += 1));
    logoStore.onPicture({ ticker: 'WOOF', v: 300 });
    logoStore.onPicture({ ticker: 'ACMR', v: 101 });
    logoStore.onPicture({ ticker: 'MPEP', v: null });
    logoStore.onPicture({ ticker: 'NONE', v: null }); // removing what is not there is harmless
    expect(logoStore.getSnapshot().pictures).toEqual({ ACMR: 101, WOOF: 300 });
    expect(heard).toBe(4);
    off();
    answer(500, { error: { code: 'x', message: 'down' } });
    await logoStore.load();
    expect(logoStore.getSnapshot().pictures).toEqual({ ACMR: 101, WOOF: 300 });
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    await logoStore.load();
    expect(logoStore.getSnapshot().pictures).toEqual({ ACMR: 101, WOOF: 300 });
    answer(200, { pictures: {} });
    await logoStore.load();
    expect(logoStore.getSnapshot().pictures).toEqual({});
  });
});

describe('the screens', () => {
  it('CPUI-3: a picture is shown as an image only from the server address, with the letters as the fallback; nothing is built from markup', () => {
    const logo = code(src('shared', 'CompanyLogo.tsx'));
    expect(logo).toContain('companyPictureUrl(ticker, version)');
    expect(logo).toContain('onError={() => setFailed(true)}');
    expect(logo).toContain('logoLetters(ticker, size)');
    for (const file of ['CompanyLogo.tsx', 'CompanyPictureTools.tsx', 'logoStore.ts']) {
      const text = code(src('shared', file));
      expect([file, text.includes('dangerouslySetInnerHTML')]).toEqual([file, false]);
      expect([file, /\.innerHTML\s*=/.test(text)]).toEqual([file, false]);
    }
    // the only picture the page ever puts in an image of its own is the one just chosen on the launch form (a small JPEG made by the browser itself)
    const tools = code(src('shared', 'CompanyPictureTools.tsx'));
    expect(tools.match(/<img /g)?.length).toBe(1);
    expect(tools).toContain('src={image}');
  });

  it('CPUI-4: the buttons appear only when the server says the player may (the launcher or the owner); the owner\'s buttons need no other screen', () => {
    const tools = code(src('shared', 'CompanyPictureTools.tsx'));
    const box = /export function CompanyPictureBox[\s\S]*$/.exec(tools)?.[0] ?? '';
    expect(box).toContain('api.companyPictureRights(ticker)');
    expect(box).toContain('setMay(r.canChange)');
    expect(box).toContain('if (!may) return null;');
    expect(box).toContain('if (name === null) return;'); // a visitor never asks and never sees them
    // the company page uses the box; the launch card (only ever the player's own launches) uses the buttons directly
    expect(code(src('shared', 'CompanyView.tsx'))).toContain('<CompanyPictureBox ticker={detail.ticker} />');
    expect(code(src('shared', 'LaunchScreen.tsx'))).toContain('<CompanyPictureTools ticker={l.ticker} />');
    // every change carries a request number, and the owner's removal and setting use the same calls
    expect(tools).toContain('api.setCompanyPicture(ticker, image, newRequestId())');
    expect(tools).toContain('api.removeCompanyPicture(ticker, newRequestId())');
    const api = code(src('shared', 'api.ts'));
    for (const path of ["'/api/company-pictures'", '`/api/company-picture/${encodeURIComponent(ticker)}/rights`', '`/api/company-picture/${encodeURIComponent(ticker)}/remove`']) expect(api).toContain(path);
  });

  it('CPUI-5: a picture chosen on a launch form is sent only after the launch worked, and a failed upload never undoes or hides the launch', () => {
    const launch = code(src('shared', 'LaunchScreen.tsx'));
    for (const kind of ['coin', 'stock']) {
      expect(launch).toContain(`<LaunchPicturePicker kind="${kind}" image={picture} onImage={setPicture} />`);
      const made = kind === 'coin' ? 'await api.launchCoin(' : 'await api.launchStock(';
      const at = launch.indexOf(made);
      const sent = launch.indexOf('await sendLaunchPicture(res.ticker, picture)', at);
      expect(at).toBeGreaterThan(0);
      expect(sent).toBeGreaterThan(at); // after the launch call returned
      expect(sent - at).toBeLessThan(900); // in the same handler
    }
    expect(launch.match(/pictureNote === '' \? text : /g)?.length).toBe(2); // the launch message is always shown, with a sentence added when the picture failed
    const tools = code(src('shared', 'CompanyPictureTools.tsx'));
    const send = /export async function sendLaunchPicture[\s\S]*$/.exec(tools)?.[0] ?? '';
    expect(send).toContain('if (image === null) return null;');
    expect(send).toContain('catch (e)');
    expect(send).toContain('return problemText(e);'); // an error becomes words, never a thrown error
  });

  it('CPUI-6: pictures are for everybody: the list loads when the page connects (signed in or not) and the live event is wired in; every list shows the logo', () => {
    const store = code(src('shared', 'store.ts'));
    const hello = /addEventListener\('hello'[\s\S]*?\n    \}\);/.exec(store)?.[0] ?? '';
    expect(hello).toContain('void logoStore.load();');
    expect(hello.indexOf('logoStore.load()')).toBeLessThan(hello.indexOf('if (this.state.user)')); // not behind the sign-in
    expect(store).toContain("addEventListener('company_picture'");
    expect(store).toContain('logoStore.onPicture(');
    const listing = code(readFileSync(resolve(process.cwd(), 'server', 'routes', 'companyPictures.ts'), 'utf8'));
    expect(/router\.get\('\/api\/company-pictures', \(\) =>/.test(listing)).toBe(true); // no sign-in needed
    for (const [file, expected] of [
      ['MarketScreen.tsx', '<CompanyLogo ticker={row.ticker}'],
      ['AccountScreen.tsx', '<CompanyLogo ticker={p.ticker}'],
      ['CompanyView.tsx', '<CompanyLogo ticker={detail.ticker}'],
      ['LaunchScreen.tsx', '<CompanyLogo ticker={l.ticker}'],
    ] as const) {
      expect([file, code(src('shared', file)).includes(expected)]).toEqual([file, true]);
    }
  });

  it('CPUI-7: every class the picture screens use is styled', () => {
    const css = src('styles.css');
    const used = new Set<string>();
    for (const file of ['CompanyLogo.tsx', 'CompanyPictureTools.tsx']) {
      for (const m of code(src('shared', file)).matchAll(/className=(?:"([^"]+)"|\{[^}]*\})/g)) for (const c of (m[1] ?? '').split(/\s+/)) if (c.startsWith('logo')) used.add(c);
    }
    for (const c of ['logo', 'logo-inline', 'logo-title', 'logo-tools', 'logo-error', 'logo-pick']) expect(css.includes(`.${c} {`)).toBe(true);
    expect(used.has('logo-tools')).toBe(true);
    expect(used.has('logo-pick')).toBe(true);
    // classes that are only a hook for the code (no style of their own) are listed here on purpose
    const unstyledOk = new Set(['logo-letters']);
    for (const c of used) expect([c, css.includes(`.${c} {`) || css.includes(`.${c},`) || unstyledOk.has(c)]).toEqual([c, true]);
  });
});
