// The voice-call screens' own logic: the words they show and what the page does with what the server says (a ring, an answer, the end of a call,
// the small connection messages). The rules are the server's (tests/server-calls.test.ts) and the sound is tested in tests/voice-engine.test.ts;
// here the page must only show the call right, never invent one, always let go of the microphone, and never show anything as markup.
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/shared/api';
import { CallController, CHECK_MS, NOTE_MS, type ControllerDeps, type SessionHooks, type SessionLike } from '../src/shared/callController';
import { callHeadline, CONNECTION_FAILED, durationLabel, endedNote, ringSecondsLeft, DEFAULT_ICE } from '../src/shared/callsUtil';
import { SharedStore } from '../src/shared/store';
import type { CallEnded, CallEndReason, CallsReply, CallSignal, CallState, CallView, IceServer, PmPerson, User } from '../src/shared/types';
import { VoiceError, type VoicePhase } from '../src/shared/voice';

const person = (username: string, displayName = username): PmPerson => ({ username, displayName, role: 'player' });
const ICE_A: IceServer[] = [{ urls: ['stun:a.example.org:3478'] }];
const ICE_B: IceServer[] = [{ urls: ['turn:b.example.org:3478'], username: 'u', credential: 'p' }];
const view = (patch: Partial<CallView> = {}): CallView => ({ id: 'c1', state: 'ringing', direction: 'outgoing', other: person('bob'), msLeft: 30_000, ...patch });
const reply = (call: CallView | null, ice: readonly IceServer[] = ICE_A): CallsReply => ({ call, ice, limits: { ringMs: 30_000 } });
const ended = (patch: Partial<CallEnded> = {}): CallEnded => ({ callId: 'c1', reason: 'ended', other: person('bob'), role: 'caller', byYou: false, ...patch });
const state = (patch: Partial<CallState> = {}): CallState => ({ id: 'c1', state: 'active', direction: 'outgoing', other: person('bob'), ringEndsAt: null, mine: true, phase: 'connecting', muted: false, connectedAt: null, ...patch });
const sig = (kind: 'offer' | 'answer', sdp = 'v=0 x'): CallSignal => ({ kind, sdp });
const cand = (n: number): CallSignal => ({ kind: 'candidate', candidate: `c${n}`, sdpMid: '0', sdpMLineIndex: 0 });
const until = async (check: () => boolean, what = 'condition'): Promise<void> => {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const only = <T>(list: readonly T[]): T => {
  const first = list[0];
  if (first === undefined) throw new Error('nothing was made');
  return first;
};
const settle = () => new Promise((done) => setTimeout(done, 15));

describe('the words and numbers', () => {
  it('CALLUI-1: every way a call can end has its own line, and the player\'s own action needs none', () => {
    const lines = (reason: CallEndReason, role: 'caller' | 'callee', byYou: boolean) => endedNote(ended({ reason, role, byYou, other: person('bob', 'Bob') }));
    expect(lines('missed', 'caller', false)).toBe('Bob did not answer.');
    expect(lines('missed', 'callee', false)).toBe('Missed call from Bob.');
    expect(lines('declined', 'caller', false)).toBe('Bob declined the call.');
    expect(lines('declined', 'callee', true)).toBeNull();
    expect(lines('cancelled', 'callee', false)).toBe('Bob stopped calling.');
    expect(lines('cancelled', 'caller', true)).toBeNull();
    expect(lines('ended', 'caller', false)).toBe('Bob ended the call.');
    expect(lines('ended', 'caller', true)).toBeNull();
    expect(lines('failed', 'caller', false)).toBe(CONNECTION_FAILED);
    expect(lines('failed', 'callee', true)).toMatch(/failed or was lost.*block direct calls/);
    expect(lines('disconnected', 'caller', false)).toBe('The call ended because Bob went offline.');
    expect(lines('unavailable', 'caller', false)).toBe('The call ended.');
  });

  it('CALLUI-2: call lengths read as m:ss or h:mm:ss and never go below zero', () => {
    expect(durationLabel(0)).toBe('0:00');
    expect(durationLabel(999)).toBe('0:00');
    expect(durationLabel(65_000)).toBe('1:05');
    expect(durationLabel(59 * 60_000 + 59_999)).toBe('59:59');
    expect(durationLabel(3_723_000)).toBe('1:02:03');
    expect(durationLabel(-5000)).toBe('0:00');
  });

  it('CALLUI-3: the seconds left to answer count down to zero and stop there; an answered call has none', () => {
    const ringing = state({ state: 'ringing', ringEndsAt: 100_000 });
    expect(ringSecondsLeft(ringing, 70_000)).toBe(30);
    expect(ringSecondsLeft(ringing, 70_001)).toBe(30);
    expect(ringSecondsLeft(ringing, 99_001)).toBe(1);
    expect(ringSecondsLeft(ringing, 100_000)).toBe(0);
    expect(ringSecondsLeft(ringing, 500_000)).toBe(0);
    expect(ringSecondsLeft(state({ ringEndsAt: null }), 1)).toBe(0);
  });

  it('CALLUI-4: the headline says what is happening in each stage', () => {
    const bob = person('bob', 'Bob');
    expect(callHeadline(state({ other: bob, state: 'ringing', phase: 'mic' }), 0)).toBe('Getting your microphone…');
    expect(callHeadline(state({ other: bob, state: 'ringing', phase: 'ringing', direction: 'outgoing' }), 0)).toBe('Calling Bob…');
    expect(callHeadline(state({ other: bob, state: 'ringing', phase: 'ringing', direction: 'incoming', mine: false }), 0)).toBe('Bob is calling you');
    expect(callHeadline(state({ other: bob, phase: 'connecting' }), 0)).toBe('Connecting to Bob…');
    expect(callHeadline(state({ other: bob, phase: 'connected', connectedAt: 1000 }), 66_000)).toBe('In a call with Bob · 1:05');
    expect(callHeadline(state({ other: bob, mine: false, phase: 'connecting' }), 0)).toBe('In a call with Bob on another page');
    // A name is only ever text: the words contain it as it came.
    expect(callHeadline(state({ other: person('x', '<b>Eve</b>'), state: 'ringing', phase: 'ringing', direction: 'incoming', mine: false }), 0)).toBe('<b>Eve</b> is calling you');
  });
});

// ---- a controller with stand-ins for the server, the sound, the screen and the clock -------------------------------------------------

class FakeSession implements SessionLike {
  readonly log: string[] = [];
  readonly signals: CallSignal[] = [];
  readonly ice: (readonly IceServer[])[] = [];
  closed = false;
  muted: boolean | null = null;
  prepareError: unknown = null;
  beginError: unknown = null;
  prepareGate: Promise<void> | null = null;
  constructor(
    readonly role: 'caller' | 'callee',
    readonly hooks: SessionHooks,
  ) {}
  async prepare(): Promise<void> {
    this.log.push('prepare');
    if (this.prepareGate) await this.prepareGate;
    if (this.prepareError) throw this.prepareError;
  }
  async begin(ice: readonly IceServer[]): Promise<void> {
    this.log.push('begin');
    this.ice.push(ice);
    if (this.beginError) throw this.beginError;
  }
  async handleSignal(signal: CallSignal): Promise<void> {
    this.log.push(`signal:${signal.kind}`);
    this.signals.push(signal);
  }
  setMuted(muted: boolean): void {
    this.muted = muted;
  }
  close(): void {
    this.closed = true;
    this.log.push('close');
  }
  phase(p: VoicePhase): void {
    this.hooks.onPhase(p);
  }
}

interface Asked {
  readonly name: string;
  readonly args: unknown[];
}
interface Rig {
  readonly c: CallController;
  readonly sessions: FakeSession[];
  readonly asked: Asked[];
  readonly notes: (string | null)[];
  readonly streams: unknown[];
  readonly timers: { fn: () => void; ms: number; id: number; live: boolean }[];
  clock: { now: number };
  /** What the server answers (each may be replaced in a test; a function may also throw or wait). */
  server: {
    view: () => Promise<CallsReply>;
    invite: (username: string) => Promise<CallsReply>;
    accept: (callId: string) => Promise<CallsReply>;
    hangup: (callId: string, failed: boolean) => Promise<CallsReply>;
    signal: (callId: string, signal: CallSignal) => Promise<unknown>;
  };
  /** Patch for the next session made (to make the microphone fail or wait). */
  next: { prepareError?: unknown; prepareGate?: Promise<void>; beginError?: unknown };
  current(): CallState | null;
  note(): string | null;
  asks(name: string): unknown[][];
  fire(ms: number): void;
  /** The first session made (the test fails if none was). */
  session(): FakeSession;
}
function rig(): Rig {
  let call: CallState | null = null;
  const r: Rig = {
    c: undefined as unknown as CallController,
    sessions: [],
    asked: [],
    notes: [],
    streams: [],
    timers: [],
    clock: { now: 1_000_000 },
    server: undefined as unknown as Rig['server'],
    next: {},
    current: () => call,
    note: () => r.notes[r.notes.length - 1] ?? null,
    session: () => only(r.sessions),
    asks: (name) => r.asked.filter((a) => a.name === name).map((a) => a.args),
    fire(ms) {
      for (const t of r.timers.filter((x) => x.live && x.ms === ms)) {
        t.live = false;
        t.fn();
      }
    },
  };
  const record =
    <A extends unknown[], T>(name: string, answer: (...args: A) => Promise<T>) =>
    (...args: A): Promise<T> => {
      r.asked.push({ name, args });
      return answer(...args);
    };
  r.server = {
    view: async () => reply(call ? view({ id: call.id }) : null),
    invite: async () => reply(view()),
    accept: async (id) => reply(view({ id, direction: 'incoming', state: 'active', msLeft: null })),
    hangup: async () => reply(null),
    signal: async () => ({ ok: true }),
  };
  const deps: ControllerDeps = {
    api: {
      view: record('view', () => r.server.view()),
      invite: record('invite', (u: string) => r.server.invite(u)),
      accept: record('accept', (id: string) => r.server.accept(id)),
      hangup: record('hangup', (id: string, failed: boolean) => r.server.hangup(id, failed)),
      signal: record('signal', (id: string, s: CallSignal) => r.server.signal(id, s)),
    },
    state: () => call,
    setCall: (next) => {
      call = next;
    },
    setNote: (text) => {
      r.notes.push(text);
    },
    setStream: (stream) => {
      r.streams.push(stream);
    },
    makeSession: (role, hooks) => {
      const s = new FakeSession(role, hooks);
      Object.assign(s, r.next);
      r.next = {};
      r.sessions.push(s);
      return s;
    },
    now: () => r.clock.now,
    later: (fn, ms) => {
      const t = { fn, ms, id: r.timers.length + 1, live: true };
      r.timers.push(t);
      return t.id;
    },
    cancel: (handle) => {
      const t = r.timers.find((x) => x.id === handle);
      if (t) t.live = false;
    },
  };
  (r as { c: CallController }).c = new CallController(deps);
  return r;
}
const hold = (): { gate: Promise<void>; open: () => void } => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((done) => {
    open = done;
  });
  return { gate, open };
};
const ringIn = (r: Rig, patch: Partial<CallView> = {}) => r.c.onCall({ call: view({ id: 'c2', direction: 'incoming', other: person('carol'), ...patch }) });

