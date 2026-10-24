// The sound of a voice call (src/shared/voice.ts) with stand-ins for the browser's microphone and connection: what is created and sent and in what
// order, how signals that arrive early or late are handled, when the connection counts as up or lost, and that everything is let go at the end.
import { describe, expect, it } from 'vitest';
import { browserVoiceDeps, CONNECT_MS, LOST_MS, MAX_CANDIDATES_SENT, micProblem, VoiceError, VoiceSession, type MicLike, type PeerLike, type TrackLike, type VoiceDeps, type VoicePhase } from '../src/shared/voice';
import type { CallSignal, IceServer } from '../src/shared/types';

class Track implements TrackLike {
  enabled = true;
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}
class Mic implements MicLike {
  readonly track = new Track();
  getAudioTracks(): TrackLike[] {
    return [this.track];
  }
  getTracks(): TrackLike[] {
    return [this.track];
  }
}

class Peer implements PeerLike {
  connectionState: string | undefined = 'new';
  iceConnectionState: string | undefined = 'new';
  onicecandidate: PeerLike['onicecandidate'] = null;
  ontrack: PeerLike['ontrack'] = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  readonly log: string[] = [];
  readonly added: { candidate: string }[] = [];
  readonly tracks: unknown[] = [];
  closed = false;
  remote: { type: string; sdp: string } | null = null;
  local: { type?: string; sdp?: string } | null = null;
  /** Makes setRemoteDescription slow, to test signals that arrive while it is running. */
  gate: Promise<void> | null = null;
  failAdd = false;
  addTrack(track: unknown, stream: unknown): unknown {
    this.tracks.push([track, stream]);
    this.log.push('addTrack');
    return {};
  }
  async createOffer() {
    this.log.push('createOffer');
    return { type: 'offer', sdp: 'v=0 offer' };
  }
  async createAnswer() {
    this.log.push('createAnswer');
    return { type: 'answer', sdp: 'v=0 answer' };
  }
  async setLocalDescription(description: { type?: string; sdp?: string }) {
    this.log.push(`setLocal:${description.type}`);
    this.local = description;
  }
  async setRemoteDescription(description: { type: string; sdp: string }) {
    if (this.gate) await this.gate;
    this.log.push(`setRemote:${description.type}`);
    this.remote = description;
  }
  async addIceCandidate(candidate: { candidate: string }) {
    if (this.failAdd) throw new Error('bad candidate');
    this.log.push(`addIce:${candidate.candidate}`);
    this.added.push(candidate);
  }
  close(): void {
    this.closed = true;
    this.log.push('close');
  }
  setState(state: string | undefined, ice?: string | undefined): void {
    this.connectionState = state;
    if (ice !== undefined || state === undefined) this.iceConnectionState = ice;
    this.onconnectionstatechange?.();
    this.oniceconnectionstatechange?.();
  }
}

interface Rig {
  mic: Mic;
  peer: Peer;
  sent: CallSignal[];
  phases: VoicePhase[];
  remote: unknown[];
  timers: { fn: () => void; ms: number; id: number; live: boolean }[];
  ice: IceServer[][];
  deps: VoiceDeps;
  fire(ms: number): void;
}
function rig(patch: Partial<VoiceDeps> = {}): Rig {
  const mic = new Mic();
  const peer = new Peer();
  const r: Rig = {
    mic,
    peer,
    sent: [],
    phases: [],
    remote: [],
    timers: [],
    ice: [],
    deps: undefined as unknown as VoiceDeps,
    fire(ms) {
      for (const t of r.timers.filter((x) => x.live && x.ms === ms)) {
        t.live = false;
        t.fn();
      }
    },
  };
  r.deps = {
    getMic: async () => mic,
    createPeer: (ice) => {
      r.ice.push([...ice]);
      return peer;
    },
    sendSignal: (s) => r.sent.push(s),
    onPhase: (p) => r.phases.push(p),
    onRemote: (s) => r.remote.push(s),
    later: (fn, ms) => {
      const t = { fn, ms, id: r.timers.length + 1, live: true };
      r.timers.push(t);
      return t.id;
    },
    cancel: (id) => {
      const t = r.timers.find((x) => x.id === id);
      if (t) t.live = false;
    },
    ...patch,
  };
  return r;
}
const ICE: IceServer[] = [{ urls: ['stun:s.example.org:3478'] }];
const flush = () => new Promise((done) => setTimeout(done, 5));
const cand = (n: number, extra: Partial<Extract<CallSignal, { kind: 'candidate' }>> = {}): CallSignal => ({ kind: 'candidate', candidate: `c${n}`, sdpMid: '0', sdpMLineIndex: 0, ...extra });

