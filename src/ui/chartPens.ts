// Pens for the price charts: the maths and the saving, kept free of React so they can be unit-tested.
//
// A drawing is a list of strokes. Every point of a stroke is stored as (tick, price), not as a screen position, so a drawing stays on
// the candles and the prices where it was made when the chart scrolls, when it is resized, when the price axis changes and when the
// candle size is switched (10 ticks, 1 hour, 1 day). Drawings are saved in the browser, one list per chart key (a company).
// They are only a visual aid: nothing here is sent to the server and nothing here changes a price, a trade or an account.

/** One point of a stroke: the market tick it is at and the price (cents) it is at. */
export interface PenPoint {
  readonly t: number;
  readonly p: number;
}

export interface Stroke {
  /** Unique within one list; a new stroke gets the highest id plus 1. */
  readonly id: number;
  /** '#rrggbb'. */
  readonly color: string;
  /** Line width in screen pixels. */
  readonly width: number;
  readonly points: readonly PenPoint[];
}

export const PEN_COLORS: readonly { readonly name: string; readonly value: string }[] = [
  { name: 'White', value: '#f8fafc' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Yellow', value: '#facc15' },
  { name: 'Blue', value: '#38bdf8' },
  { name: 'Purple', value: '#c084fc' },
];

export const PEN_WIDTHS: readonly { readonly name: string; readonly value: number }[] = [
  { name: 'Thin', value: 2 },
  { name: 'Medium', value: 4 },
  { name: 'Thick', value: 8 },
];

/** At most this many strokes are kept per chart (the oldest go first) and this many points per stroke. */
export const MAX_STROKES = 200;
export const MAX_POINTS = 600;
/** The eraser removes every stroke that passes within this many screen pixels of the pointer. */
export const ERASE_RADIUS = 12;
/** A new point is only added when the pointer moved at least this many screen pixels. */
export const MIN_POINT_GAP = 2.5;
/** How many steps back "Undo" can go. */
export const MAX_HISTORY = 50;

const KEY_PREFIX = 'tq.pens.v1.';
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function storageKeyOf(chartKey: string): string {
  return `${KEY_PREFIX}${chartKey}`;
}

/** The part of the browser's storage that is used (so tests can pass a fake one). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's local storage, or null where it is blocked or missing (a private window, cleared site data...). */
export function browserStore(): KeyValueStore | null {
  try {
    const s = (globalThis as { localStorage?: KeyValueStore }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

/** Reads a saved list defensively: anything that is not exactly a stroke is dropped; bad or missing data gives an empty list. */
export function parseStrokes(text: string | null): Stroke[] {
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (data as { v?: unknown; strokes?: unknown } | null)?.strokes;
  if (!Array.isArray(list)) return [];
  const out: Stroke[] = [];
  const seen = new Set<number>();
  for (const raw of list) {
    const s = raw as { id?: unknown; color?: unknown; width?: unknown; points?: unknown } | null;
    if (!s || typeof s.id !== 'number' || !Number.isInteger(s.id) || seen.has(s.id)) continue;
    if (typeof s.color !== 'string' || !COLOR_RE.test(s.color)) continue;
    if (typeof s.width !== 'number' || !Number.isFinite(s.width) || s.width < 1 || s.width > 16) continue;
    if (!Array.isArray(s.points) || s.points.length === 0 || s.points.length > MAX_POINTS) continue;
    const points: PenPoint[] = [];
    let ok = true;
    for (const q of s.points) {
      const pt = q as { t?: unknown; p?: unknown } | null;
      if (!pt || typeof pt.t !== 'number' || typeof pt.p !== 'number' || !Number.isFinite(pt.t) || !Number.isFinite(pt.p)) {
        ok = false;
        break;
      }
      points.push({ t: pt.t, p: pt.p });
    }
    if (!ok) continue;
    seen.add(s.id);
    out.push({ id: s.id, color: s.color, width: s.width, points });
  }
  return out.slice(-MAX_STROKES);
}

export function serializeStrokes(strokes: readonly Stroke[]): string {
  return JSON.stringify({ v: 1, strokes });
}

export function loadStrokes(store: KeyValueStore | null, chartKey: string): Stroke[] {
  if (!store) return [];
  try {
    return parseStrokes(store.getItem(storageKeyOf(chartKey)));
  } catch {
    return [];
  }
}

/** Saves the list; false when the browser refused (full or blocked storage). The drawing still works, it just will not survive a reload. */
export function saveStrokes(store: KeyValueStore | null, chartKey: string, strokes: readonly Stroke[]): boolean {
  if (!store) return false;
  try {
    store.setItem(storageKeyOf(chartKey), serializeStrokes(strokes));
    return true;
  } catch {
    return false;
  }
}

/** The id for a new stroke: one more than the highest id in the list. */
export function nextStrokeId(strokes: readonly Stroke[]): number {
  let max = 0;
  for (const s of strokes) if (s.id > max) max = s.id;
  return max + 1;
}

/** Adds a finished stroke; the oldest strokes are dropped when there would be more than MAX_STROKES. */
export function withStroke(strokes: readonly Stroke[], stroke: Stroke): Stroke[] {
  const next = [...strokes, stroke];
  return next.length > MAX_STROKES ? next.slice(next.length - MAX_STROKES) : next;
}

/** Keeps the last MAX_HISTORY snapshots. */
export function pushHistory<T>(history: readonly T[], snapshot: T): T[] {
  const next = [...history, snapshot];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}

/** True when the pointer moved far enough from the last point of the stroke to add a new one. */
export function farEnough(lastX: number, lastY: number, x: number, y: number, gap = MIN_POINT_GAP): boolean {
  return Math.hypot(x - lastX, y - lastY) >= gap;
}

/** Distance from the point (px, py) to the segment (ax, ay)–(bx, by). */
export function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const k = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + k * dx), py - (ay + k * dy));
}

/** A function from a stroke point to a screen position (the chart knows its own scale). */
export type ToScreen = (pt: PenPoint) => { x: number; y: number };

/** True when the stroke passes within `radius` pixels of the screen position (x, y). Half the line width counts as part of the line. */
export function strokeTouches(stroke: Stroke, x: number, y: number, radius: number, toScreen: ToScreen): boolean {
  const reach = radius + stroke.width / 2;
  const first = stroke.points[0];
  if (!first) return false;
  let a = toScreen(first);
  if (stroke.points.length === 1) return Math.hypot(x - a.x, y - a.y) <= reach;
  for (let i = 1; i < stroke.points.length; i += 1) {
    const b = toScreen(stroke.points[i] as PenPoint);
    if (pointSegmentDistance(x, y, a.x, a.y, b.x, b.y) <= reach) return true;
    a = b;
  }
  return false;
}

/** The strokes left after the eraser touched the screen position (x, y). Returns the same array when nothing was touched. */
export function eraseAt(strokes: readonly Stroke[], x: number, y: number, radius: number, toScreen: ToScreen): readonly Stroke[] {
  const kept = strokes.filter((s) => !strokeTouches(s, x, y, radius, toScreen));
  return kept.length === strokes.length ? strokes : kept;
}

const r1 = (n: number): string => (Math.round(n * 10) / 10).toString();

/**
 * The SVG path of a stroke: a smooth line through the points (each point is the control point of a curve that ends half way to the
 * next one). One point is a dot (a zero-length line that the round line cap turns into a circle).
 */
export function pathOf(stroke: Stroke, toScreen: ToScreen): string {
  const pts = stroke.points.map(toScreen);
  const first = pts[0];
  if (!first) return '';
  if (pts.length === 1) return `M${r1(first.x)},${r1(first.y)} l0.01,0`;
  if (pts.length === 2) {
    const last = pts[1] as { x: number; y: number };
    return `M${r1(first.x)},${r1(first.y)} L${r1(last.x)},${r1(last.y)}`;
  }
  let d = `M${r1(first.x)},${r1(first.y)}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const c = pts[i] as { x: number; y: number };
    const n = pts[i + 1] as { x: number; y: number };
    d += ` Q${r1(c.x)},${r1(c.y)} ${r1((c.x + n.x) / 2)},${r1((c.y + n.y) / 2)}`;
  }
  const last = pts[pts.length - 1] as { x: number; y: number };
  d += ` L${r1(last.x)},${r1(last.y)}`;
  return d;
}

/** The chart's mapping between screen and (tick, price), so pointer positions and drawn points use the same maths. */
export interface PenGeometry {
  /** Tick at which the first candle of the chart opens. */
  readonly openTick0: number;
  /** Ticks in one candle. */
  readonly ticksPerCandle: number;
  /** Width of one candle slot in screen pixels. */
  readonly slotW: number;
  /** The slot at the left edge of the plot (scroll position). */
  readonly start: number;
  /** Price (cents) at the bottom and at the top of the plot. */
  readonly lo: number;
  readonly hi: number;
  /** Height of the plot in screen pixels. */
  readonly plotH: number;
}

/** (tick, price) → x in the scrolling layer (pixels from the first candle's left edge) and y in the plot (pixels from the top). */
export function toPlot(g: PenGeometry, pt: PenPoint): { x: number; y: number } {
  return { x: ((pt.t - g.openTick0) / g.ticksPerCandle) * g.slotW, y: ((g.hi - pt.p) / (g.hi - g.lo)) * g.plotH };
}

/** A position inside the plot (pixels from its left and top edge) → (tick, price). */
export function fromPlot(g: PenGeometry, localX: number, localY: number): PenPoint {
  const layerX = localX + g.start * g.slotW;
  return { t: g.openTick0 + (layerX / g.slotW) * g.ticksPerCandle, p: g.hi - (localY / g.plotH) * (g.hi - g.lo) };
}
