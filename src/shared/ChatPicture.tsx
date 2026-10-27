// Pictures in chats: showing the picture of a message, and choosing one to send. The picture of a message is fetched from the server by the message's
// number (it is only given to a player who may read that message); a picture that has expired shows a short note instead. The file a player chooses is
// shrunk in the browser first (src/shared/chatPictureUtil.ts), and the server checks it again.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CHAT_PICK_TYPES, shrinkChatPicture } from './chatPictureUtil';
import type { PictureState } from './types';

/** Where a picture lives: the public chat room, a private chat, or the copy a report keeps for the owner. */
export type PictureKind = 'chat' | 'pm' | 'report';

export function pictureUrl(kind: PictureKind, messageId: number): string {
  if (kind === 'chat') return `/api/chat/picture/${messageId}`;
  if (kind === 'pm') return `/api/messages/picture/${messageId}`;
  return `/api/admin/private-reports/picture/${messageId}`;
}

/** The picture of one message. Click it to see it bigger. */
export function MessagePicture({ kind, messageId, state }: { kind: PictureKind; messageId: number; state: PictureState }) {
  const [failed, setFailed] = useState(false);
  const [big, setBig] = useState(false);
  useEffect(() => setFailed(false), [messageId, state]);
  useEffect(() => {
    if (!big) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setBig(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [big]);
  if (state === 'expired' || failed) {
    return (
      <p className="chat-pic-gone muted" data-testid="picture-gone">
        {state === 'expired' ? 'This picture has expired. Pictures in chats are kept for 7 days.' : 'This picture is not available any more.'}
      </p>
    );
  }
  const src = pictureUrl(kind, messageId);
  return (
    <>
      <button type="button" className="chat-pic-btn" onClick={() => setBig(true)} aria-label="Look at the picture bigger" data-testid={`picture-${messageId}`}>
        <img className="chat-pic" src={src} alt="A picture sent in the chat" loading="lazy" onError={() => setFailed(true)} />
      </button>
      {big && (
        <div className="pic-overlay" role="dialog" aria-modal="true" aria-label="Picture" onClick={() => setBig(false)} data-testid="picture-overlay">
          <img className="pic-big" src={src} alt="A picture sent in the chat" />
          <button type="button" className="btn btn-small pic-close" onClick={() => setBig(false)} data-testid="picture-close">
            Close
          </button>
        </div>
      )}
    </>
  );
}

/** What the picture button needs to know and do. */
export interface PicturePick {
  /** The shrunk picture as a data address, ready to send (null = none chosen). */
  readonly picture: string | null;
  readonly busy: boolean;
  /** Why the chosen file could not be used. */
  readonly problem: string | null;
  pick(file: File | undefined): Promise<void>;
  clear(): void;
}

/** The state of "the picture I am about to send". */
export function usePicturePick(): PicturePick {
  const [picture, setPicture] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const pick = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    try {
      const url = await shrinkChatPicture(file);
      if (alive.current) setPicture(url);
    } catch (e) {
      if (alive.current) {
        setPicture(null);
        setProblem(e instanceof Error ? e.message : 'That picture could not be used.');
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);
  const clear = useCallback(() => {
    setPicture(null);
    setProblem(null);
  }, []);
  return { picture, busy, problem, pick, clear };
}

/** The "Picture" button next to the box that holds the message. It opens the player's own files (or his camera on a phone). */
export function PictureButton({ pick, disabled, testId }: { pick: PicturePick; disabled: boolean; testId: string }) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={CHAT_PICK_TYPES}
        className="pic-file"
        tabIndex={-1}
        aria-hidden="true"
        data-testid={`${testId}-file`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ''; // the same file can be chosen again
          void pick.pick(file);
        }}
      />
      <button type="button" className="btn btn-ghost pic-add" disabled={disabled || pick.busy} onClick={() => input.current?.click()} aria-label="Add a picture" data-testid={testId}>
        {pick.busy ? 'Preparing…' : 'Picture'}
      </button>
    </>
  );
}

/** A small preview of the picture that is about to be sent, with a way to take it away. */
export function PicturePreview({ pick, testId }: { pick: PicturePick; testId: string }) {
  if (!pick.picture && !pick.problem) return null;
  return (
    <div className="pic-preview" data-testid={testId}>
      {pick.picture && (
        <>
          <img className="pic-thumb" src={pick.picture} alt="The picture you are about to send" />
          <button type="button" className="btn btn-small btn-ghost" onClick={pick.clear} data-testid={`${testId}-remove`}>
            Take the picture away
          </button>
        </>
      )}
      {pick.problem && (
        <p className="notice error" role="alert" data-testid={`${testId}-problem`}>
          {pick.problem}
        </p>
      )}
    </div>
  );
}
