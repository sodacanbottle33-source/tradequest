// Play / Pause / Step / Skip / speed for the live market — see docs/rules.md §13.9.
import { SPEEDS, type Speed } from '../app/playback';
import type { LiveView } from '../engine';

interface Props {
  view: LiveView;
  playing: boolean;
  speed: Speed;
  canStep: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStep: () => void;
  onSkip: () => void;
  onSpeed: (speed: Speed) => void;
}

function statusText(view: LiveView, playing: boolean, speed: Speed): string {
  if (view.status === 'ENDED') return 'Session ended';
  if (playing) return `Playing at ${speed}×`;
  return view.sessionTick === 0 ? 'Paused — press Play to start the market' : 'Paused';
}

export function MarketControls({ view, playing, speed, canStep, onPlay, onPause, onStep, onSkip, onSpeed }: Props) {
  const ended = view.status === 'ENDED';
  const remaining = view.ticksPerCandle - view.ticksIntoCandle;
  return (
    <div className="controls" role="group" aria-label="Market controls">
      <div className="controls-row">
        {playing ? (
          <button type="button" className="btn btn-primary control-main" onClick={onPause} aria-label="Pause the market">
            ⏸ Pause
          </button>
        ) : (
          <button type="button" className="btn btn-primary control-main" onClick={onPlay} disabled={ended} aria-label="Play the market">
            ▶ Play
          </button>
        )}
        <button
          type="button"
          className="btn"
          onClick={onStep}
          disabled={!canStep}
          title={canStep ? 'Move the market forward by exactly one tick' : 'Pause the market first'}
        >
          Step +1 tick
        </button>
        <button
          type="button"
          className="btn"
          onClick={onSkip}
          disabled={!canStep}
          title={canStep ? 'Run to the end of the candle that is forming' : 'Pause the market first'}
        >
          Skip to candle end
        </button>
        <div className="segmented speeds" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={s === speed ? 'seg active' : 'seg'}
              aria-pressed={s === speed}
              onClick={() => onSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
      <div className="controls-status">
        <span className={`run-state ${playing ? 'is-playing' : ''}`} data-testid="run-state">
          {statusText(view, playing, speed)}
        </span>
        <span className="muted" data-testid="tick-info">
          Tick {view.tick} · candle {view.candleIndex}
        </span>
        <span
          className="tick-meter"
          role="img"
          aria-label={`${view.ticksIntoCandle} of ${view.ticksPerCandle} ticks in the forming candle`}
          data-testid="tick-meter"
          data-filled={view.ticksIntoCandle}
        >
          {Array.from({ length: view.ticksPerCandle }, (_, i) => (
            <span key={i} className={i < view.ticksIntoCandle ? 'on' : ''} />
          ))}
        </span>
        <span className="muted">{ended ? 'Trading closed' : `${remaining} tick${remaining === 1 ? '' : 's'} until this candle closes`}</span>
      </div>
    </div>
  );
}
