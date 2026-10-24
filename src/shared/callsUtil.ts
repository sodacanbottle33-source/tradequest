// Small pure helpers for the call screens: the words and numbers they show. The rules (who may call whom, how long a ring lasts, what ends a call)
// are the server's; the page only shows what the server said.
import type { CallEnded, CallState, IceServer } from './types';

/** Free public STUN servers, used until the server's own list arrives. */
export const DEFAULT_ICE: readonly IceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

/** The line for a call whose connection could not be made or was lost on the way. */
export const CONNECTION_FAILED = 'The connection failed or was lost. Some networks (school, work, some mobile data) block direct calls.';

/** A line about a call that ended, or null when the player ended it himself and needs no explanation. */
export function endedNote(e: CallEnded): string | null {
  const name = e.other.displayName;
  switch (e.reason) {
    case 'missed':
      return e.role === 'caller' ? `${name} did not answer.` : `Missed call from ${name}.`;
    case 'declined':
      return e.byYou ? null : `${name} declined the call.`;
    case 'cancelled':
      return e.byYou ? null : `${name} stopped calling.`;
    case 'ended':
      return e.byYou ? null : `${name} ended the call.`;
    case 'failed':
      return CONNECTION_FAILED;
    case 'disconnected':
      return `The call ended because ${name} went offline.`;
    case 'unavailable':
      return 'The call ended.';
  }
}

/** "1:05" or "1:02:03": the length of a call. */
export function durationLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Whole seconds left to answer a ring (0 when it has run out or is answered). */
export function ringSecondsLeft(call: CallState, now: number): number {
  return call.ringEndsAt === null ? 0 : Math.max(0, Math.ceil((call.ringEndsAt - now) / 1000));
}

/** The one line the call bar shows. */
export function callHeadline(call: CallState, now: number): string {
  const name = call.other.displayName;
  if (call.phase === 'mic') return 'Getting your microphone…';
  if (call.state === 'ringing') return call.direction === 'outgoing' ? `Calling ${name}…` : `${name} is calling you`;
  if (!call.mine) return `In a call with ${name} on another page`;
  if (call.phase === 'connected' && call.connectedAt !== null) return `In a call with ${name} · ${durationLabel(now - call.connectedAt)}`;
  return `Connecting to ${name}…`;
}
