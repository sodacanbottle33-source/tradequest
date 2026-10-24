// What this page does about a voice call: asks for the microphone, rings, answers, connects the sound, hangs up, and keeps what the screens show
// (`CallState`) in step with what the server says. The rules are the server's (server/calls.ts); this file never decides who may call whom, and it
// never invents a call: the screen shows a call only after the server described it (the one exception is the moment between pressing Call and the
// server's answer, which the screen shows as "Getting your microphone…").
//
// One player can have several pages open. The server tells all of them about the call, but only the page that pressed Call or Answer holds the
// microphone and the connection (`mine`); the others just show that a call is going and offer "Hang up".

import { ApiError } from './api';
import { CONNECTION_FAILED, DEFAULT_ICE, endedNote } from './callsUtil';
import type { CallEnded, CallSignal, CallsReply, CallState, CallView, IceServer } from './types';
import type { VoicePhase } from './voice';
import { VoiceError } from './voice';

/** The parts of a voice session the controller uses (VoiceSession in ./voice, or a stand-in in tests). */
export interface SessionLike {
  prepare(): Promise<void>;
  begin(ice: readonly IceServer[]): Promise<void>;
  handleSignal(signal: CallSignal): Promise<void>;
  setMuted(muted: boolean): void;
  close(): void;
}

export interface SessionHooks {
  sendSignal(signal: CallSignal): void;
  onPhase(phase: VoicePhase): void;
  onRemote(stream: unknown | null): void;
}

