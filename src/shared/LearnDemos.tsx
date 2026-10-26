// The small hands-on demos of the tutorial (src/learn/tutorial.ts). Each one is self-contained: it only uses the fixed demo data and the
// arithmetic of src/learn/tutorialMath.ts, never the server, so they work offline. All money is pretend.
import { useState } from 'react';
import { bestLongGain, bestShortGain, candlesFromCloses } from '../learn/candles';
import {
  ANATOMY_CANDLES,
  breakEvenText,
  DANGER_CARDS,
  demoCandles,
  FEE_DEMO_AMOUNTS,
  LEVERAGE_DEMO,
  LONG_DEMO,
  SHARES_DEMO,
  SHORT_DEMO,
  SIZE_DEMO,
  STOP_DEMO,
  type DemoKind,
} from '../learn/tutorial';
import {
  cashAfterLosses,
  COIN_FEE_BPS_TEXT,
  feeCents,
  leveragedProfitCents,
  longProfitCents,
  percentText,
  shortProfitCents,
  signedUsd,
  STOCK_FEE_BPS_TEXT,
  usd,
  wipeoutBps,
} from '../learn/tutorialMath';
import { MiniChart } from './MiniChart';

/** Demo prices are whole cents; the chart wants dollars. */
const dollars = (cents: number): string => usd(Math.round(cents));
const tone = (cents: number): string => (cents > 0 ? 'pos' : cents < 0 ? 'neg' : '');