describe('making the call', () => {
  it('VOICE-1: the caller gets the microphone, puts it on a new connection that uses the given servers, and sends the offer', async () => {
    const r = rig();
    const s = new VoiceSession('caller', r.deps);
    await s.prepare();
    expect(r.peer.log).toEqual([]);
    await s.begin(ICE);
    expect(r.ice).toEqual([ICE]);
    expect(r.peer.tracks).toEqual([[r.mic.track, r.mic]]);
    expect(r.peer.log).toEqual(['addTrack', 'createOffer', 'setLocal:offer']);
    expect(r.sent).toEqual([{ kind: 'offer', sdp: 'v=0 offer' }]);
    expect(r.phases).toEqual(['connecting']);
    // Starting twice changes nothing.
    await s.begin(ICE);
    expect(r.sent).toHaveLength(1);
    expect(r.ice).toHaveLength(1);
  });

  it('VOICE-2: the answering player prepares the connection and sends nothing until the offer arrives; then it answers', async () => {
    const r = rig();
    const s = new VoiceSession('callee', r.deps);
    await s.prepare();
    await s.begin(ICE);
    expect(r.sent).toEqual([]);
    await s.handleSignal({ kind: 'offer', sdp: 'v=0 their offer' });
    expect(r.peer.log).toEqual(['addTrack', 'setRemote:offer', 'createAnswer', 'setLocal:answer']);
    expect(r.peer.remote).toEqual({ type: 'offer', sdp: 'v=0 their offer' });
    expect(r.sent).toEqual([{ kind: 'answer', sdp: 'v=0 answer' }]);
  });

  it('VOICE-3: the caller takes the answer; an offer to the caller or an answer to the callee is ignored, and so is a second one', async () => {
    const a = rig();
    const caller = new VoiceSession('caller', a.deps);
    await caller.prepare();
    await caller.begin(ICE);
    await caller.handleSignal({ kind: 'offer', sdp: 'v=0 nonsense' });
    expect(a.peer.remote).toBeNull();
    await caller.handleSignal({ kind: 'answer', sdp: 'v=0 first' });
    await caller.handleSignal({ kind: 'answer', sdp: 'v=0 second' });
    expect(a.peer.remote).toEqual({ type: 'answer', sdp: 'v=0 first' });
    const b = rig();
    const callee = new VoiceSession('callee', b.deps);
    await callee.prepare();
    await callee.begin(ICE);
    await callee.handleSignal({ kind: 'answer', sdp: 'v=0 nonsense' });
    expect(b.peer.remote).toBeNull();
    await callee.handleSignal({ kind: 'offer', sdp: 'v=0 first' });
    await callee.handleSignal({ kind: 'offer', sdp: 'v=0 second' });
    expect(b.peer.remote?.sdp).toBe('v=0 first');
    expect(b.sent).toHaveLength(1);
  });

  it('VOICE-4: a network address that arrives before the other side\'s description is held until it is there; later ones go straight in', async () => {
    const r = rig();
    const s = new VoiceSession('callee', r.deps);
    await s.prepare();
    await s.begin(ICE);
    await s.handleSignal(cand(1));
    await s.handleSignal(cand(2));
    expect(r.peer.added).toEqual([]);
    await s.handleSignal({ kind: 'offer', sdp: 'v=0 their offer' });
    expect(r.peer.log.filter((l) => l.startsWith('addIce'))).toEqual(['addIce:c1', 'addIce:c2']);
    expect(r.peer.log.indexOf('addIce:c1')).toBeGreaterThan(r.peer.log.indexOf('setLocal:answer'));
    await s.handleSignal(cand(3));
    expect(r.peer.added.map((c) => c.candidate)).toEqual(['c1', 'c2', 'c3']);
    // An address the browser refuses does not break the call.
    r.peer.failAdd = true;
    await s.handleSignal(cand(4));
    r.peer.failAdd = false;
    await s.handleSignal(cand(5));
    expect(r.peer.added.map((c) => c.candidate)).toEqual(['c1', 'c2', 'c3', 'c5']);
  });

  it('VOICE-5: signals are handled one at a time in the order they came, even when the first is slow', async () => {
    const r = rig();
    const s = new VoiceSession('callee', r.deps);
    await s.prepare();
    await s.begin(ICE);
    let open: () => void = () => undefined;
    r.peer.gate = new Promise<void>((done) => {
      open = done;
    });
    const offer = s.handleSignal({ kind: 'offer', sdp: 'v=0 slow' });
    const early = s.handleSignal(cand(1));
    await flush();
    expect(r.peer.added).toEqual([]);
    open();
    await Promise.all([offer, early]);
    expect(r.peer.log.slice(-3)).toEqual(['createAnswer', 'setLocal:answer', 'addIce:c1']);
  });

  it('VOICE-6: the addresses the browser finds are sent, the end-of-list marker is not, and no more than the limit', async () => {
    const r = rig();
    const s = new VoiceSession('caller', r.deps);
    await s.prepare();
    await s.begin(ICE);
    r.peer.onicecandidate?.({ candidate: { candidate: 'a1', sdpMid: '0', sdpMLineIndex: 0 } });
    r.peer.onicecandidate?.({ candidate: { candidate: 'a2' } });
    r.peer.onicecandidate?.({ candidate: null });
    expect(r.sent.slice(1)).toEqual([
      { kind: 'candidate', candidate: 'a1', sdpMid: '0', sdpMLineIndex: 0 },
      { kind: 'candidate', candidate: 'a2', sdpMid: null, sdpMLineIndex: null },
    ]);
    for (let i = 0; i < MAX_CANDIDATES_SENT + 10; i += 1) r.peer.onicecandidate?.({ candidate: { candidate: `x${i}` } });
    expect(r.sent.filter((x) => x.kind === 'candidate')).toHaveLength(MAX_CANDIDATES_SENT);
  });

  it('VOICE-7: the other player\'s voice is handed on when it arrives', async () => {
    const r = rig();
    const s = new VoiceSession('caller', r.deps);
    await s.prepare();
    await s.begin(ICE);
    const stream = { id: 'remote' };
    r.peer.ontrack?.({ streams: [] });
    expect(r.remote).toEqual([]);
    r.peer.ontrack?.({ streams: [stream] });
    expect(r.remote).toEqual([stream]);
  });
});