describe('making a call', () => {
  it('CALLUI-5: Call asks for the microphone first, then rings; the screen shows the call only as far as it got', async () => {
    const r = rig();
    const gate = hold();
    r.next = { prepareGate: gate.gate };
    const starting = r.c.start('bob');
    expect(r.current()).toMatchObject({ id: '', state: 'ringing', direction: 'outgoing', mine: true, phase: 'mic', other: { username: 'bob' } });
    expect(r.asks('invite')).toEqual([]);
    gate.open();
    await starting;
    expect(r.asks('invite')).toEqual([['bob']]);
    expect(r.current()).toMatchObject({ id: 'c1', state: 'ringing', direction: 'outgoing', mine: true, phase: 'ringing', ringEndsAt: 1_030_000, other: { username: 'bob' } });
    // Nothing is sent to the other browser before the call is answered.
    expect(r.session().log).toEqual(['prepare']);
    expect(r.session().role).toBe('caller');
  });

  it('CALLUI-6: when the friend answers, the connection starts with the server\'s servers, and the offer is its first message', async () => {
    const r = rig();
    r.server.invite = async () => reply(view(), ICE_B);
    await r.c.start('bob');
    r.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    expect(r.current()).toMatchObject({ id: 'c1', state: 'active', phase: 'connecting', ringEndsAt: null, mine: true });
    expect(r.session().log).toEqual(['prepare', 'begin']);
    expect(r.session().ice).toEqual([ICE_B]);
    // A second "active" message does not start it twice.
    r.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    expect(r.session().log).toEqual(['prepare', 'begin']);
    // The session's messages go to the server in order, tagged with the call.
    r.session().hooks.sendSignal(sig('offer'));
    r.session().hooks.sendSignal(cand(1));
    r.session().hooks.sendSignal(cand(2));
    await until(() => r.asks('signal').length === 3, 'three signals');
    expect(r.asks('signal')).toEqual([['c1', sig('offer')], ['c1', cand(1)], ['c1', cand(2)]]);
  });

  it('CALLUI-7: the sound connecting turns the screen to "in a call" with the time it began; Mute silences the microphone and Unmute brings it back', async () => {
    const r = rig();
    await r.c.start('bob');
    r.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    r.clock.now += 4000;
    r.session().phase('connected');
    expect(r.current()).toMatchObject({ phase: 'connected', connectedAt: 1_004_000 });
    r.clock.now += 9000;
    r.session().phase('connected');
    expect(r.current()?.connectedAt).toBe(1_004_000);
    r.c.toggleMute();
    expect(r.session().muted).toBe(true);
    expect(r.current()?.muted).toBe(true);
    r.c.toggleMute();
    expect(r.session().muted).toBe(false);
    expect(r.current()?.muted).toBe(false);
    // A later "active" message from the server does not undo what the page knows.
    r.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    expect(r.current()).toMatchObject({ phase: 'connected', connectedAt: 1_004_000, muted: false });
  });

  it('CALLUI-8: Hang up lets go of the microphone, tells the server, clears the screen and says nothing about it', async () => {
    const r = rig();
    await r.c.start('bob');
    r.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    r.session().phase('connected');
    await r.c.hangup();
    expect(r.session().closed).toBe(true);
    expect(r.current()).toBeNull();
    expect(r.asks('hangup')).toEqual([['c1', false]]);
    expect(r.streams[r.streams.length - 1]).toBeNull();
    expect(r.note()).toBeNull();
    // The server's "ended by you" message that follows changes nothing and adds no line.
    r.c.onCall({ call: null, ended: ended({ byYou: true }) });
    expect(r.note()).toBeNull();
    // Hanging up with nothing going on does nothing.
    await r.c.hangup();
    expect(r.asks('hangup')).toHaveLength(1);
  });

  it('CALLUI-9: a blocked or missing microphone stops the call before anything is asked of the server, and says why', async () => {
    const r = rig();
    r.next = { prepareError: new VoiceError('The microphone is blocked. Allow the microphone for this site in your browser, then try again.') };
    await r.c.start('bob');
    expect(r.current()).toBeNull();
    expect(r.asks('invite')).toEqual([]);
    expect(r.note()).toMatch(/microphone is blocked/);
    expect(r.session().closed).toBe(true);
    // Another kind of failure still gets plain words.
    r.next = { prepareError: new Error('boom') };
    await r.c.start('bob');
    expect(r.note()).toBe('The call could not be started.');
    expect(r.current()).toBeNull();
  });

  it('CALLUI-10: when the server refuses the call, its own explanation is shown and the microphone is let go', async () => {
    const r = rig();
    r.server.invite = async () => {
      throw new ApiError(409, 'offline', 'Bob does not have TradeQuest open right now.');
    };
    await r.c.start('bob');
    expect(r.current()).toBeNull();
    expect(r.note()).toBe('Bob does not have TradeQuest open right now.');
    expect(r.session().closed).toBe(true);
    expect(r.asks('hangup')).toEqual([]);
    r.server.invite = async () => {
      throw new Error('network');
    };
    await r.c.start('bob');
    expect(r.note()).toBe('The call could not be started.');
  });

  it('CALLUI-11: pressing Cancel while the browser still asks about the microphone stops the call and never rings', async () => {
    const r = rig();
    const gate = hold();
    r.next = { prepareGate: gate.gate };
    const starting = r.c.start('bob');
    await r.c.hangup();
    expect(r.current()).toBeNull();
    gate.open();
    await starting;
    expect(r.asks('invite')).toEqual([]);
    expect(r.session().closed).toBe(true);
    expect(r.current()).toBeNull();
    expect(r.note()).toBeNull();
  });

  it('CALLUI-12: pressing Cancel while the server is ringing takes the ring back as soon as the server says which call it is', async () => {
    const r = rig();
    const gate = hold();
    r.server.invite = async () => {
      await gate.gate;
      return reply(view());
    };
    const starting = r.c.start('bob');
    await until(() => r.asks('invite').length === 1, 'the invite');
    await r.c.hangup();
    expect(r.current()).toBeNull();
    expect(r.asks('hangup')).toEqual([]);
    gate.open();
    await starting;
    expect(r.asks('hangup')).toEqual([['c1', false]]);
    expect(r.current()).toBeNull();
    expect(r.session().closed).toBe(true);
  });

  it('CALLUI-13: a second Call is ignored while one is starting or going', async () => {
    const r = rig();
    const gate = hold();
    r.next = { prepareGate: gate.gate };
    const first = r.c.start('bob');
    await r.c.start('dave');
    expect(r.sessions).toHaveLength(1);
    gate.open();
    await first;
    await r.c.start('dave');
    expect(r.sessions).toHaveLength(1);
    expect(r.asks('invite')).toEqual([['bob']]);
  });

  it('CALLUI-14: the friend not answering shows "did not answer" and frees the microphone', async () => {
    const r = rig();
    await r.c.start('bob');
    r.c.onCall({ call: null, ended: ended({ reason: 'missed', role: 'caller', other: person('bob', 'Bob') }) });
    expect(r.current()).toBeNull();
    expect(r.note()).toBe('Bob did not answer.');
    expect(r.session().closed).toBe(true);
  });
});

