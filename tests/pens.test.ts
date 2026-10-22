// Pens on the price charts: where a drawing lives (tick and price, not screen position), how it is saved and read back, the eraser,
// undo, and that the chart screens really use all of it. The drawing is only a visual aid and never reaches the server.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ERASE_RADIUS,
  MAX_HISTORY,
  MAX_POINTS,
  MAX_STROKES,
  PEN_COLORS,
  PEN_WIDTHS,
  browserStore,
  eraseAt,
  farEnough,
  fromPlot,
  loadStrokes,
  nextStrokeId,
  parseStrokes,
  pathOf,
  pointSegmentDistance,
  pushHistory,
  saveStrokes,
  serializeStrokes,
  storageKeyOf,
  strokeTouches,
  toPlot,
  withStroke,
  type KeyValueStore,
  type PenGeometry,
  type Stroke,
} from '../src/ui/chartPens';

const geo: PenGeometry = { openTick0: 1000, ticksPerCandle: 10, slotW: 20, start: 0, lo: 1000, hi: 2000, plotH: 300 };
const stroke = (id: number, points: [number, number][], color = '#ef4444', width = 4): Stroke => ({ id, color, width, points: points.map(([t, p]) => ({ t, p })) });
const memoryStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe('Pens: where a drawing lives', () => {
  it('PEN-1: a point is a tick and a price; the screen position follows the chart scale, and back again gives the same point', () => {
    // 20 px per candle of 10 ticks: tick 1010 is one candle to the right of the first candle's left edge. Price 2000 is the top, 1000 the bottom.
    expect(toPlot(geo, { t: 1010, p: 2000 })).toEqual({ x: 20, y: 0 });
    expect(toPlot(geo, { t: 1000, p: 1000 })).toEqual({ x: 0, y: 300 });
    expect(toPlot(geo, { t: 1005, p: 1500 })).toEqual({ x: 10, y: 150 });
    for (const pt of [{ t: 1234, p: 1777 }, { t: 1000, p: 1000 }, { t: 1099, p: 1999.5 }]) {
      const s = toPlot(geo, pt);
      const back = fromPlot(geo, s.x, s.y);
      expect(back.t).toBeCloseTo(pt.t, 6);
      expect(back.p).toBeCloseTo(pt.p, 6);
    }
  });

  it('PEN-2: scrolling does not move a drawing on the candles: the scroll position only changes where the pointer is turned into a tick', () => {
    const scrolled: PenGeometry = { ...geo, start: 5 };
    // The same pointer position is a later tick when the chart is scrolled five candles to the right...
    expect(fromPlot(scrolled, 0, 0).t).toBe(geo.openTick0 + 5 * geo.ticksPerCandle);
    // ...and a stored point is at the same place on the layer whatever the scroll (the layer itself is what slides).
    expect(toPlot(scrolled, { t: 1234, p: 1500 })).toEqual(toPlot(geo, { t: 1234, p: 1500 }));
  });

  it('PEN-3: when the price axis changes the drawing keeps its prices: it moves with the candles, not with the screen', () => {
    const pt = { t: 1050, p: 1500 };
    const before = toPlot(geo, pt).y;
    const zoomed: PenGeometry = { ...geo, lo: 1400, hi: 1600 };
    expect(toPlot(zoomed, pt).y).toBe(150); // the middle of the new range
    expect(toPlot(zoomed, { t: 1050, p: 1600 }).y).toBe(0);
    expect(before).toBe(150);
  });

  it('PEN-4: a drawing is the same at another candle size: ticks are ticks (an hour candle is 360 ten-tick candles wide)', () => {
    const hour: PenGeometry = { ...geo, ticksPerCandle: 3600, slotW: 20 };
    expect(toPlot(hour, { t: 1000 + 1800, p: 1500 }).x).toBe(10);
    expect(toPlot(geo, { t: 1000 + 1800, p: 1500 }).x).toBe(3600);
  });
});