describe('the connection', () => {
  it('VOICE-8: connected once the connection says so, with or without the newer state; failed at once on "failed"', async () => {
    const r = rig();
    const s = new VoiceSession('caller', r.deps);
    await s.prepare();
    await s.begin(ICE);
    r.peer.setState('connecting');
    expect(s.currentPhase).toBe('connecting');
    r.peer.setState('connected');
    r.peer.setState('connected');
    expect(r.phases).toEqual(['connecting', 'connected']);
    r.peer.setState('failed');
    expect(r.phases).toEqual(['connecting', 'connected', 'failed']);
    expect(s.currentPhase).toBe('failed');
    // An older browser has only the ice state.
    const old = rig();
    const o = new VoiceSession('callee', old.deps);
    await o.prepare();
    await o.begin(ICE);
    old.peer.setState(undefined, 'checking');
    expect(old.phases).toEqual(['connecting']);
    old.peer.setState(undefined, 'completed');
    expect(old.phases).toEqual(['connecting', 'connected']);
    old.peer.setState(undefined, 'failed');
    expect(old.phases).toEqual(['connecting', 'connected', 'failed']);
  });

  it('VOICE-9: a short break is forgiven and a long one ends the call', async () => {
    const r = rig();
    const s = new VoiceSession('caller', r.deps);
    await s.prepare();
    await s.begin(ICE);
    r.peer.setState('connected');
    r.peer.setState('disconnected');
    r.peer.setState('disconnected');
    expect(r.timers.filter((t) => t.ms === LOST_MS && t.live)).toHaveLength(1);
    r.peer.setState('connected'); // back in time
    r.fire(LOST_MS);
    expect(s.currentPhase).toBe('connected');
    r.peer.setState('disconnected');
    r.fire(LOST_MS);
    expect(s.currentPhase).toBe('failed');
    expect(r.phases).toEqual(['connecting', 'connected', 'failed']);
  });

  it('VOICE-10: a connection that never comes up gives up after the connect time, and one that came up does not', async () => {
    const a = rig();
    const s = new VoiceSession('caller', a.deps);
    await s.prepare();
    await s.begin(ICE);
    expect(a.timers.some((t) => t.ms === CONNECT_MS && t.live)).toBe(true);
    a.fire(CONNECT_MS);
    expect(a.phases).toEqual(['connecting', 'failed']);
    const b = rig();
    const t = new VoiceSession('caller', b.deps);
    await t.prepare();
    await t.begin(ICE);
    b.peer.setState('connected');
    expect(b.timers.find((x) => x.ms === CONNECT_MS)?.live).toBe(false);
    b.fire(CONNECT_MS);
    expect(t.currentPhase).toBe('connected');
  });
});