describe('taking a call', () => {
  it('CALLUI-15: a ring shows who is calling and how long is left, without opening the microphone', () => {
    const r = rig();
    ringIn(r);
    expect(r.current()).toMatchObject({ id: 'c2', state: 'ringing', direction: 'incoming', mine: false, phase: 'ringing', ringEndsAt: 1_030_000, other: { username: 'carol' } });
    expect(r.sessions).toEqual([]);
    expect(r.asked).toEqual([]);
  });

  it('CALLUI-16: Answer gets the microphone, readies the connection, and only then answers the server; the offer that follows is taken in', async () => {
    const r = rig();
    r.server.accept = async (id) => reply(view({ id, direction: 'incoming', state: 'active', msLeft: null, other: person('carol') }), ICE_B);
    ringIn(r);
    await r.c.answer();
    expect(r.session().role).toBe('callee');
    expect(r.session().log).toEqual(['prepare', 'begin']);
    expect(r.session().ice).toEqual([DEFAULT_ICE]);
    expect(r.asks('accept')).toEqual([['c2']]);
    expect(r.current()).toMatchObject({ id: 'c2', state: 'active', mine: true, phase: 'connecting', direction: 'incoming' });
    // The offer (and addresses) from the other player go to the session; ones for another call do not.
    r.c.onSignal({ callId: 'c2', signal: sig('offer') });
    r.c.onSignal({ callId: 'c9', signal: cand(1) });
    r.c.onSignal({ callId: 'c2', signal: cand(2) });
    await settle();
    expect(r.session().signals).toEqual([sig('offer'), cand(2)]);
    // The answer goes out tagged with the call.
    r.session().hooks.sendSignal(sig('answer'));
    await until(() => r.asks('signal').length === 1, 'the answer signal');
    expect(r.asks('signal')).toEqual([['c2', sig('answer')]]);
  });

  it('CALLUI-17: while the browser asks about the microphone the screen says so, and pressing Answer twice does not open it twice', async () => {
    const r = rig();
    const gate = hold();
    r.next = { prepareGate: gate.gate };
    ringIn(r);
    const first = r.c.answer();
    expect(r.current()).toMatchObject({ phase: 'mic', mine: true, state: 'ringing' });
    await r.c.answer();
    expect(r.sessions).toHaveLength(1);
    gate.open();
    await first;
    expect(r.asks('accept')).toEqual([['c2']]);
  });

  it('CALLUI-18: if the ring ends while the microphone is being asked for, the microphone is let go and the server is not told "answer"', async () => {
    const r = rig();
    const gate = hold();
    r.next = { prepareGate: gate.gate };
    ringIn(r, { other: person('carol', 'Carol') });
    const answering = r.c.answer();
    r.c.onCall({ call: null, ended: ended({ callId: 'c2', reason: 'missed', role: 'callee', other: person('carol', 'Carol') }) });
    gate.open();
    await answering;
    expect(r.asks('accept')).toEqual([]);
    expect(r.session().closed).toBe(true);
    expect(r.current()).toBeNull();
    expect(r.note()).toBe('Missed call from Carol.');
  });

  it('CALLUI-19: a refused microphone puts the ring back so the call can still be declined, and says why', async () => {
    const r = rig();
    r.next = { prepareError: new VoiceError('No microphone was found. Plug one in and try again.') };
    ringIn(r);
    await r.c.answer();
    expect(r.note()).toBe('No microphone was found. Plug one in and try again.');
    expect(r.current()).toMatchObject({ id: 'c2', state: 'ringing', mine: false, phase: 'ringing' });
    expect(r.asks('accept')).toEqual([]);
    expect(r.session().closed).toBe(true);
    await r.c.hangup();
    expect(r.asks('hangup')).toEqual([['c2', false]]);
    expect(r.current()).toBeNull();
  });

  it('CALLUI-20: an answer the server turns down because the call is gone clears the screen after asking what is true now', async () => {
    const r = rig();
    r.server.accept = async () => {
      throw new ApiError(409, 'not_ringing', 'That call is no longer ringing.');
    };
    r.server.view = async () => reply(null);
    ringIn(r);
    await r.c.answer();
    expect(r.note()).toBe('The call ended.');
    expect(r.current()).toBeNull();
    expect(r.asks('view')).toHaveLength(1);
    expect(r.session().closed).toBe(true);
    // A refusal that is not "gone" leaves the ring to try again.
    const q = rig();
    q.server.accept = async () => {
      throw new ApiError(429, 'rate_limited', 'Slow down.');
    };
    ringIn(q);
    await q.c.answer();
    expect(q.note()).toBe('Slow down.');
    expect(q.current()).toMatchObject({ id: 'c2', state: 'ringing', mine: false });
    expect(q.asks('view')).toEqual([]);
  });

  it('CALLUI-21: Decline tells the server, clears the ring and shows no line; the friend giving up shows "stopped calling"', async () => {
    const r = rig();
    ringIn(r);
    await r.c.hangup();
    expect(r.asks('hangup')).toEqual([['c2', false]]);
    expect(r.current()).toBeNull();
    expect(r.note()).toBeNull();
    expect(r.sessions).toEqual([]);
    ringIn(r, { other: person('carol', 'Carol') });
    r.c.onCall({ call: null, ended: ended({ callId: 'c2', reason: 'cancelled', role: 'callee', other: person('carol', 'Carol') }) });
    expect(r.current()).toBeNull();
    expect(r.note()).toBe('Carol stopped calling.');
  });

  it('CALLUI-22: Answer does nothing when there is no ring, when the call is already going, or when it is one this player is making', async () => {
    const r = rig();
    await r.c.answer();
    expect(r.sessions).toEqual([]);
    await r.c.start('bob');
    await r.c.answer();
    expect(r.sessions).toHaveLength(1);
    r.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    await r.c.answer();
    expect(r.asks('accept')).toEqual([]);
  });
});

