// Search-engine files (index.html, public/robots.txt, public/sitemap.xml). The properties that matter: Google's site-verification tag is in the page head of the front page;
// robots.txt lets search engines in, keeps them out of /api/, and points at the sitemap; the sitemap lists the front page on the same address; and the server sends those two
// files with the right content types (not the app's front page, which it hands out for any unknown path).
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../server/app';
import { loadConfig } from '../server/config';
import { Logger } from '../server/log';
import { Clock } from './helpers/server';

const ROOT = process.cwd();
const SITE = 'https://tradequest-40gb.onrender.com';
const TOKEN = 'KIiwZ1BDCGF6z9sxoUsaNZdSjpv-ffPVDQfmGQ-O30s';

const running: { app: App; server: Server }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (running.length > 0) {
    const r = running.pop() as { app: App; server: Server };
    await new Promise<void>((done) => {
      r.server.closeAllConnections?.();
      r.server.close(() => done());
    });
    try {
      r.app.close();
    } catch {
      // already closed by the test
    }
  }
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

// A site folder laid out the way `vite build` leaves dist: index.html and everything from public/ side by side.
async function bootWithSite(): Promise<string> {
  const data = mkdtempSync(join(tmpdir(), 'tq-seo-data-'));
  const site = mkdtempSync(join(tmpdir(), 'tq-seo-site-'));
  dirs.push(data, site);
  copyFileSync(join(ROOT, 'index.html'), join(site, 'index.html'));
  copyFileSync(join(ROOT, 'public', 'robots.txt'), join(site, 'robots.txt'));
  copyFileSync(join(ROOT, 'public', 'sitemap.xml'), join(site, 'sitemap.xml'));
  const clock = new Clock();
  const config = loadConfig({ TQ_DATA_DIR: data, TQ_COMPANIES: '12', TQ_WARMUP_DAYS: '1', TQ_PORT: '8787', TQ_OWNER: 'boss' });
  const app = createApp({ config, log: new Logger({ sink: null, now: clock.now }), worldSeed: 777, now: clock.now, flowGain: 0, staticDir: site });
  const server = createServer(app.handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  running.push({ app, server });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Search-engine files', () => {
  it('SEO-1: the front page carries Google\'s site-verification tag inside <head>, exactly once', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    const tags = head.match(/<meta\s+name="google-site-verification"\s+content="[^"]*"\s*\/?>/g) ?? [];
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain(`content="${TOKEN}"`);
    expect(html.match(/google-site-verification/g)).toHaveLength(1);
  });

  it('SEO-2: robots.txt lets search engines in, keeps them out of /api/, and names the sitemap', () => {
    const text = readFileSync(join(ROOT, 'public', 'robots.txt'), 'utf8');
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain('User-agent: *');
    expect(lines).toContain('Allow: /');
    expect(lines).toContain('Disallow: /api/');
    expect(lines).toContain(`Sitemap: ${SITE}/sitemap.xml`);
    expect(lines.filter((l) => /^Disallow:\s*\/?\s*$/.test(l))).toHaveLength(0); // never a blanket block of the whole site
  });

  it('SEO-3: sitemap.xml is a plain sitemap that lists the front page on the same address as robots.txt', () => {
    const xml = readFileSync(join(ROOT, 'public', 'sitemap.xml'), 'utf8');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([`${SITE}/`]);
    expect(xml.match(/<url>/g)).toHaveLength(1);
    expect(xml.match(/<\/url>/g)).toHaveLength(1);
    expect(xml.trim().endsWith('</urlset>')).toBe(true);
  });

  it('SEO-4: the server sends robots.txt as plain text and sitemap.xml as XML, not the app\'s front page', async () => {
    const base = await bootWithSite();
    const robots = await fetch(`${base}/robots.txt`);
    expect(robots.status).toBe(200);
    expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const robotsBody = await robots.text();
    expect(robotsBody).toBe(readFileSync(join(ROOT, 'public', 'robots.txt'), 'utf8'));
    expect(robotsBody).not.toContain('<html');

    const map = await fetch(`${base}/sitemap.xml`);
    expect(map.status).toBe(200);
    expect(map.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(map.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await map.text()).toBe(readFileSync(join(ROOT, 'public', 'sitemap.xml'), 'utf8'));
  });

  it('SEO-5: the front page served at / shows the verification tag; other unknown paths still get the app; /api is untouched', async () => {
    const base = await bootWithSite();
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await home.text()).toContain(`<meta name="google-site-verification" content="${TOKEN}" />`);

    const other = await fetch(`${base}/some/page/that/is/not/a/file`);
    expect(other.status).toBe(200);
    expect(other.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const api = await fetch(`${base}/api/nope-not-real`);
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toContain('application/json');
  });
});
