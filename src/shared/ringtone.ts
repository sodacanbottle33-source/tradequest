// The sound of an incoming call. It is made with the browser's own sound generator (Web Audio), so there is no sound file to download. A player can
// switch it off in the profile menu; the choice is kept on this device only.

const KEY = 'tq.ringtone';

/** One ring: how long the whole pattern lasts, and the short beeps in it (start and length in seconds, pitch in hertz). */
export const RING_CYCLE_S = 3;
export const RING_BEEPS: readonly { at: number; length: number; hz: number }[] = [
  { at: 0, length: 0.25, hz: 660 },
  { at: 0.35, length: 0.25, hz: 880 },
  { at: 0.7, length: 0.25, hz: 660 },
  { at: 1.05, length: 0.25, hz: 880 },
];

/** Whether the ringtone is switched on (on unless the player switched it off). */
export function ringtoneOn(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setRingtoneOn(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // the choice just lasts until the page closes
  }
}

/** The small part of the browser's sound generator that is used (so tests can replace it). */
export interface SoundContext {
  readonly currentTime: number;
  readonly state?: string;
  readonly destination: unknown;
  resume?(): Promise<void>;
  close?(): Promise<void>;
  createOscillator(): { type: string; frequency: { value: number }; connect(to: unknown): void; start(at: number): void; stop(at: number): void };
  createGain(): { gain: { setValueAtTime(v: number, at: number): void; linearRampToValueAtTime(v: number, at: number): void }; connect(to: unknown): void };
}

export interface Ringtone {
  /** Starts ringing (does nothing when it already rings or the player switched it off). */
  start(): void;
  /** Stops at once. */
  stop(): void;
  readonly ringing: boolean;
}

/** Makes a ringtone that plays the pattern over and over until stop(). `make` creates the sound context (the browser's AudioContext). */
export function createRingtone(make: () => SoundContext | null, enabled: () => boolean = ringtoneOn): Ringtone {
  let ctx: SoundContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let on = false;

  const play = (): void => {
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.02;
    for (const b of RING_BEEPS) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = b.hz;
      // a short fade in and out, so the beeps do not click
      gain.gain.setValueAtTime(0, t0 + b.at);
      gain.gain.linearRampToValueAtTime(0.18, t0 + b.at + 0.02);
      gain.gain.linearRampToValueAtTime(0, t0 + b.at + b.length);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + b.at);
      osc.stop(t0 + b.at + b.length + 0.02);
    }
  };

  return {
    get ringing() {
      return on;
    },
    start() {
      if (on || !enabled()) return;
      try {
        ctx = make();
      } catch {
        ctx = null;
      }
      if (!ctx) return;
      on = true;
      // A page that has not been touched yet may keep the sound suspended; trying again is harmless.
      if (ctx.state === 'suspended') void ctx.resume?.().catch(() => undefined);
      play();
      timer = setInterval(play, RING_CYCLE_S * 1000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      on = false;
      const old = ctx;
      ctx = null;
      void old?.close?.().catch(() => undefined);
    },
  };
}

/** The ringtone that uses this browser's sound generator. */
export function browserRingtone(): Ringtone {
  return createRingtone(() => {
    const Ctor = (globalThis as { AudioContext?: new () => SoundContext; webkitAudioContext?: new () => SoundContext }).AudioContext ?? (globalThis as { webkitAudioContext?: new () => SoundContext }).webkitAudioContext;
    return Ctor ? new Ctor() : null;
  });
}