describe('what the server says', () => {
  it('CALLUI-23: a message about the end of some other call changes nothing', async () => {
    const r = rig();
    await r.c.start('bob');
    r.c.onCall({ call: null, ended: ended({ callId: 'zzz', reason: 'missed' }) });
    expect(r.current()?.id).toBe('c1');
    expect(r.note()).toBeNull();
    expect(r.session().closed).toBe(false);
    // And a description of some other call does not replace the one on screen.
    r.c.onCall({ call: view({ id: 'c9', other: person('carol') }) });
    expect(r.current()).toMatchObject({ id: 'c1', other: { username: 'bob' } });
  });

  it('CALLUI-24: an old "ringing" message after the call was answered does not take the screen back to ringing', async () => {
    const r = rig();
    await r.c.start('bob');
    r.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    r.c.onCall({ call: view({ state: 'ringing' }) });
    expect(r.current()?.state).toBe('active');
    expect(r.current()?.ringEndsAt).toBeNull();
  });

  it('CALLUI-25: another page of the same player: the call shows, with Hang up, but this page holds no microphone and ignores the sound', async () => {
    const r = rig();
    r.c.onCall({ call: view({ id: 'c3', state: 'active', msLeft: null }) });
    expect(r.current()).toMatchObject({ id: 'c3', state: 'active', mine: false, phase: 'connecting' });
    expect(r.sessions).toEqual([]);
    r.c.toggleMute();
    expect(r.current()?.muted).toBe(false);
    r.c.onSignal({ callId: 'c3', signal: sig('offer') });
    await settle();
    r.sessions.forEach((s) => expect(s.signals).toEqual([]));
    r.sessions[0]?.phase('connected');
    expect(r.current()?.phase).toBe('connecting');
    await r.c.hangup();
    expect(r.asks('hangup')).toEqual([['c3', false]]);
    expect(r.current()).toBeNull();
    // The end of the call reaches this page as well, and says what happened.
    r.c.onCall({ call: view({ id: 'c4', state: 'active', msLeft: null }) });
    r.c.onCall({ call: null, ended: ended({ callId: 'c4', reason: 'ended', other: person('bob', 'Bob') }) });
    expect(r.note()).toBe('Bob ended the call.');
  });

  it('CALLUI-26: after a reconnect the page asks the server, and a call the server no longer knows is cleared with a line', async () => {
    const r = rig();
    await r.c.start('bob');
    r.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    r.server.view = async () => reply(null);
    await r.c.reconcile();
    expect(r.current()).toBeNull();
    expect(r.note()).toBe('The call ended.');
    expect(r.session().closed).toBe(true);
    // A call the server still has is kept, and one that appeared while the page was away is shown.
    r.server.view = async () => reply(view({ id: 'c5', direction: 'incoming', other: person('carol') }), ICE_B);
    await r.c.reconcile();
    expect(r.current()).toMatchObject({ id: 'c5', direction: 'incoming', mine: false, state: 'ringing' });
    // The server being away changes nothing.
    r.server.view = async () => {
      throw new ApiError(0, 'offline', 'Cannot reach the TradeQuest server.');
    };
    await r.c.reconcile();
    expect(r.current()?.id).toBe('c5');
  });

  it('CALLUI-27: while the call is still being started, a "no call" answer from the server does not wipe it', async () => {
    const r = rig();
    const gate = hold();
    r.next = { prepareGate: gate.gate };
    const starting = r.c.start('bob');
    r.server.view = async () => reply(null);
    await r.c.reconcile();
    expect(r.current()).toMatchObject({ id: '', phase: 'mic' });
    gate.open();
    await starting;
    expect(r.current()?.id).toBe('c1');
  });

  it('CALLUI-28: while a call exists the page checks on it every 15 seconds, and stops checking when it is over', async () => {
    const r = rig();
    await r.c.start('bob');
    expect(r.timers.filter((t) => t.ms === CHECK_MS && t.live)).toHaveLength(1);
    r.fire(CHECK_MS);
    await until(() => r.asks('view').length === 1, 'a check');
    expect(r.timers.filter((t) => t.ms === CHECK_MS && t.live)).toHaveLength(1);
    await r.c.hangup();
    expect(r.timers.filter((t) => t.ms === CHECK_MS && t.live)).toHaveLength(0);
  });

  it('CALLUI-29: connection messages are held back until the page has made its connection, and are never handed to a finished call', async () => {
    const r = rig();
    await r.c.start('bob');
    // Before the friend has answered, there is no connection to give them to.
    r.c.onSignal({ callId: 'c1', signal: cand(1) });
    r.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    r.c.onSignal({ callId: 'c1', signal: sig('answer') });
    await settle();
    expect(r.session().signals).toEqual([sig('answer')]);
    await r.c.hangup();
    r.c.onSignal({ callId: 'c1', signal: cand(2) });
    await settle();
    expect(r.session().signals).toEqual([sig('answer')]);
  });

  it('CALLUI-30: a connection message the server cannot deliver because the call is gone sends the page to ask what is true; other trouble is ignored', async () => {
    const r = rig();
    await r.c.start('bob');
    r.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    r.server.signal = async () => {
      throw new ApiError(404, 'no_call', 'No such call.');
    };
    r.server.view = async () => reply(null);
    r.session().hooks.sendSignal(sig('offer'));
    await until(() => r.current() === null, 'the call to clear');
    expect(r.asks('view')).toHaveLength(1);
    expect(r.note()).toBe('The call ended.');
    const q = rig();
    await q.c.start('bob');
    q.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    q.server.signal = async () => {
      throw new ApiError(429, 'rate_limited', 'Slow down.');
    };
    q.session().hooks.sendSignal(sig('offer'));
    q.session().hooks.sendSignal(cand(1));
    await until(() => q.asks('signal').length === 2, 'both signals tried');
    expect(q.current()?.id).toBe('c1');
  });
});