describe('Pens: saving and reading back', () => {
  it('PEN-5: strokes are saved per chart key and read back exactly', () => {
    const store = memoryStore();
    const list = [stroke(1, [[1000, 1500], [1010, 1600]]), stroke(2, [[1100, 1200]], '#22c55e', 8)];
    expect(saveStrokes(store, 'QLRX', list)).toBe(true);
    expect(saveStrokes(store, 'ZYRA', [stroke(1, [[5, 5]])])).toBe(true);
    expect(loadStrokes(store, 'QLRX')).toEqual(list);
    expect(loadStrokes(store, 'ZYRA')).toHaveLength(1);
    expect(loadStrokes(store, 'NONE')).toEqual([]);
    expect([...store.data.keys()].sort()).toEqual([storageKeyOf('QLRX'), storageKeyOf('ZYRA')].sort());
  });

  it('PEN-6: broken, hostile or foreign saved data is dropped, never trusted', () => {
    expect(parseStrokes(null)).toEqual([]);
    expect(parseStrokes('')).toEqual([]);
    expect(parseStrokes('not json')).toEqual([]);
    expect(parseStrokes('{"v":1}')).toEqual([]);
    expect(parseStrokes('{"strokes":"x"}')).toEqual([]);
    const good = { id: 1, color: '#ffffff', width: 4, points: [{ t: 1, p: 2 }] };
    const bad = [
      { ...good, id: 2, color: 'red' },
      { ...good, id: 3, color: '#12345' },
      { ...good, id: 4, color: 'url(javascript:alert(1))' },
      { ...good, id: 5, width: 0 },
      { ...good, id: 6, width: 99 },
      { ...good, id: 7, points: [] },
      { ...good, id: 8, points: [{ t: 'a', p: 1 }] },
      { ...good, id: 9, points: [{ t: Number.NaN, p: 1 }] },
      { ...good, id: 1.5 },
      { ...good, id: 10, points: new Array(MAX_POINTS + 1).fill({ t: 1, p: 1 }) },
      null,
      'x',
      42,
    ];
    const text = JSON.stringify({ v: 1, strokes: [good, ...bad, { ...good }] }); // the last one repeats an id
    const out = parseStrokes(text);
    expect(out).toEqual([good]);
  });

  it('PEN-7: a list never grows past the limits: the oldest strokes go first', () => {
    let list: Stroke[] = [];
    for (let i = 1; i <= MAX_STROKES + 25; i += 1) list = withStroke(list, stroke(i, [[i, i]]));
    expect(list).toHaveLength(MAX_STROKES);
    expect(list[0]?.id).toBe(26);
    expect(list[list.length - 1]?.id).toBe(MAX_STROKES + 25);
    expect(nextStrokeId(list)).toBe(MAX_STROKES + 26);
    expect(nextStrokeId([])).toBe(1);
    let h: number[] = [];
    for (let i = 0; i < MAX_HISTORY + 10; i += 1) h = pushHistory(h, i);
    expect(h).toHaveLength(MAX_HISTORY);
    expect(h[0]).toBe(10);
    expect(parseStrokes(serializeStrokes(list))).toHaveLength(MAX_STROKES);
  });

  it('PEN-8: blocked or full storage does not break drawing: loading gives an empty list and saving says it did not work', () => {
    const blocked: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadStrokes(blocked, 'QLRX')).toEqual([]);
    expect(saveStrokes(blocked, 'QLRX', [stroke(1, [[1, 1]])])).toBe(false);
    expect(loadStrokes(null, 'QLRX')).toEqual([]);
    expect(saveStrokes(null, 'QLRX', [])).toBe(false);
    // In a place without local storage at all (these tests), the browser store is simply "none".
    expect(browserStore() === null || typeof browserStore()?.getItem === 'function').toBe(true);
  });
});

