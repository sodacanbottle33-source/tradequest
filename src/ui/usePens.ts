// The state of the pens of one chart: the strokes, the tool, the colour and size, the undo steps, and the saving in the browser.
// Drawings are kept in memory per chart key (so they survive switching to another company and back) and, unless `persist` is off,
// also saved in the browser's local storage. Storage can be blocked or full: then the drawing still works for this visit.
import { useCallback, useEffect, useRef, useState } from 'react';
import { PEN_COLORS, PEN_WIDTHS, browserStore, loadStrokes, nextStrokeId, pushHistory, saveStrokes, withStroke, type PenPoint, type Stroke } from './chartPens';

export type PenTool = 'off' | 'pen' | 'eraser';

/** Strokes of every chart opened during this visit. */
const memory = new Map<string, readonly Stroke[]>();

export interface Pens {
  /** False when the chart has no key (no pens on this chart). */
  readonly enabled: boolean;
  readonly strokes: readonly Stroke[];
  readonly tool: PenTool;
  readonly color: string;
  readonly width: number;
  readonly visible: boolean;
  readonly canUndo: boolean;
  /** True when the last save did not work (the drawing is kept for this visit only). */
  readonly saveFailed: boolean;
  setTool(tool: PenTool): void;
  setColor(color: string): void;
  setWidth(width: number): void;
  setVisible(visible: boolean): void;
  /** Adds a finished stroke of the current colour and size. */
  addStroke(points: readonly PenPoint[]): void;
  /** The eraser went down: the list at this moment, to hand back to finishErase. */
  beginErase(): readonly Stroke[];
  /** Shows the list the eraser leaves while it moves (computed from the list as it is right now); nothing is remembered or saved until finishErase. */
  previewErase(update: (current: readonly Stroke[]) => readonly Stroke[]): void;
  /** The eraser was lifted: `before` is the list when it went down. If strokes were removed this is one undo step. */
  finishErase(before: readonly Stroke[]): void;
  undo(): void;
  clear(): void;
}

export function usePens(chartKey: string | null | undefined, persist = true): Pens {
  const key = chartKey ?? null;
  const [strokes, setStrokesState] = useState<readonly Stroke[]>([]);
  // The undo steps live in a ref (so they are never changed inside a state update); canUndo only tells the buttons.
  const historyRef = useRef<readonly (readonly Stroke[])[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [tool, setTool] = useState<PenTool>('off');
  const [color, setColor] = useState<string>(PEN_COLORS[0]?.value ?? '#f8fafc');
  const [width, setWidth] = useState<number>(PEN_WIDTHS[1]?.value ?? 4);
  const [visible, setVisible] = useState(true);
  const [saveFailed, setSaveFailed] = useState(false);
  const strokesRef = useRef<readonly Stroke[]>([]);

  const remember = useCallback((snapshot: readonly Stroke[]) => {
    historyRef.current = pushHistory(historyRef.current, snapshot);
    setCanUndo(true);
  }, []);

  // Another chart: load its drawing, start with an empty undo list.
  useEffect(() => {
    if (key === null) {
      strokesRef.current = [];
      setStrokesState([]);
      historyRef.current = [];
      setCanUndo(false);
      return;
    }
    const known = memory.get(key);
    const loaded = known ?? (persist ? loadStrokes(browserStore(), key) : []);
    memory.set(key, loaded);
    strokesRef.current = loaded;
    setStrokesState(loaded);
    historyRef.current = [];
    setCanUndo(false);
    setSaveFailed(false);
  }, [key, persist]);

  const publish = useCallback(
    (next: readonly Stroke[], save: boolean) => {
      strokesRef.current = next;
      setStrokesState(next);
      if (key === null) return;
      memory.set(key, next);
      if (save && persist) setSaveFailed(!saveStrokes(browserStore(), key, next));
    },
    [key, persist],
  );

  const addStroke = useCallback(
    (points: readonly PenPoint[]) => {
      if (points.length === 0) return;
      const before = strokesRef.current;
      remember(before);
      publish(withStroke(before, { id: nextStrokeId(before), color, width, points }), true);
    },
    [color, width, publish, remember],
  );

  const beginErase = useCallback(() => strokesRef.current, []);

  const previewErase = useCallback(
    (update: (current: readonly Stroke[]) => readonly Stroke[]) => {
      const next = update(strokesRef.current);
      if (next !== strokesRef.current) publish(next, false);
    },
    [publish],
  );

  const finishErase = useCallback(
    (before: readonly Stroke[]) => {
      if (strokesRef.current === before || strokesRef.current.length === before.length) return;
      remember(before);
      publish(strokesRef.current, true);
    },
    [publish, remember],
  );

  const undo = useCallback(() => {
    const last = historyRef.current[historyRef.current.length - 1];
    if (!last) return;
    historyRef.current = historyRef.current.slice(0, -1);
    setCanUndo(historyRef.current.length > 0);
    publish(last, true);
  }, [publish]);

  const clear = useCallback(() => {
    const before = strokesRef.current;
    if (before.length === 0) return;
    remember(before);
    publish([], true);
  }, [publish, remember]);

  return {
    enabled: key !== null,
    strokes,
    tool,
    color,
    width,
    visible,
    canUndo,
    saveFailed,
    setTool,
    setColor,
    setWidth,
    setVisible,
    addStroke,
    beginErase,
    previewErase,
    finishErase,
    undo,
    clear,
  };
}