describe('when the sound cannot connect', () => {
  it('CALLUI-31: a connection that fails tells the server it failed, lets go of the microphone and explains in plain words', async () => {
    const r = rig();
    await r.c.start('bob');
    r.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    r.session().phase('failed');
    expect(r.current()).toBeNull();
    expect(r.session().closed).toBe(true);
    expect(r.asks('hangup')).toEqual([['c1', true]]);
    expect(r.note()).toBe(CONNECTION_FAILED);
  });

  it('CALLUI-32: a browser that cannot start the connection says so, and the call is ended as failed', async () => {
    const r = rig();
    r.next = { beginError: new VoiceError('This browser cannot make calls. Try an up-to-date Chrome, Edge, Firefox or Safari.') };
    await r.c.start('bob');
    r.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    await until(() => r.current() === null, 'the call to end');
    expect(r.note()).toMatch(/cannot make calls/);
    expect(r.asks('hangup')).toEqual([['c1', true]]);
    // The same for the player who answers.
    const q = rig();
    q.next = { beginError: new VoiceError('This browser cannot make calls. Try an up-to-date Chrome, Edge, Firefox or Safari.') };
    ringIn(q);
    await q.c.answer();
    expect(q.note()).toMatch(/cannot make calls/);
    expect(q.asks('accept')).toEqual([]);
    expect(q.session().closed).toBe(true);
  });

  it('CALLUI-33: a failure reported by a page that holds no connection is ignored', async () => {
    const r = rig();
    r.c.onCall({ call: view({ id: 'c3', state: 'active', msLeft: null }) });
    // (the only way to reach the hook is through a session, and this page has none)
    expect(r.sessions).toEqual([]);
    expect(r.current()?.mine).toBe(false);
  });
});

