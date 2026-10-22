// The drawing layer on top of a price chart (an SVG group) and its toolbar. The strokes are stored as (tick, price) — see chartPens.ts —
// and drawn with the chart's own scale, so they slide with the candles and follow the price axis. While a pen or the eraser is
// selected, a transparent area over the plot catches the pointer (mouse, finger or stylus); otherwise the chart works as usual.
import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { ERASE_RADIUS, MAX_POINTS, PEN_COLORS, PEN_WIDTHS, eraseAt, farEnough, fromPlot, pathOf, toPlot, type PenGeometry, type PenPoint } from './chartPens';
import type { Pens } from './usePens';

interface LayerProps {
  pens: Pens;
  geo: PenGeometry;
  /** Where the plot starts inside the SVG, and how wide it is. */
  padLeft: number;
  padTop: number;
  plotW: number;
  /** The id of the chart's clip path (the plot area). */
  clipId: string;
}

export function PenLayer({ pens, geo, padLeft, padTop, plotW, clipId }: LayerProps) {
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const [draft, setDraft] = useState<readonly PenPoint[] | null>(null);
  const draftRef = useRef<PenPoint[] | null>(null);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const eraseFrom = useRef<ReturnType<Pens['beginErase']> | null>(null);

  const { openTick0, ticksPerCandle, slotW, lo, hi, plotH } = geo;
  const strokePaths = useMemo(() => {
    const g: PenGeometry = { openTick0, ticksPerCandle, slotW, lo, hi, plotH, start: 0 };
    return pens.strokes.map((s) => ({ id: s.id, color: s.color, width: s.width, d: pathOf(s, (pt) => toPlot(g, pt)) }));
  }, [pens.strokes, openTick0, ticksPerCandle, slotW, lo, hi, plotH]);

  const draftPath = draft && draft.length > 0 ? pathOf({ id: 0, color: pens.color, width: pens.width, points: draft }, (pt) => toPlot(geo, pt)) : '';

  /** The pointer's place inside the plot, in screen pixels from its left and top edge. */
  const place = (e: PointerEvent<SVGRectElement>): { x: number; y: number } | null => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: ((e.clientX - r.left) * plotW) / r.width, y: ((e.clientY - r.top) * geoRef.current.plotH) / r.height };
  };
  /** The same place in the scrolling layer (x counts from the first candle, y from the top of the plot). */
  const inLayer = (p: { x: number; y: number }) => ({ x: p.x + geoRef.current.start * geoRef.current.slotW, y: p.y });

  const eraseHere = (p: { x: number; y: number }) => {
    const at = inLayer(p);
    pens.previewErase((current) => eraseAt(current, at.x, at.y, ERASE_RADIUS, (pt) => toPlot(geoRef.current, pt)));
  };

  const down = (e: PointerEvent<SVGRectElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = place(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (pens.tool === 'pen') {
      const pt = fromPlot(geoRef.current, p.x, p.y);
      draftRef.current = [pt];
      lastPoint.current = inLayer(p);
      setDraft([pt]);
    } else if (pens.tool === 'eraser') {
      eraseFrom.current = pens.beginErase();
      eraseHere(p);
    }
  };

  const move = (e: PointerEvent<SVGRectElement>) => {
    const p = place(e);
    if (!p) return;
    if (pens.tool === 'pen' && draftRef.current) {
      const at = inLayer(p);
      const last = lastPoint.current;
      if (last && !farEnough(last.x, last.y, at.x, at.y)) return;
      if (draftRef.current.length >= MAX_POINTS) return;
      draftRef.current = [...draftRef.current, fromPlot(geoRef.current, p.x, p.y)];
      lastPoint.current = at;
      setDraft(draftRef.current);
    } else if (pens.tool === 'eraser' && eraseFrom.current) {
      eraseHere(p);
    }
  };

  const up = () => {
    if (draftRef.current) pens.addStroke(draftRef.current);
    draftRef.current = null;
    lastPoint.current = null;
    setDraft(null);
    if (eraseFrom.current) pens.finishErase(eraseFrom.current);
    eraseFrom.current = null;
  };

  return (
    <>
      <g clipPath={`url(#${clipId})`} className="pen-layer" aria-hidden="true" data-testid="pen-layer" data-strokes={pens.strokes.length}>
        <g className="scroll-layer" style={{ transform: `translateX(${padLeft - geo.start * slotW}px)` }}>
          <g transform={`translate(0,${padTop})`}>
            {pens.visible &&
              strokePaths.map((s) => <path key={s.id} d={s.d} stroke={s.color} strokeWidth={s.width} fill="none" strokeLinecap="round" strokeLinejoin="round" className="pen-stroke" />)}
            {draftPath && <path d={draftPath} stroke={pens.color} strokeWidth={pens.width} fill="none" strokeLinecap="round" strokeLinejoin="round" className="pen-stroke draft" />}
          </g>
        </g>
      </g>
      {pens.tool !== 'off' && (
        <rect
          className={`pen-capture ${pens.tool}`}
          x={padLeft}
          y={padTop}
          width={plotW}
          height={geo.plotH}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          data-testid="pen-capture"
        />
      )}
    </>
  );
}