export interface ControllerDeps {
  readonly api: {
    view(): Promise<CallsReply>;
    invite(username: string): Promise<CallsReply>;
    accept(callId: string): Promise<CallsReply>;
    hangup(callId: string, failed: boolean): Promise<CallsReply>;
    signal(callId: string, signal: CallSignal): Promise<unknown>;
  };
  state(): CallState | null;
  setCall(call: CallState | null): void;
  setNote(text: string | null): void;
  setStream(stream: unknown | null): void;
  makeSession(role: 'caller' | 'callee', hooks: SessionHooks): SessionLike;
  now(): number;
  later(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/** How often the page asks the server whether the call is still there (a safety net for a live message that got lost). */
export const CHECK_MS = 15_000;
/** How long a line about a finished call stays on the screen. */
export const NOTE_MS = 12_000;

export class CallController {
  private session: SessionLike | null = null;
  /** The number of the call the session belongs to ('' while the call is being started). */
  private sessionFor: string | null = null;
  private began = false;
  private starting = false;
  private answering = false;
  private abortStart = false;
  private ice: readonly IceServer[] = DEFAULT_ICE;
  private sends: Promise<void> = Promise.resolve();
  private check: unknown = null;
  private noteTimer: unknown = null;

  constructor(private readonly d: ControllerDeps) {}

  // ---- what the player does ----------------------------------------------------------------------------------------

  /** Presses "Call" next to a friend. */
  async start(username: string): Promise<void> {
    if (this.d.state() !== null || this.starting) return;
    this.starting = true;
    this.abortStart = false;
    this.say(null);
    this.d.setCall({ id: '', state: 'ringing', direction: 'outgoing', other: { username, displayName: username, role: 'player' }, ringEndsAt: null, mine: true, phase: 'mic', muted: false, connectedAt: null });
    const session = this.d.makeSession('caller', this.hooks());
    try {
      await session.prepare();
      if (this.abortStart) {
        session.close();
        return;
      }
      this.session = session;
      this.sessionFor = '';
      this.began = false;
      const asking = this.d.state();
      if (asking) this.d.setCall({ ...asking, phase: 'ringing' });
      const reply = await this.d.api.invite(username);
      this.take(reply);
      if (this.abortStart) {
        // The player pressed Cancel while the server was ringing: take the ring back.
        if (reply.call) void this.d.api.hangup(reply.call.id, false).catch(() => undefined);
        this.cleanup();
        return;
      }
      if (reply.call) this.apply(reply.call);
      else this.cleanup();
    } catch (error) {
      session.close();
      if (!this.abortStart) {
        this.cleanup();
        this.say(error instanceof VoiceError || error instanceof ApiError ? error.message : 'The call could not be started.');
      }
    } finally {
      this.starting = false;
    }
  }

  /** Presses "Answer" on a ring. */
  async answer(): Promise<void> {
    const cur = this.d.state();
    if (!cur || cur.direction !== 'incoming' || cur.state !== 'ringing' || this.session !== null || this.answering || this.starting || cur.id === '') return;
    this.answering = true;
    this.say(null);
    this.d.setCall({ ...cur, mine: true, phase: 'mic' });
    const session = this.d.makeSession('callee', this.hooks());
    const stillRinging = (): boolean => this.d.state()?.id === cur.id;
    try {
      await session.prepare();
      if (!stillRinging()) {
        // The ring ended (or was answered elsewhere) while the browser asked about the microphone.
        session.close();
        return;
      }
      this.session = session;
      this.sessionFor = cur.id;
      // The connection is made before the answer goes out, so it is ready for the offer that follows at once.
      this.began = true;
      await session.begin(this.ice);
      if (!stillRinging()) {
        this.cleanup();
        return;
      }
      const reply = await this.d.api.accept(cur.id);
      this.take(reply);
      if (reply.call) this.apply(reply.call);
      else this.cleanup();
    } catch (error) {
      session.close();
      if (this.session === session) {
        this.session = null;
        this.sessionFor = null;
        this.began = false;
      }
      const gone = error instanceof ApiError && (error.status === 404 || error.status === 409);
      this.say(error instanceof VoiceError || error instanceof ApiError ? error.message : 'The call could not be answered.');
      if (gone) await this.reconcile();
      else if (this.d.state()?.id === cur.id) this.d.setCall({ ...cur, mine: false, phase: 'ringing' });
    } finally {
      this.answering = false;
    }
  }

  /** Presses Cancel (while calling), Decline (while ringing) or Hang up. */
  async hangup(): Promise<void> {
    const cur = this.d.state();
    if (!cur) return;
    if (cur.id === '') {
      // Still getting the microphone or waiting for the server to ring: stop that.
      this.abortStart = true;
      this.cleanup();
      return;
    }
    this.cleanup();
    await this.d.api.hangup(cur.id, false).catch(() => undefined);
  }

  toggleMute(): void {
    const cur = this.d.state();
    if (!cur || !cur.mine || !this.session) return;
    const muted = !cur.muted;
    this.session.setMuted(muted);
    this.d.setCall({ ...cur, muted });
  }

  dismissNote(): void {
    this.say(null);
  }

  /** Signing out: let go of everything. */
  reset(): void {
    const id = this.d.state()?.id;
    this.abortStart = this.starting;
    this.cleanup();
    this.say(null);
    if (id) void this.d.api.hangup(id, false).catch(() => undefined);
  }

  // ---- what the server says ----------------------------------------------------------------------------------------

  /** The live message "call": the call changed, or it is over. */
  onCall(payload: { call: CallView | null; ended?: CallEnded }): void {
    if (payload.ended) {
      const cur = this.d.state();
      if (cur && cur.id === payload.ended.callId) {
        this.cleanup();
        this.say(endedNote(payload.ended));
      }
      return;
    }
    if (payload.call) this.apply(payload.call);
  }

  /** The live message "call_signal": a connection message from the other player. */
  onSignal(payload: { callId: string; signal: CallSignal }): void {
    if (this.session && this.began && this.sessionFor === payload.callId) void this.session.handleSignal(payload.signal);
  }

  /** Asks the server what the call is now (after a reconnect, and every so often). */
  async reconcile(): Promise<void> {
    try {
      const reply = await this.d.api.view();
      this.take(reply);
      const cur = this.d.state();
      if (reply.call) this.apply(reply.call);
      else if (cur && cur.id !== '' && !this.starting) {
        this.cleanup();
        this.say('The call ended.');
      }
    } catch {
      // the server is away; the page's own reconnect logic deals with that
    }
  }

  // ---- inside -----------------------------------------------------------------------------------------------------

  private take(reply: CallsReply): void {
    if (reply.ice.length > 0) this.ice = reply.ice;
  }

  private hooks(): SessionHooks {
    return {
      sendSignal: (signal) => this.send(signal),
      onPhase: (phase) => this.onPhase(phase),
      onRemote: (stream) => this.d.setStream(stream),
    };
  }

  /** Signals go out one after the other, in the order the browser made them. */
  private send(signal: CallSignal): void {
    const id = this.sessionFor;
    if (!id) return;
    this.sends = this.sends
      .then(() => this.d.api.signal(id, signal))
      .then(
        () => undefined,
        (error: unknown) => {
          if (error instanceof ApiError && (error.status === 404 || error.status === 409)) void this.reconcile();
        },
      );
  }

  private onPhase(phase: VoicePhase): void {
    const cur = this.d.state();
    if (!cur || !cur.mine) return;
    if (phase === 'connected') this.d.setCall({ ...cur, phase: 'connected', connectedAt: cur.connectedAt ?? this.d.now() });
    else if (phase === 'failed') this.giveUp();
  }

  /** The browsers could not connect: tell the other player and leave. */
  private giveUp(): void {
    const id = this.d.state()?.id ?? '';
    this.cleanup();
    this.say(CONNECTION_FAILED);
    if (id) void this.d.api.hangup(id, true).catch(() => undefined);
  }

  /** Brings the screen in line with a call the server described. */
  private apply(view: CallView): void {
    const cur = this.d.state();
    const ringEndsAt = view.msLeft === null ? null : this.d.now() + view.msLeft;
    const ours = cur !== null && (cur.id === view.id || (cur.id === '' && this.session !== null && cur.other.username === view.other.username));
    if (cur && !ours) return; // a different call than the one on screen: the server allows only one, so this is an old message
    if (cur && cur.state === 'active' && view.state === 'ringing') return; // an old answer must not take a call back to ringing
    const mine = cur?.mine ?? false;
    const next: CallState = {
      id: view.id,
      state: view.state,
      direction: view.direction,
      other: view.other,
      ringEndsAt,
      mine,
      phase: cur?.phase === 'connected' ? 'connected' : cur?.phase === 'mic' && this.answering && view.state === 'ringing' ? 'mic' : view.state === 'ringing' ? 'ringing' : 'connecting',
      muted: cur?.muted ?? false,
      connectedAt: cur?.connectedAt ?? null,
    };
    this.d.setCall(next);
    if (this.session && this.sessionFor === '') this.sessionFor = view.id;
    this.watch();
    if (view.state === 'active' && this.session && !this.began) {
      // The caller's call was answered: now the connection can be made and the offer sent.
      this.began = true;
      const session = this.session;
      void session.begin(this.ice).catch((error: unknown) => {
        if (this.session !== session) return;
        const id = this.d.state()?.id ?? '';
        this.cleanup();
        this.say(error instanceof VoiceError ? error.message : CONNECTION_FAILED);
        if (id) void this.d.api.hangup(id, true).catch(() => undefined);
      });
    }
  }

  /** While a call exists, ask the server now and then whether it is still there. */
  private watch(): void {
    if (this.check !== null) return;
    const step = (): void => {
      this.check = null;
      if (this.d.state() === null) return;
      void this.reconcile();
      this.check = this.d.later(step, CHECK_MS);
    };
    this.check = this.d.later(step, CHECK_MS);
  }

  /** Lets go of the microphone and the connection and clears the screen's call. */
  private cleanup(): void {
    this.session?.close();
    this.session = null;
    this.sessionFor = null;
    this.began = false;
    if (this.check !== null) this.d.cancel(this.check);
    this.check = null;
    this.d.setStream(null);
    this.d.setCall(null);
  }

  /** Shows a line about the call for a while (null clears it). */
  private say(text: string | null): void {
    if (this.noteTimer !== null) this.d.cancel(this.noteTimer);
    this.noteTimer = null;
    this.d.setNote(text);
    if (text !== null) {
      this.noteTimer = this.d.later(() => {
        this.noteTimer = null;
        this.d.setNote(null);
      }, NOTE_MS);
    }
  }
}
