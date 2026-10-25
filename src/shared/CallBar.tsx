// The voice call on screen: a bar at the bottom of every screen while a friend is calling you, you are calling, or you are talking (Answer, Decline,
// Cancel, Mute, Hang up), a line about a call that just ended, and the "Call" button next to a friend. The page only shows what the call
// controller holds (src/shared/callController.ts); the other player's voice is played by the hidden <audio> element below.
import { useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { callHeadline, ringSecondsLeft } from './callsUtil';
import { browserRingtone, type Ringtone } from './ringtone';
import { sharedStore, useShared } from './store';

/** The current time on this page's clock, refreshed every second while `running`. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

export function CallBar() {
  const { user, call, callNote, callStream } = useShared();
  const now = useNow(call !== null);
  const audio = useRef<HTMLAudioElement>(null);
  const ringtone = useRef<Ringtone | null>(null);
  // A call that is ringing for this player plays the ringtone until it is answered, declined, missed or cancelled.
  const callingMe = call !== null && call.state === 'ringing' && call.phase !== 'mic' && call.direction === 'incoming';
  useEffect(() => {
    if (!callingMe) return undefined;
    const tone = (ringtone.current ??= browserRingtone());
    tone.start();
    return () => tone.stop();
  }, [callingMe, call?.id]);

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    el.srcObject = (callStream as MediaStream | null) ?? null;
    if (callStream) void el.play?.().catch(() => undefined);
  }, [callStream, call?.id]);

  if (!user) return null;

  if (!call) {
    if (callNote === null) return null;
    return (
      <div className="call-bar note" role="status" data-testid="call-note">
        <span className="call-title">{callNote}</span>
        <button type="button" className="btn btn-small btn-ghost" onClick={() => sharedStore.callDismissNote()} data-testid="call-note-close">
          Close
        </button>
      </div>
    );
  }

  const ringing = call.state === 'ringing' && call.phase !== 'mic';
  const incoming = ringing && call.direction === 'incoming';
  const live = call.state === 'active' && call.phase === 'connected';
  const left = ringSecondsLeft(call, now);
  return (
    <>
      {call.mine && <audio ref={audio} autoPlay playsInline data-testid="call-audio" />}
      <div className={`call-bar${incoming ? ' incoming' : ''}${live ? ' live' : ''}`} role={incoming ? 'alert' : 'status'} data-testid="call-bar" data-phase={call.phase} data-state={call.state}>
        <Avatar username={call.other.username} displayName={call.other.displayName} size={40} className="call-pfp" />
        <div className="call-main">
          <span className="call-title" data-testid="call-title">
            {callHeadline(call, now)}
          </span>
          {ringing && (
            <span className="call-sub">
              {left > 0 ? `${left} s to answer. ` : ''}Calls go straight between your browsers, so the server and the owner never hear them. Your friend&apos;s browser can see your network address.
            </span>
          )}
          {live && call.muted && <span className="call-sub">You are muted: they cannot hear you.</span>}
        </div>
        <div className="call-actions">
          {incoming && (
            <>
              <button type="button" className="btn btn-buy" onClick={() => void sharedStore.callAnswer()} data-testid="call-answer">
                Answer
              </button>
              <button type="button" className="btn btn-sell" onClick={() => void sharedStore.callHangup()} data-testid="call-decline">
                Decline
              </button>
            </>
          )}
          {!incoming && call.state === 'ringing' && (
            <button type="button" className="btn btn-ghost" onClick={() => void sharedStore.callHangup()} data-testid="call-cancel">
              Cancel
            </button>
          )}
          {call.state === 'active' && (
            <>
              {call.mine && (
                <button type="button" className="btn btn-ghost" aria-pressed={call.muted} onClick={() => sharedStore.callMute()} data-testid="call-mute">
                  {call.muted ? 'Unmute' : 'Mute'}
                </button>
              )}
              <button type="button" className="btn btn-sell" onClick={() => void sharedStore.callHangup()} data-testid="call-hangup">
                Hang up
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** "Call" next to a friend. */
export function CallButton({ username }: { username: string }) {
  const { call } = useShared();
  const busy = call !== null;
  return (
    <button
      type="button"
      className="btn btn-small btn-ghost"
      disabled={busy}
      title={busy ? 'You are already on a call.' : 'Call this friend with your voice (they must have TradeQuest open).'}
      onClick={() => void sharedStore.callStart(username)}
      data-testid={`call-${username}`}
    >
      Call
    </button>
  );
}