export function PenToolbar({ pens }: { pens: Pens }) {
  if (!pens.enabled) return null;
  const drawing = pens.tool !== 'off';
  const has = pens.strokes.length > 0;
  return (
    <div className="pen-bar" role="toolbar" aria-label="Drawing tools" data-testid="pen-bar">
      <button
        type="button"
        className={`btn btn-small ${drawing ? 'btn-primary' : 'btn-ghost'}`}
        aria-pressed={drawing}
        onClick={() => pens.setTool(drawing ? 'off' : 'pen')}
        data-testid="pen-toggle"
        title="Draw on the chart with a pen (Esc stops drawing)"
      >
        ✏ {drawing ? 'Drawing' : 'Draw'}
      </button>
      {drawing && (
        <>
          <div className="pen-group" role="group" aria-label="Tool">
            <button type="button" className={pens.tool === 'pen' ? 'pen-tool active' : 'pen-tool'} aria-pressed={pens.tool === 'pen'} onClick={() => pens.setTool('pen')} data-testid="pen-tool-pen">
              Pen
            </button>
            <button type="button" className={pens.tool === 'eraser' ? 'pen-tool active' : 'pen-tool'} aria-pressed={pens.tool === 'eraser'} onClick={() => pens.setTool('eraser')} data-testid="pen-tool-eraser">
              Eraser
            </button>
          </div>
          {pens.tool === 'pen' && (
            <>
              <div className="pen-group" role="group" aria-label="Colour">
                {PEN_COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={pens.color === c.value ? 'pen-swatch active' : 'pen-swatch'}
                    style={{ background: c.value }}
                    aria-label={c.name}
                    aria-pressed={pens.color === c.value}
                    title={c.name}
                    onClick={() => pens.setColor(c.value)}
                    data-testid={`pen-color-${c.name.toLowerCase()}`}
                  />
                ))}
              </div>
              <div className="pen-group" role="group" aria-label="Size">
                {PEN_WIDTHS.map((w) => (
                  <button
                    key={w.value}
                    type="button"
                    className={pens.width === w.value ? 'pen-size active' : 'pen-size'}
                    aria-label={`${w.name} line`}
                    aria-pressed={pens.width === w.value}
                    title={`${w.name} line`}
                    onClick={() => pens.setWidth(w.value)}
                    data-testid={`pen-size-${w.name.toLowerCase()}`}
                  >
                    <span style={{ width: w.value + 4, height: w.value + 4 }} />
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
      <button type="button" className="btn btn-small btn-ghost" onClick={pens.undo} disabled={!pens.canUndo} data-testid="pen-undo" title="Undo the last stroke, erase or clear">
        Undo
      </button>
      <button type="button" className="btn btn-small btn-ghost" onClick={pens.clear} disabled={!has} data-testid="pen-clear" title="Remove every drawing on this chart (Undo brings it back)">
        Clear
      </button>
      {has && (
        <button type="button" className="btn btn-small btn-ghost" aria-pressed={!pens.visible} onClick={() => pens.setVisible(!pens.visible)} data-testid="pen-visibility">
          {pens.visible ? 'Hide drawings' : 'Show drawings'}
        </button>
      )}
      {drawing && (
        <p className="hint pen-hint">
          Drag on the chart to draw. Drawings stay at the times and prices where you made them and are saved in this browser for this company.
          {pens.saveFailed ? ' This browser would not save them, so they only last until you close the page.' : ''}
        </p>
      )}
    </div>
  );
}