// ---- 1. shares and price ---------------------------------------------------------------------------------------------------------
function SharesDemo() {
  const { shares, entryCents, minCents, maxCents } = SHARES_DEMO;
  const [price, setPrice] = useState<number>(entryCents);
  const profit = longProfitCents(shares, entryCents, price);
  return (
    <div className="demo" data-testid="demo-shares">
      <div className="demo-row">
        <button type="button" className="btn btn-small" onClick={() => setPrice((p) => Math.max(minCents, p - 100))} disabled={price <= minCents} data-testid="shares-down">
          Price −$1
        </button>
        <strong className="demo-big" data-testid="shares-price">
          {dollars(price)}
        </strong>
        <button type="button" className="btn btn-small" onClick={() => setPrice((p) => Math.min(maxCents, p + 100))} disabled={price >= maxCents} data-testid="shares-up">
          Price +$1
        </button>
      </div>
      <dl className="demo-facts">
        <div>
          <dt>You paid</dt>
          <dd>
            {shares} × {dollars(entryCents)} = {dollars(shares * entryCents)}
          </dd>
        </div>
        <div>
          <dt>Your shares are worth</dt>
          <dd>
            {shares} × {dollars(price)} = {dollars(shares * price)}
          </dd>
        </div>
        <div>
          <dt>Your profit</dt>
          <dd className={tone(profit)} data-testid="shares-profit">
            {signedUsd(profit)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

// ---- 2. candles ------------------------------------------------------------------------------------------------------------------
function CandleDemo() {
  const [picked, setPicked] = useState(0);
  const c = ANATOMY_CANDLES[picked] ?? ANATOMY_CANDLES[0];
  if (!c) return null;
  const up = c.c >= c.o;
  return (
    <div className="demo" data-testid="demo-candles">
      <MiniChart candles={ANATOMY_CANDLES} label="Six sample candles. Press one to read its four prices." selected={picked} onPick={setPicked} format={dollars} />
      <dl className="demo-facts demo-facts-4" data-testid="candle-facts">
        <div>
          <dt>Open</dt>
          <dd>{dollars(c.o)}</dd>
        </div>
        <div>
          <dt>High</dt>
          <dd>{dollars(c.h)}</dd>
        </div>
        <div>
          <dt>Low</dt>
          <dd>{dollars(c.l)}</dd>
        </div>
        <div>
          <dt>Close</dt>
          <dd>{dollars(c.c)}</dd>
        </div>
      </dl>
      <p className="demo-note" data-testid="candle-story">
        {up ? <strong className="pos">Green candle.</strong> : <strong className="neg">Red candle.</strong>} The price {up ? 'rose' : 'fell'} from {dollars(c.o)} to {dollars(c.c)} (
        {signedUsd(c.c - c.o)}). It reached as high as {dollars(c.h)} and as low as {dollars(c.l)} on the way.
      </p>
    </div>
  );
}

// ---- 3 and 4. buy and sell / short and cover ----------------------------------------------------------------------------------------
function TradeSim({ side }: { side: 'long' | 'short' }) {
  const data = side === 'long' ? LONG_DEMO : SHORT_DEMO;
  const candles = demoCandles(data);
  const [shown, setShown] = useState<number>(data.firstShown);
  const [entry, setEntry] = useState<number | null>(null);
  const [exit, setExit] = useState<number | null>(null);
  const price = (candles[shown - 1] as { c: number }).c;
  const atEnd = shown >= candles.length;
  const open = side === 'long' ? 'Buy' : 'Short';
  const close = side === 'long' ? 'Sell' : 'Cover';
  const profitAt = (p: number): number => (entry === null ? 0 : side === 'long' ? longProfitCents(data.shares, entry, p) : shortProfitCents(data.shares, entry, p));
  const best = (side === 'long' ? bestLongGain : bestShortGain)([data.start, ...data.closes]) * data.shares;
  const finished = exit !== null;
  const result = finished ? profitAt(exit) : null;
  const lines = entry !== null ? [{ price: entry, label: `${side === 'long' ? 'bought' : 'shorted'} at ${dollars(entry)}`, tone: 'accent' as const }] : [];
  const reset = () => {
    setShown(data.firstShown);
    setEntry(null);
    setExit(null);
  };
  return (
    <div className="demo" data-testid={`demo-${side}`}>
      <MiniChart
        candles={candles.slice(0, shown)}
        slots={candles.length}
        lines={lines}
        keepInView={[Math.min(...data.closes) * 0.98, Math.max(...data.closes) * 1.02]}
        label={`Example chart, ${shown} of ${candles.length} candles shown. The price now is ${dollars(price)}.`}
        format={dollars}
        testId={`${side}-chart`}
      />
      <div className="demo-row">
        <span>
          Price now: <strong data-testid={`${side}-price`}>{dollars(price)}</strong>
        </span>
        <span>
          Candle {shown} of {candles.length}
        </span>
      </div>
      <div className="demo-row">
        <button type="button" className="btn" onClick={() => setShown((n) => Math.min(candles.length, n + 1))} disabled={atEnd} data-testid={`${side}-next`}>
          Next candle ▶
        </button>
        {entry === null && !finished && (
          <button type="button" className={side === 'long' ? 'btn btn-buy' : 'btn btn-sell'} onClick={() => setEntry(price)} data-testid={`${side}-open`}>
            {open} {data.shares} shares at {dollars(price)}
          </button>
        )}
        {entry !== null && !finished && (
          <button type="button" className="btn btn-primary" onClick={() => setExit(price)} data-testid={`${side}-close`}>
            {close} at {dollars(price)}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={reset} data-testid={`${side}-reset`}>
          Start again
        </button>
      </div>
      {entry !== null && !finished && (
        <p className="demo-note" data-testid={`${side}-live`}>
          You {side === 'long' ? 'bought' : 'shorted'} {data.shares} shares at {dollars(entry)}. Right now you would {profitAt(price) >= 0 ? 'make' : 'lose'}{' '}
          <strong className={tone(profitAt(price))}>{usd(Math.abs(profitAt(price)))}</strong> if you pressed {close}.
          {atEnd && ' The chart has ended, so close your trade.'}
        </p>
      )}
      {finished && result !== null && (
        <p className="demo-note" data-testid={`${side}-result`}>
          {side === 'long' ? 'Bought' : 'Shorted'} at {dollars(entry ?? 0)}, {side === 'long' ? 'sold' : 'covered'} at {dollars(exit ?? 0)}:{' '}
          <strong className={tone(result)}>{result >= 0 ? `you made ${usd(result)}` : `you lost ${usd(-result)}`}</strong>. The best possible trade on this chart would have made {usd(best)}. Nobody catches
          the best moment every time, and you do not need to.
        </p>
      )}
    </div>
  );
}

// ---- 5. fees ---------------------------------------------------------------------------------------------------------------------
function FeesDemo() {
  const [amount, setAmount] = useState<number>(FEE_DEMO_AMOUNTS[2]);
  const value = amount * 100;
  const rows: { name: string; bps: number }[] = [
    { name: 'Stock', bps: STOCK_FEE_BPS_TEXT },
    { name: 'Memecoin', bps: COIN_FEE_BPS_TEXT },
  ];
  return (
    <div className="demo" data-testid="demo-fees">
      <div className="demo-row" role="group" aria-label="Order size">
        {FEE_DEMO_AMOUNTS.map((a) => (
          <button key={a} type="button" className={a === amount ? 'btn btn-small btn-primary' : 'btn btn-small'} aria-pressed={a === amount} onClick={() => setAmount(a)} data-testid={`fee-amount-${a}`}>
            {usd(a * 100).replace('.00', '')}
          </button>
        ))}
      </div>
      <table className="demo-table" data-testid="fee-table">
        <thead>
          <tr>
            <th>Order of {usd(value).replace('.00', '')}</th>
            <th>Fee</th>
            <th>Pay for buying and selling</th>
            <th>The price must rise by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td data-testid={`fee-${r.name}`}>
                {usd(feeCents(value, r.bps))} ({r.bps / 100} %)
              </td>
              <td>{usd(feeCents(value, r.bps) * 2)}</td>
              <td>{breakEvenText(r.bps)} just to get even</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="demo-note">The gap between the buy price and the sell price costs a little more on top, and a small coin has a bigger gap than a big company.</p>
    </div>
  );
}

// ---- 6. leverage -----------------------------------------------------------------------------------------------------------------
function LeverageDemo() {
  const { marginCents, stops } = LEVERAGE_DEMO;
  const [idx, setIdx] = useState(3);
  const lev = stops[idx] ?? 10;
  const up = leveragedProfitCents(marginCents, lev, 500);
  const down = leveragedProfitCents(marginCents, lev, -500);
  const wipe = wipeoutBps(lev);
  return (
    <div className="demo" data-testid="demo-leverage">
      <label className="demo-slider">
        Leverage: <strong data-testid="lev-value">{lev}×</strong>
        <input type="range" min={0} max={stops.length - 1} step={1} value={idx} onChange={(e) => setIdx(Number(e.target.value))} aria-label="Leverage" data-testid="lev-slider" />
      </label>
      <dl className="demo-facts">
        <div>
          <dt>Your own money</dt>
          <dd>{dollars(marginCents)}</dd>
        </div>
        <div>
          <dt>The trade you control</dt>
          <dd data-testid="lev-size">{dollars(marginCents * lev)}</dd>
        </div>
        <div>
          <dt>If the price rises 5 %</dt>
          <dd className={tone(up)} data-testid="lev-up">
            {signedUsd(up)}
          </dd>
        </div>
        <div>
          <dt>If the price falls 5 %</dt>
          <dd className={tone(down)} data-testid="lev-down">
            {signedUsd(down)}
          </dd>
        </div>
        <div>
          <dt>Your money is gone if the price falls about</dt>
          <dd className="neg" data-testid="lev-wipe">
            {percentText(wipe)}
          </dd>
        </div>
      </dl>
      <p className="demo-note">{lev >= 25 ? 'Very high. Normal wiggles of the price will wipe you out.' : lev >= 10 ? 'High. A small bad move is enough to lose everything you put in.' : lev > 1 ? 'Wins and losses are multiplied.' : 'Plain buying: no borrowing, so you can only lose if the price goes all the way to zero.'}</p>
    </div>
  );
}

// ---- 7. stop-loss and take-profit ------------------------------------------------------------------------------------------------
type StopRun = 'stop' | 'target' | 'wiggle';
const STOP_PATHS: Record<StopRun, number[]> = {
  stop: [9980, 9900, 9820, 9700, 9560, 9500],
  target: [10080, 10180, 10120, 10300, 10900, 11200],
  wiggle: [10050, 9900, 10080, 9850, 10120, 10010],
};
function StopsDemo() {
  const { entry, stop, target, shares } = STOP_DEMO;
  const [run, setRun] = useState<StopRun | null>(null);
  const candles = candlesFromCloses(entry, run === null ? [] : STOP_PATHS[run as StopRun], 0);
  const lines = [
    { price: target, label: `take-profit ${dollars(target)}`, tone: 'up' as const },
    { price: entry, label: `bought at ${dollars(entry)}`, tone: 'accent' as const },
    { price: stop, label: `stop-loss ${dollars(stop)}`, tone: 'down' as const },
  ];
  const text =
    run === 'stop'
      ? `The price reached ${dollars(stop)}, so the market sold your ${shares} shares for you: ${signedUsd(longProfitCents(shares, entry, stop))}. The loss stayed small.`
      : run === 'target'
        ? `The price reached ${dollars(target)}, so the market sold your ${shares} shares for you: ${signedUsd(longProfitCents(shares, entry, target))}. The gain is locked in.`
        : run === 'wiggle'
          ? 'The price moved around but never touched the stop or the target. You still hold your shares, and both orders keep waiting.'
          : 'Press a button to see what the price does.';
  return (
    <div className="demo" data-testid="demo-stops">
      <MiniChart candles={candles} slots={8} lines={lines} keepInView={[stop * 0.99, target * 1.01]} label="A trade with a stop-loss and a take-profit" format={dollars} testId="stops-chart" />
      <div className="demo-row">
        <button type="button" className="btn btn-small" onClick={() => setRun('stop')} data-testid="stops-run-stop">
          Price falls to the stop
        </button>
        <button type="button" className="btn btn-small" onClick={() => setRun('target')} data-testid="stops-run-target">
          Price rises to the target
        </button>
        <button type="button" className="btn btn-small" onClick={() => setRun('wiggle')} data-testid="stops-run-wiggle">
          Price wiggles in between
        </button>
      </div>
      <p className="demo-note" data-testid="stops-text">
        {text}
      </p>
    </div>
  );
}

// ---- 8. dangers ------------------------------------------------------------------------------------------------------------------
function DangersDemo() {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  return (
    <div className="demo" data-testid="demo-dangers">
      <ul className="danger-list">
        {DANGER_CARDS.map((d) => {
          const isOpen = open.has(d.key);
          return (
            <li key={d.key} className={isOpen ? 'danger-card open' : 'danger-card'}>
              <button
                type="button"
                className="danger-head"
                aria-expanded={isOpen}
                onClick={() => setOpen((s) => new Set(s).add(d.key))}
                data-testid={`danger-${d.key}`}
              >
                <span>{d.title}</span>
                <span aria-hidden="true">{isOpen ? '✓' : '+'}</span>
              </button>
              {isOpen && <p>{d.text}</p>}
            </li>
          );
        })}
      </ul>
      <p className="demo-note" data-testid="danger-count">
        Opened {open.size} of {DANGER_CARDS.length}.
      </p>
    </div>
  );
}

// ---- 9. how much to risk ---------------------------------------------------------------------------------------------------------
function SizeDemo() {
  const { cashCents, lossPercent, n, stakes } = SIZE_DEMO;
  const [stake, setStake] = useState<number>(stakes[0]);
  const rows: number[] = [cashCents];
  for (let i = 1; i <= n; i += 1) rows.push(cashAfterLosses(cashCents, stake, lossPercent, i));
  const left = rows[n] as number;
  return (
    <div className="demo" data-testid="demo-size">
      <div className="demo-row" role="group" aria-label="How much of your cash you stake each time">
        {stakes.map((s) => (
          <button key={s} type="button" className={s === stake ? 'btn btn-small btn-primary' : 'btn btn-small'} aria-pressed={s === stake} onClick={() => setStake(s)} data-testid={`size-stake-${s}`}>
            Stake {s} %
          </button>
        ))}
      </div>
      <ol className="size-rows" data-testid="size-rows">
        {rows.map((cash, i) => (
          <li key={i}>
            <span>{i === 0 ? 'Start' : `After loss ${i}`}</span>
            <span className="size-bar" aria-hidden="true">
              <span style={{ width: `${Math.max(1, Math.round((cash / cashCents) * 100))}%` }} />
            </span>
            <strong>{dollars(cash)}</strong>
          </li>
        ))}
      </ol>
      <p className="demo-note" data-testid="size-left">
        After {n} losses in a row you have <strong className={left < cashCents / 2 ? 'neg' : ''}>{dollars(left)}</strong> left of {dollars(cashCents)}.
      </p>
    </div>
  );
}

export function TutorialDemo({ kind }: { kind: DemoKind }) {
  switch (kind) {
    case 'shares':
      return <SharesDemo />;
    case 'candles':
      return <CandleDemo />;
    case 'long':
      return <TradeSim side="long" />;
    case 'short':
      return <TradeSim side="short" />;
    case 'fees':
      return <FeesDemo />;
    case 'leverage':
      return <LeverageDemo />;
    case 'stops':
      return <StopsDemo />;
    case 'dangers':
      return <DangersDemo />;
    case 'size':
      return <SizeDemo />;
  }
}