describe('muting and letting go', () => {
  it('VOICE-11: muting silences the microphone track without touching the connection, before and after the connection exists', async () => {
    const r = rig();
    const s = new VoiceSession('caller', r.deps);
    await s.prepare();
    s.setMuted(true);
    expect(r.mic.track.enabled).toBe(false);
    await s.begin(ICE);
    expect(r.mic.track.enabled).toBe(false);
    s.setMuted(false);
    expect(r.mic.track.enabled).toBe(true);
    expect(r.peer.closed).toBe(false);
  });

  it('VOICE-12: closing stops the microphone, closes the connection, forgets its handlers and the other voice, and can be done twice', async () => {
    const r = rig();
    const s = new VoiceSession('caller', r.deps);
    await s.prepare();
    await s.begin(ICE);
    r.peer.setState('connected');
    s.close();
    expect(r.mic.track.stopped).toBe(true);
    expect(r.peer.closed).toBe(true);
    expect([r.peer.onicecandidate, r.peer.ontrack, r.peer.onconnectionstatechange, r.peer.oniceconnectionstatechange]).toEqual([null, null, null, null]);
    expect(r.remote).toEqual([null]);
    expect(r.timers.every((t) => !t.live)).toBe(true);
    s.close();
    expect(r.remote).toEqual([null]);
    // Nothing happens after the end.
    const before = r.sent.length;
    await s.handleSignal({ kind: 'answer', sdp: 'v=0 late' });
    await s.begin(ICE);
    expect(r.sent).toHaveLength(before);
    expect(r.phases).toEqual(['connecting', 'connected']);
  });

  it('VOICE-13: a microphone that arrives after the call was already closed is let go at once', async () => {
    let give: (m: MicLike) => void = () => undefined;
    const mic = new Mic();
    const r = rig({
      getMic: () =>
        new Promise<MicLike>((done) => {
          give = done;
        }),
    });
    const s = new VoiceSession('caller', r.deps);
    const waiting = s.prepare();
    s.close();
    give(mic);
    await waiting;
    expect(mic.track.stopped).toBe(true);
    await s.begin(ICE);
    expect(r.ice).toEqual([]);
  });
});

describe('what goes wrong', () => {
  it('VOICE-14: each way the microphone can fail has its own plain words, and prepare passes them on', async () => {
    const named = (name: string) => Object.assign(new Error(name), { name });
    expect(micProblem(named('NotAllowedError'))).toMatch(/blocked/);
    expect(micProblem(named('SecurityError'))).toMatch(/blocked/);
    expect(micProblem(named('NotFoundError'))).toMatch(/No microphone/);
    expect(micProblem(named('NotReadableError'))).toMatch(/another app/);
    expect(micProblem(named('SomethingElse'))).toBe('The microphone could not be used.');
    expect(micProblem('text')).toBe('The microphone could not be used.');
    expect(micProblem(null)).toBe('The microphone could not be used.');
    const r = rig({
      getMic: async () => {
        throw named('NotAllowedError');
      },
    });
    const s = new VoiceSession('caller', r.deps);
    const error = await s.prepare().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceError);
    expect((error as Error).message).toBe(micProblem(named('NotAllowedError')));
    // A problem that is already in words is not reworded.
    const own = rig({
      getMic: async () => {
        throw new VoiceError('my own words');
      },
    });
    expect(((await new VoiceSession('caller', own.deps).prepare().catch((e: unknown) => e)) as Error).message).toBe('my own words');
  });

  it('VOICE-15: a browser that cannot make connections says so; beginning without a microphone is refused', async () => {
    const r = rig({
      createPeer: () => {
        throw new Error('no RTCPeerConnection');
      },
    });
    const s = new VoiceSession('caller', r.deps);
    await s.prepare();
    const error = await s.begin(ICE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceError);
    expect((error as Error).message).toMatch(/cannot make calls/);
    const none = new VoiceSession('caller', rig().deps);
    expect(((await none.begin(ICE).catch((e: unknown) => e)) as Error).message).toBe('The microphone is not ready.');
  });

  it('VOICE-16: the real browser parts refuse politely when there is no microphone support (an insecure page, an old browser)', async () => {
    const deps = browserVoiceDeps({ sendSignal: () => undefined, onPhase: () => undefined, onRemote: () => undefined });
    const error = await deps.getMic().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoiceError);
    expect((error as Error).message).toMatch(/secure/);
    // The timer pair works.
    let hit = 0;
    const handle = deps.later(() => {
      hit += 1;
    }, 1);
    await flush();
    expect(hit).toBe(1);
    const never = deps.later(() => {
      hit += 10;
    }, 20);
    deps.cancel(never);
    await new Promise((done) => setTimeout(done, 40));
    expect(hit).toBe(1);
    expect(handle).toBeDefined();
  });
});
