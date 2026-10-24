// The sound of a voice call: one microphone, one direct connection to the other player's browser (WebRTC), one stream of his voice coming back.
// The server never hears any of it. It only passes the small "signals" (an offer, an answer, network addresses to try) from one page to the
// other (server/calls.ts). Everything the browser provides is reached through `VoiceDeps`, so the steps below are tested with stand-ins.
//
// The steps. The player who calls: gets the microphone, rings, and once the call is answered creates the connection, adds the microphone,
// makes an offer and sends it. The player who answers: gets the microphone, creates the connection first (so it is ready), answers the ring,
// and when the offer arrives makes the answer. Both send the network addresses they find; an address that arrives before the other side's
// description is kept until the description is there.

import type { CallSignal, IceServer } from './types';

export type VoicePhase = 'idle' | 'connecting' | 'connected' | 'failed';

/** What the connection must do (the parts of RTCPeerConnection this file uses). */
export interface PeerLike {
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  onicecandidate: ((event: { candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null }) => void) | null;
  ontrack: ((event: { streams: readonly unknown[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  addTrack(track: unknown, stream: unknown): unknown;
  createOffer(): Promise<{ type?: string; sdp?: string }>;
  createAnswer(): Promise<{ type?: string; sdp?: string }>;
  setLocalDescription(description: { type?: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void>;
  addIceCandidate(candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }): Promise<void>;
  close(): void;
}

export interface TrackLike {
  enabled: boolean;
  stop(): void;
}

/** The microphone: a stream holding one audio track. */
export interface MicLike {
  getAudioTracks(): TrackLike[];
  getTracks(): TrackLike[];
}

export interface VoiceDeps {
  getMic(): Promise<MicLike>;
  createPeer(ice: readonly IceServer[]): PeerLike;
  /** Sends one signal to the other player (the order is kept by the caller). */
  sendSignal(signal: CallSignal): void;
  onPhase(phase: VoicePhase): void;
  /** The other player's voice (a stream to play) or null when it is gone. */
  onRemote(stream: unknown | null): void;
  later(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/** A problem the player can fix or at least understand, in words for the screen. */
export class VoiceError extends Error {}

/** How long the connection may stay "disconnected" before the call is given up, and how long the first connection may take. */
export const LOST_MS = 8_000;
export const CONNECT_MS = 25_000;
/** The most network addresses one side sends (a normal browser finds a handful). */
export const MAX_CANDIDATES_SENT = 60;

/** The words for a microphone that could not be used. */
export function micProblem(error: unknown): string {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'The microphone is blocked. Allow the microphone for this site in your browser (the icon next to the address), then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'No microphone was found. Plug one in and try again.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'Your microphone is being used by another app. Close that app and try again.';
  return 'The microphone could not be used.';
}

export class VoiceSession {
  private mic: MicLike | null = null;
  private peer: PeerLike | null = null;
  private pending: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }[] = [];
  private remoteSet = false;
  private muted = false;
  private closed = false;
  private phase: VoicePhase = 'idle';
  private sent = 0;
  private chain: Promise<void> = Promise.resolve();
  private lostTimer: unknown = null;
  private connectTimer: unknown = null;

  constructor(
    readonly role: 'caller' | 'callee',
    private readonly deps: VoiceDeps,
  ) {}

  get currentPhase(): VoicePhase {
    return this.phase;
  }

  /** Gets the microphone. Throws a VoiceError with words for the screen. */
  async prepare(): Promise<void> {
    try {
      this.mic = await this.deps.getMic();
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      throw new VoiceError(micProblem(error));
    }
    if (this.closed) this.stopMic();
  }

  /** Creates the connection with the microphone on it. The caller then makes the offer; the callee waits for it. */
  async begin(ice: readonly IceServer[]): Promise<void> {
    if (this.closed || this.peer) return;
    if (!this.mic) throw new VoiceError('The microphone is not ready.');
    let peer: PeerLike;
    try {
      peer = this.deps.createPeer(ice);
    } catch {
      throw new VoiceError('This browser cannot make calls. Try an up-to-date Chrome, Edge, Firefox or Safari.');
    }
    this.peer = peer;
    peer.onicecandidate = (event) => {
      const c = event.candidate;
      if (!c || this.closed || this.sent >= MAX_CANDIDATES_SENT) return;
      this.sent += 1;
      this.deps.sendSignal({ kind: 'candidate', candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null });
    };
    peer.ontrack = (event) => {
      if (!this.closed && event.streams[0] !== undefined) this.deps.onRemote(event.streams[0]);
    };
    peer.onconnectionstatechange = () => this.look();
    peer.oniceconnectionstatechange = () => this.look();
    for (const track of this.mic.getAudioTracks()) {
      track.enabled = !this.muted;
      peer.addTrack(track, this.mic);
    }
    this.setPhase('connecting');
    this.connectTimer = this.deps.later(() => {
      this.connectTimer = null;
      if (this.phase === 'connecting') this.fail();
    }, CONNECT_MS);
    if (this.role === 'caller') {
      const offer = await peer.createOffer();
      if (this.closed) return;
      await peer.setLocalDescription(offer);
      if (this.closed) return;
      this.deps.sendSignal({ kind: 'offer', sdp: offer.sdp ?? '' });
    }
  }

  /** Takes in a signal from the other player. Signals are handled one at a time, in the order they arrived. */
  handleSignal(signal: CallSignal): Promise<void> {
    this.chain = this.chain.then(() => this.apply(signal)).catch(() => {
      // a late or odd signal must never break the call that is going
    });
    return this.chain;
  }

  private async apply(signal: CallSignal): Promise<void> {
    const peer = this.peer;
    if (!peer || this.closed) return;
    if (signal.kind === 'offer') {
      if (this.role !== 'callee' || this.remoteSet) return;
      await peer.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      this.remoteSet = true;
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      if (!this.closed) this.deps.sendSignal({ kind: 'answer', sdp: answer.sdp ?? '' });
      await this.flush(peer);
    } else if (signal.kind === 'answer') {
      if (this.role !== 'caller' || this.remoteSet) return;
      await peer.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      this.remoteSet = true;
      await this.flush(peer);
    } else {
      const candidate = { candidate: signal.candidate, sdpMid: signal.sdpMid, sdpMLineIndex: signal.sdpMLineIndex };
      if (!this.remoteSet) this.pending.push(candidate);
      else await peer.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  private async flush(peer: PeerLike): Promise<void> {
    const waiting = this.pending;
    this.pending = [];
    for (const candidate of waiting) await peer.addIceCandidate(candidate).catch(() => undefined);
  }

  /** Mutes or unmutes the microphone (the other player hears silence; the connection stays). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  private look(): void {
    const peer = this.peer;
    if (!peer || this.closed) return;
    const state = peer.connectionState;
    const ice = peer.iceConnectionState;
    if (state === 'failed' || (state === undefined && ice === 'failed')) {
      this.fail();
    } else if (state === 'connected' || (state === undefined && (ice === 'connected' || ice === 'completed'))) {
      if (this.lostTimer !== null) this.deps.cancel(this.lostTimer);
      this.lostTimer = null;
      if (this.connectTimer !== null) this.deps.cancel(this.connectTimer);
      this.connectTimer = null;
      this.setPhase('connected');
    } else if ((state === 'disconnected' || (state === undefined && ice === 'disconnected')) && this.lostTimer === null) {
      // A short break is normal (Wi-Fi hiccup); wait a little before giving up.
      this.lostTimer = this.deps.later(() => {
        this.lostTimer = null;
        if (this.phase === 'connected' || this.phase === 'connecting') this.fail();
      }, LOST_MS);
    }
  }

  private setPhase(phase: VoicePhase): void {
    if (this.phase === phase || this.closed) return;
    this.phase = phase;
    this.deps.onPhase(phase);
  }

  private fail(): void {
    if (this.phase === 'failed' || this.closed) return;
    this.setPhase('failed');
  }

  private stopMic(): void {
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.mic = null;
  }

  /** Lets go of the microphone and the connection. Safe to call twice. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.lostTimer !== null) this.deps.cancel(this.lostTimer);
    if (this.connectTimer !== null) this.deps.cancel(this.connectTimer);
    this.lostTimer = null;
    this.connectTimer = null;
    if (this.peer) {
      this.peer.onicecandidate = null;
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
      this.peer.oniceconnectionstatechange = null;
      try {
        this.peer.close();
      } catch {
        // already closed
      }
      this.peer = null;
    }
    this.stopMic();
    this.pending = [];
    this.deps.onRemote(null);
  }
}

/** The real browser's parts. Throws a VoiceError with words for the screen when the browser cannot do calls. */
export function browserVoiceDeps(hooks: { sendSignal(signal: CallSignal): void; onPhase(phase: VoicePhase): void; onRemote(stream: unknown | null): void }): VoiceDeps {
  return {
    getMic: async () => {
      const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
      if (!devices || typeof devices.getUserMedia !== 'function') {
        throw new VoiceError('Calls need a secure (https) page and a browser with microphone support.');
      }
      if (typeof RTCPeerConnection === 'undefined') throw new VoiceError('This browser cannot make calls. Try an up-to-date Chrome, Edge, Firefox or Safari.');
      const stream = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      return stream as unknown as MicLike;
    },
    createPeer: (ice) => new RTCPeerConnection({ iceServers: ice.map((s) => ({ urls: [...s.urls], username: s.username, credential: s.credential })) }) as unknown as PeerLike,
    sendSignal: hooks.sendSignal,
    onPhase: hooks.onPhase,
    onRemote: hooks.onRemote,
    later: (fn, ms) => setTimeout(fn, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}
