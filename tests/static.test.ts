// ENG-15 and engine isolation — the engine must stay deterministic and React-free.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const engineDir = resolve(process.cwd(), 'src', 'engine');
const files = readdirSync(engineDir).filter((f) => f.endsWith('.ts'));
const worldDir = resolve(process.cwd(), 'src', 'world');
const worldFiles = readdirSync(worldDir).filter((f) => f.endsWith('.ts'));

function strip(text: string): string {
  // Strip comments so documentation that mentions forbidden calls doesn't count.
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function source(file: string): string {
  return readFileSync(join(engineDir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('Engine source rules', () => {
  it('ENG-15: no Math.random, Date.now, time or non-basic Math functions anywhere in the engine', () => {
    expect(files.length).toBeGreaterThan(5);
    const forbidden =
      /Math\.(random|exp|log|log2|log10|sin|cos|tan|pow|sqrt|cbrt|hypot)\b|Date\.now|new Date|performance\.now|crypto\./;
    for (const f of files) {
      const match = source(f).match(forbidden);
      expect(match ? `${f}: ${match[0]}` : null).toBeNull();
    }
  });

  it('Math.imul is used only by the RNG', () => {
    for (const f of files) {
      if (f !== 'rng.ts') expect(source(f).includes('Math.imul')).toBe(false);
    }
  });

  it('the engine does not import React, the UI or the app layer', () => {
    for (const f of files) {
      expect(/from ['"](react|react-dom|\.\.\/ui|\.\.\/app)/.test(source(f))).toBe(false);
    }
  });
});

// The persistent world (src/world) is the part that must give the same prices on every machine and after every restart.
describe('World source rules', () => {
  const forbidden = /Math\.(random|exp|log|log2|log10|sin|cos|tan|pow|sqrt|cbrt|hypot)\b|Date\.now|new Date|performance\.now|crypto\.|Math\.imul/;

  it('WORLD-1: no randomness, clocks or platform-dependent maths in src/world', () => {
    expect(worldFiles.length).toBeGreaterThan(5);
    for (const f of worldFiles) {
      const text = strip(readFileSync(join(worldDir, f), 'utf8'));
      const match = text.match(forbidden);
      expect(match ? `${f}: ${match[0]}` : null).toBeNull();
    }
  });

  it('WORLD-2: src/world does not import React, the UI, the app layer or the server', () => {
    for (const f of worldFiles) {
      const text = strip(readFileSync(join(worldDir, f), 'utf8'));
      expect(/from ['"](react|react-dom|\.\.\/ui|\.\.\/app|\.\.\/\.\.\/server|node:)/.test(text)).toBe(false);
    }
  });

  it('WORLD-3: the server never uses Math.random (tokens use node:crypto; the market uses the deterministic generator)', () => {
    const serverDir = resolve(process.cwd(), 'server');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
    const all = walk(serverDir);
    expect(all.length).toBeGreaterThan(8);
    for (const f of all) expect(strip(readFileSync(f, 'utf8')).includes('Math.random') ? f : null).toBeNull();
  });
});