describe('notes, sign-out and the store', () => {
  it('CALLUI-34: a line about a call stays for a while and can be closed; a new line replaces the old one and its clock', async () => {
    const r = rig();
    await r.c.start('bob');
    r.c.onCall({ call: null, ended: ended({ reason: 'missed', role: 'caller', other: person('bob', 'Bob') }) });
    expect(r.note()).toBe('Bob did not answer.');
    expect(r.timers.filter((t) => t.ms === NOTE_MS && t.live)).toHaveLength(1);
    r.fire(NOTE_MS);
    expect(r.note()).toBeNull();
    await r.c.start('bob');
    r.c.onCall({ call: null, ended: ended({ reason: 'missed', role: 'caller', other: person('bob', 'Bob') }) });
    r.c.dismissNote();
    expect(r.note()).toBeNull();
    expect(r.timers.filter((t) => t.ms === NOTE_MS && t.live)).toHaveLength(0);
    // Starting a call clears an old line at once.
    r.c.onCall({ call: null, ended: ended({ reason: 'missed', callId: 'x' }) });
    await r.c.start('bob');
    expect(r.note()).toBeNull();
  });

  it('CALLUI-35: signing out lets go of the call: the microphone, the screen and (told best-effort) the server', async () => {
    const r = rig();
    await r.c.start('bob');
    r.c.onCall({ call: view({ state: 'active', msLeft: null }) });
    r.c.reset();
    expect(r.current()).toBeNull();
    expect(r.session().closed).toBe(true);
    expect(r.note()).toBeNull();
    await until(() => r.asks('hangup').length === 1, 'the hangup');
    expect(r.asks('hangup')).toEqual([['c1', false]]);
    // Signing out while only the microphone prompt is open stops that start as well.
    const q = rig();
    const gate = hold();
    q.next = { prepareGate: gate.gate };
    const starting = q.c.start('bob');
    q.c.reset();
    gate.open();
    await starting;
    expect(q.asks('invite')).toEqual([]);
    expect(q.session().closed).toBe(true);
    expect(q.current()).toBeNull();
  });
});