describe('Pens: erasing and drawing', () => {
  const screen = (pt: { t: number; p: number }) => toPlot(geo, pt);

  it('PEN-9: the eraser removes the strokes it touches and nothing else; it returns the same list when it touched nothing', () => {
    const a = stroke(1, [[1000, 1500], [1100, 1500]]); // a horizontal line in the middle
    const b = stroke(2, [[1000, 1100], [1100, 1100]]); // near the bottom
    const dot = stroke(3, [[1050, 1900]]);
    const list = [a, b, dot];
    const mid = screen({ t: 1050, p: 1500 });
    expect(eraseAt(list, mid.x, mid.y, ERASE_RADIUS, screen).map((s) => s.id)).toEqual([2, 3]);
    const nearDot = screen({ t: 1050, p: 1900 });
    expect(eraseAt(list, nearDot.x + 3, nearDot.y - 3, ERASE_RADIUS, screen).map((s) => s.id)).toEqual([1, 2]);
    const nothing = screen({ t: 1050, p: 1300 });
    expect(eraseAt(list, nothing.x, nothing.y, ERASE_RADIUS, screen)).toBe(list);
    // A touch just outside the reach (radius + half the line width) misses; just inside hits.
    const reach = ERASE_RADIUS + a.width / 2;
    expect(strokeTouches(a, mid.x, mid.y + reach + 1, ERASE_RADIUS, screen)).toBe(false);
    expect(strokeTouches(a, mid.x, mid.y + reach - 1, ERASE_RADIUS, screen)).toBe(true);
  });

  it('PEN-10: distance to a segment, including the ends and a segment that is a point', () => {
    expect(pointSegmentDistance(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(pointSegmentDistance(-4, 3, 0, 0, 10, 0)).toBe(5);
    expect(pointSegmentDistance(14, 3, 0, 0, 10, 0)).toBe(5);
    expect(pointSegmentDistance(3, 4, 0, 0, 0, 0)).toBe(5);
  });

  it('PEN-11: a new point is only added when the pointer moved far enough, so a stroke stays small', () => {
    expect(farEnough(0, 0, 1, 1)).toBe(false);
    expect(farEnough(0, 0, 3, 0)).toBe(true);
    expect(farEnough(10, 10, 10, 12.4)).toBe(false);
  });

  it('PEN-12: the SVG path: a dot, a straight line, and a smooth curve through three or more points; always finite numbers', () => {
    const toS = (pt: { t: number; p: number }) => ({ x: pt.t, y: pt.p });
    expect(pathOf(stroke(1, []), toS)).toBe('');
    expect(pathOf(stroke(1, [[10, 20]]), toS)).toBe('M10,20 l0.01,0');
    expect(pathOf(stroke(1, [[0, 0], [10, 10]]), toS)).toBe('M0,0 L10,10');
    const curve = pathOf(stroke(1, [[0, 0], [10, 10], [20, 0], [30, 10]]), toS);
    expect(curve.startsWith('M0,0 Q10,10 15,5')).toBe(true);
    expect(curve.endsWith('L30,10')).toBe(true);
    expect(curve).not.toMatch(/NaN|Infinity/);
  });

  it('PEN-13: there are several colours and three sizes, all valid for saving', () => {
    expect(PEN_COLORS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(PEN_COLORS.map((c) => c.value)).size).toBe(PEN_COLORS.length);
    for (const c of PEN_COLORS) expect(c.value).toMatch(/^#[0-9a-f]{6}$/i);
    expect(PEN_WIDTHS.map((w) => w.value)).toEqual([2, 4, 8]);
    const all = PEN_COLORS.flatMap((c) => PEN_WIDTHS.map((w, i) => stroke(i + 1, [[1, 1]], c.value, w.value)));
    expect(parseStrokes(JSON.stringify({ v: 1, strokes: all.map((s, i) => ({ ...s, id: i + 1 })) }))).toHaveLength(all.length);
  });
});

describe('Pens: in the screens', () => {
  /** The file's code without its comments. */
  const read = (...parts: string[]): string =>
    readFileSync(resolve(process.cwd(), 'src', ...parts), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('PEN-14: the shared market chart (Career and 1v1) has pens, saved per company; the practice chart has them in memory only; the drawings never go to the server', () => {
    const company = read('shared', 'CompanyChart.tsx');
    expect(company).toMatch(/penKey=\{ticker\}/);
    const live = read('LiveApp.tsx');
    expect(live).toMatch(/penKey=/);
    expect(live).toMatch(/penPersist=\{false\}/);
    const chart = read('ui', 'LiveChart.tsx');
    expect(chart).toMatch(/<PenToolbar pens=\{pens\} \/>/);
    expect(chart).toMatch(/<PenLayer/);
    expect(chart).toMatch(/usePens\(penKey/);
    for (const file of [read('ui', 'chartPens.ts'), read('ui', 'usePens.ts'), read('ui', 'PenLayer.tsx')]) {
      expect(file).not.toMatch(/fetch\(|api\.|XMLHttpRequest|sendBeacon|Math\.random|Date\.now/);
    }
    // Saving goes through the guarded helpers only (storage can be blocked).
    expect(read('ui', 'usePens.ts')).not.toMatch(/localStorage|sessionStorage/);
    expect(read('ui', 'chartPens.ts')).toMatch(/try \{[\s\S]*localStorage/);
  });

  it('PEN-15: the toolbar has the tools the player asked for', () => {
    const bar = read('ui', 'PenLayer.tsx');
    for (const id of ['pen-toggle', 'pen-tool-pen', 'pen-tool-eraser', 'pen-undo', 'pen-clear', 'pen-visibility', 'pen-capture']) expect(bar).toContain(`data-testid="${id}"`);
    expect(bar).toMatch(/pen-color-/);
    expect(bar).toMatch(/pen-size-/);
  });
});
