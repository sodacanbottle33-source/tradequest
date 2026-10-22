// The price animations of the company page and the market lists. Looks only: every number here comes from the live price the page
// already has, and nothing in this file places an order or changes a price.
//   * FlashPrice   a price that flashes green or red (and glows) each time it ticks, used in the market lists.
//   * CompanyPrice the big price on a company page: it rolls to its new value, flashes, shows a "10x since the start" badge, and
//                  plays a celebration the moment the price crosses 2x, 5x, 10x, 25x, 50x or 100x its starting price.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { crossedMilestones, formatMultiple, milestoneFor, multipleOf, piecesFor, type Milestone } from '../ui/hype';
import { pulseClass, usePulse, useTween } from '../ui/usePulse';
import { formatCents } from './format';

/** A price in cents that flashes green (up) or red (down) every time it changes. */
export function FlashPrice({ cents, resetKey = '', className = '' }: { cents: number; resetKey?: string | number; className?: string }) {
  const pulse = usePulse(cents, resetKey);
  return (
    <span className={`price-flash ${pulseClass(pulse, 'flash')} ${className}`.trim()} data-pulse={pulse.dir ?? ''}>
      {cents > 0 ? formatCents(cents) : '—'}
    </span>
  );
}

// The milestones this browser tab has already celebrated ("MPEP:10"), so a price that wobbles around 10x does not fire it again and again.
const CELEBRATED = new Set<string>();

export interface BurstEvent {
  readonly n: number;
  readonly ticker: string;
  readonly milestone: Milestone;
}

/**
 * Watches a company's price against the price it started at. When a rise crosses a milestone it returns a burst to play (a
 * bigger one replaces a smaller one that is still playing; a smaller one never interrupts a bigger one). Opening a page where the
 * company already stands at 10x does not play anything: only a crossing that happens while you watch does.
 */
export function useMilestones(ticker: string, priceCents: number, baseCents: number): { multiple: number; burst: BurstEvent | null; clear: () => void } {
  const multiple = multipleOf(priceCents, baseCents);
  const before = useRef<{ ticker: string; multiple: number } | null>(null);
  const [burst, setBurst] = useState<BurstEvent | null>(null);

  useEffect(() => {
    const prev = before.current;
    before.current = { ticker, multiple };
    if (!prev || prev.ticker !== ticker || !(prev.multiple > 0) || !(multiple > 0)) return;
    const { all } = crossedMilestones(prev.multiple, multiple);
    const fresh = all.filter((m) => !CELEBRATED.has(`${ticker}:${m.x}`));
    for (const m of all) CELEBRATED.add(`${ticker}:${m.x}`);
    const best = fresh[fresh.length - 1];
    if (!best) return;
    setBurst((cur) => (cur && cur.ticker === ticker && cur.milestone.level > best.level ? cur : { n: (cur?.n ?? 0) + 1, ticker, milestone: best }));
  }, [ticker, multiple]);

  return { multiple, burst, clear: () => setBurst(null) };
}

function seedOf(text: string): number {
  let h = 17;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The celebration: a banner with the multiple, a rocket or moon, and confetti. It covers the screen but never blocks a click. */
export function MilestoneBurst({ event, onDone }: { event: BurstEvent | null; onDone: () => void }) {
  const n = event?.n ?? 0;
  const ms = event?.milestone.durationMs ?? 0;
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (n === 0) return undefined;
    const id = setTimeout(() => done.current(), ms);
    return () => clearTimeout(id);
  }, [n, ms]);
  const pieces = useMemo(() => (event ? piecesFor(event.n * 131 + seedOf(event.ticker), event.milestone) : []), [event]);
  // The big ones (10x and up) shake the page for a moment.
  const level = event?.milestone.level ?? 0;
  useEffect(() => {
    if (n === 0 || level < 3 || typeof document === 'undefined') return undefined;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const root = document.getElementById('root');
    if (!root) return undefined;
    root.classList.add('fx-shake');
    const id = setTimeout(() => root.classList.remove('fx-shake'), 750);
    return () => {
      clearTimeout(id);
      root.classList.remove('fx-shake');
    };
  }, [n, level]);
  if (!event || typeof document === 'undefined') return null;
  const m = event.milestone;
  // It is drawn straight into <body>, outside the page, so shaking the page does not move the celebration with it.
  return createPortal(
    <div className={`burst level-${m.level}`} key={event.n} data-testid="milestone-burst" data-x={m.x} role="status" aria-live="polite">
      {m.level === 3 && <div className="burst-flash" aria-hidden="true" />}
      <div className="burst-origin" aria-hidden="true">
        {pieces.map((p, i) => (
          <span
            key={i}
            className={`piece shape-${p.shape}`}
            style={{ '--dx': `${p.dx}px`, '--dy': `${p.dy}px`, '--rot': `${p.rot}deg`, '--delay': `${p.delay}ms`, '--time': `${p.time}ms`, '--size': `${p.size}px`, '--color': p.color } as CSSProperties}
          />
        ))}
      </div>
      <div className="burst-banner">
        <div className="burst-icon" aria-hidden="true">
          {m.icon}
        </div>
        <div className="burst-x" data-testid="burst-x">
          {m.label}
        </div>
        <div className="burst-tag">{m.tag}</div>
        <div className="burst-sub">
          {event.ticker} is up {m.label} since the start
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** "🚀 5.3x since the start": shown while the price stands at 2x or more of where it started. */
export function HypeBadge({ multiple }: { multiple: number }) {
  const m = milestoneFor(multiple);
  if (!m) return null;
  return (
    <span className={`hype-badge level-${m.level}`} data-testid="hype-badge" title={`The price is ${formatMultiple(multiple)} the price it started at`}>
      <span aria-hidden="true">{m.icon}</span> {formatMultiple(multiple)} since the start
    </span>
  );
}

interface CompanyPriceProps {
  ticker: string;
  live: boolean;
  /** The live price in cents. */
  price: number;
  /** The price the company started at, in cents. */
  baseCents: number;
  /** The text of the 24-hour change, its colour class, and what to show while the company is not listed. */
  changeText: string;
  changeClass: string;
}

/** The big price of a company page, with its roll, flash, badge and celebration. Keeps the markup (`company-price`) the page always had. */
export function CompanyPrice({ ticker, live, price, baseCents, changeText, changeClass }: CompanyPriceProps) {
  const shown = useTween(live ? price : 0, 450, ticker);
  const pulse = usePulse(live ? price : 0, ticker);
  const { multiple, burst, clear } = useMilestones(ticker, live ? price : 0, baseCents);
  const level = milestoneFor(multiple)?.level ?? 0;
  return (
    <div className="price-big" data-testid="company-price">
      <span className={`mono big price-roll ${pulseClass(pulse, 'flash')} ${level >= 2 ? 'hot' : ''}`.trim()} data-testid="company-price-value">
        {live ? formatCents(Math.round(shown)) : '—'}
      </span>
      <span className={`mono ${changeClass}`}>{changeText}</span>
      {live && <HypeBadge multiple={multiple} />}
      <MilestoneBurst event={burst} onDone={clear} />
    </div>
  );
}

