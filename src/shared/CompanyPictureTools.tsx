// Add, change or remove the picture of a stock or memecoin (docs/world.md §20). Offered to the player who launched the company and to the owner;
// the server decides again on every request. The browser shrinks the picture first (src/shared/avatarUtil.ts); the server checks it again.
import { useEffect, useRef, useState } from 'react';
import { newRequestId } from './adminUtil';
import { api } from './api';
import { PICK_TYPES, shrinkPicture } from './avatarUtil';
import { useLogos } from './logoStore';
import { problemText } from './playersUtil';
import { useShared } from './store';

/** The buttons themselves (the caller has already made sure this player may change the picture). */
export function CompanyPictureTools({ ticker }: { ticker: string }) {
  const { pictures } = useLogos();
  const has = pictures[ticker] !== undefined;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setNote(null);
    try {
      const image = await shrinkPicture(file);
      await api.setCompanyPicture(ticker, image, newRequestId());
      setNote({ kind: 'ok', text: `The picture of ${ticker} is changed. Everybody can see it.` });
    } catch (e) {
      setNote({ kind: 'error', text: e instanceof Error && !('status' in e) ? e.message : problemText(e) });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const remove = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.removeCompanyPicture(ticker, newRequestId());
      setNote({ kind: 'ok', text: `The picture of ${ticker} is removed.` });
    } catch (e) {
      setNote({ kind: 'error', text: problemText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="logo-tools" data-testid={`logo-tools-${ticker}`}>
      <input ref={input} type="file" accept={PICK_TYPES} hidden onChange={(e) => void choose(e.target.files?.[0])} data-testid={`logo-file-${ticker}`} />
      <button type="button" className="btn btn-small" disabled={busy} onClick={() => input.current?.click()} data-testid={`logo-change-${ticker}`}>
        {busy ? 'Working…' : has ? 'Change picture' : 'Add a picture'}
      </button>
      {has && (
        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => void remove()} data-testid={`logo-remove-${ticker}`}>
          Remove picture
        </button>
      )}
      {note && (
        <span className={note.kind === 'ok' ? 'hint' : 'hint logo-error'} role="status" data-testid={`logo-note-${ticker}`}>
          {note.text}
        </span>
      )}
    </div>
  );
}

/** On a company's page: the buttons appear only when the server says this player may change the picture (he launched it, or he is the owner). */
export function CompanyPictureBox({ ticker }: { ticker: string }) {
  const { user } = useShared();
  const name = user?.username ?? null;
  const [may, setMay] = useState(false);
  useEffect(() => {
    setMay(false);
    if (name === null) return;
    let alive = true;
    api.companyPictureRights(ticker).then(
      (r) => alive && setMay(r.canChange),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [ticker, name]);
  if (!may) return null;
  return <CompanyPictureTools ticker={ticker} />;
}

/** On the launch forms: choose the picture the new company will have (optional). It is sent right after the launch succeeded. */
export function LaunchPicturePicker({ kind, image, onImage }: { kind: 'coin' | 'stock'; image: string | null; onImage: (image: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    try {
      onImage(await shrinkPicture(file));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="logo-pick" data-testid={`launch-${kind}-picture`}>
      <span className="qty-label">Picture (optional)</span>
      {image !== null && <img className="logo" src={image} alt="" width={44} height={44} style={{ width: 44, height: 44 }} data-testid={`launch-${kind}-picture-preview`} />}
      <input ref={input} type="file" accept={PICK_TYPES} hidden onChange={(e) => void choose(e.target.files?.[0])} data-testid={`launch-${kind}-picture-file`} />
      <button type="button" className="btn btn-small" disabled={busy} onClick={() => input.current?.click()} data-testid={`launch-${kind}-picture-choose`}>
        {busy ? 'Working…' : image === null ? 'Choose a picture' : 'Choose another'}
      </button>
      {image !== null && (
        <button type="button" className="btn btn-small btn-ghost" onClick={() => onImage(null)} data-testid={`launch-${kind}-picture-clear`}>
          No picture
        </button>
      )}
      {problem && (
        <span className="hint logo-error" role="status" data-testid={`launch-${kind}-picture-problem`}>
          {problem}
        </span>
      )}
      {image === null && problem === null && <span className="hint">Shown next to the ticker for everybody. You can change or remove it later.</span>}
    </div>
  );
}

/** Sends the picture chosen on a launch form to the new company. Returns a sentence when it did not work (the company exists anyway), else null. */
export async function sendLaunchPicture(ticker: string, image: string | null): Promise<string | null> {
  if (image === null) return null;
  try {
    await api.setCompanyPicture(ticker, image, newRequestId());
    return null;
  } catch (e) {
    return problemText(e);
  }
}