// ---- the store: the same controller wired to the page's state and the server's live messages ------------------------------------------

const me: User = { id: 1, username: 'alice', displayName: 'alice', role: 'player' };
interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}
const realFetch = globalThis.fetch;
afterEach(async () => {
  await new Promise((done) => setTimeout(done, 320));
  globalThis.fetch = realFetch;
});
function server(answers: Record<string, unknown>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input), 'http://x');
    const call: Seen = { method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(init.body) : undefined };
    seen.push(call);
    const answer = answers[`${call.method} ${call.path}`];
    return new Response(JSON.stringify(answer ?? reply(null)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return seen;
}
function storeWith(sessions: FakeSession[]): SharedStore {
  const store = new SharedStore({
    makeSession: (role, hooks): SessionLike => {
      const s = new FakeSession(role, hooks);
      sessions.push(s);
      return s;
    },
  });
  (store as unknown as { set(patch: object): void }).set({ user: me });
  return store;
}
const live = (store: SharedStore) => (store as unknown as { calls: CallController }).calls;

describe('the store', () => {
  it('CALLUI-36: Call goes through the page\'s state: the call, then the server\'s ring, then the end with its line', async () => {
    const sessions: FakeSession[] = [];
    const seen = server({ 'POST /api/calls/invite': reply(view()) });
    const store = storeWith(sessions);
    await store.callStart('bob');
    expect(seen.map((s) => `${s.method} ${s.path}`)).toContain('POST /api/calls/invite');
    expect(seen.find((s) => s.path === '/api/calls/invite')?.body).toEqual({ username: 'bob' });
    expect(store.getSnapshot().call).toMatchObject({ id: 'c1', state: 'ringing', mine: true, other: { username: 'bob' } });
    live(store).onCall({ call: null, ended: ended({ reason: 'declined', role: 'caller', other: person('bob', 'Bob') }) });
    expect(store.getSnapshot().call).toBeNull();
    expect(store.getSnapshot().callNote).toBe('Bob declined the call.');
    store.callDismissNote();
    expect(store.getSnapshot().callNote).toBeNull();
  });

  it('CALLUI-37: the other player\'s voice reaches the page\'s state and is cleared when the call ends', async () => {
    const sessions: FakeSession[] = [];
    server({ 'POST /api/calls/invite': reply(view()) });
    const store = storeWith(sessions);
    await store.callStart('bob');
    const voice = { id: 'stream' };
    only(sessions).hooks.onRemote(voice);
    expect(store.getSnapshot().callStream).toBe(voice);
    await store.callHangup();
    expect(store.getSnapshot().callStream).toBeNull();
    expect(store.getSnapshot().call).toBeNull();
  });

  it('CALLUI-38: a ring from the live stream shows, Answer sends the answer, and the page keeps the call even though it was ours to answer', async () => {
    const sessions: FakeSession[] = [];
    const seen = server({ 'POST /api/calls/accept': reply(view({ id: 'c2', direction: 'incoming', state: 'active', msLeft: null, other: person('carol') })) });
    const store = storeWith(sessions);
    live(store).onCall({ call: view({ id: 'c2', direction: 'incoming', other: person('carol') }) });
    expect(store.getSnapshot().call).toMatchObject({ id: 'c2', direction: 'incoming', mine: false });
    await store.callAnswer();
    expect(seen.find((s) => s.path === '/api/calls/accept')?.body).toEqual({ callId: 'c2' });
    expect(store.getSnapshot().call).toMatchObject({ id: 'c2', state: 'active', mine: true });
    store.callMute();
    expect(store.getSnapshot().call?.muted).toBe(true);
    expect(only(sessions).muted).toBe(true);
    await store.callHangup(); // (also stops the page's 15-second check on the call)
    expect(store.getSnapshot().call).toBeNull();
  });

  it('CALLUI-39: signing out ends a call that is going; the server is told and the page shows nothing of it', async () => {
    const sessions: FakeSession[] = [];
    const seen = server({ 'POST /api/calls/invite': reply(view()), 'POST /api/auth/logout': { ok: true } });
    const store = storeWith(sessions);
    await store.callStart('bob');
    await store.signOut();
    expect(store.getSnapshot().call).toBeNull();
    expect(only(sessions).closed).toBe(true);
    await until(() => seen.some((s) => s.path === '/api/calls/hangup'), 'the hangup');
    expect(seen.find((s) => s.path === '/api/calls/hangup')?.body).toEqual({ callId: 'c1' });
  });

  it('CALLUI-40: names and lines are kept as plain text in the page\'s state (the screens print them as text, never as markup)', () => {
    const sessions: FakeSession[] = [];
    const store = storeWith(sessions);
    live(store).onCall({ call: view({ id: 'c7', direction: 'incoming', other: person('eve', '<img src=x onerror=alert(1)>') }) });
    expect(store.getSnapshot().call?.other.displayName).toBe('<img src=x onerror=alert(1)>');
    live(store).onCall({ call: null, ended: ended({ callId: 'c7', reason: 'missed', role: 'callee', other: person('eve', '<img src=x onerror=alert(1)>') }) });
    expect(store.getSnapshot().callNote).toBe('Missed call from <img src=x onerror=alert(1)>.');
  });
});
